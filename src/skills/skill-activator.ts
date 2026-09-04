import { SkillManifest, SkillActivationDecision } from './types.js';
import { SkillRegistry } from './skill-registry.js';
import { Session } from '../session/session.js';
import { CapabilityCatalog } from '../capabilities/capability-catalog.js';
import { detectExplicitGitMutationIntent } from '../tools/git-intent.js';
import { detectExplicitGitCommandNames } from '../tools/git-command-policy.js';
import { detectGameProgrammingIntent, type GameProgrammingIntentResult } from './game-intent.js';

export { detectGameProgrammingIntent, type GameProgrammingIntentResult };

export interface ActivationContext {
  session: Session;
  userRequest?: string;
  intent?: string;
  availableCapabilities?: string[];
  manualOverrides?: {
    enabled?: string[];
    disabled?: string[];
  };
}

export interface ActivationResult {
  activeSkills: SkillManifest[];
  decisions: SkillActivationDecision[];
  promptSections: { name: string; content: string; priority: number }[];
}

/**
 * Nhận diện phân loại ý định lập kế hoạch cho tác vụ lớn / phức tạp (Planning Intent Classification)
 */
export function detectPlanningIntent(userRequest?: string): { isPlanning: boolean; isLargeTask: boolean; reason?: string } {
  if (!userRequest || typeof userRequest !== 'string') {
    return { isPlanning: false, isLargeTask: false };
  }

  const lower = userRequest.toLowerCase().trim();

  // 1. Kiểm tra slash command /plan
  if (lower.startsWith('/plan') || lower.includes('/plan ')) {
    return { isPlanning: true, isLargeTask: true, reason: 'Slash command /plan invoked' };
  }

  // 2. Nhóm từ khóa lập kế hoạch tiếng Việt
  const vnPlanningKeywords = [
    'lập kế hoạch', 'lên kế hoạch', 'vạch kế hoạch', 'phác thảo kế hoạch',
    'kế hoạch triển khai', 'kế hoạch thực hiện', 'kế hoạch chi tiết',
    'phân rã task', 'phân rã tác vụ', 'phân rã công việc', 'chia nhỏ task',
    'chia nhỏ công việc', 'lộ trình phát triển', 'lộ trình triển khai',
    'chiến lược triển khai', 'quy trình từng bước', 'các bước triển khai',
    'hướng giải quyết cho tác vụ', 'lập roadmap', 'vẽ roadmap', 'plan triển khai'
  ];

  // 3. Nhóm từ khóa lập kế hoạch tiếng Anh
  const enPlanningKeywords = [
    'write a plan', 'create a plan', 'make a plan', 'generate a plan',
    'implementation plan', 'execution plan', 'action plan', 'step-by-step plan',
    'task breakdown', 'decompose the task', 'decompose this', 'break down the task',
    'break down into steps', 'planning', 'roadmap', 'architectural plan',
    'migration plan', 'refactor plan', 'structured plan'
  ];

  // 4. Nhóm từ khóa chỉ quy mô lớn (Large Task / Complex Scope)
  const largeTaskKeywords = [
    'tác vụ lớn', 'dự án lớn', 'tính năng lớn', 'hệ thống lớn', 'refactor lớn',
    'tái cấu trúc lớn', 'toàn bộ dự án', 'full-stack', 'toàn diện', 'phức tạp',
    'quy mô lớn', 'nhiều bước', 'nhiều module', 'nhiều file', 'epic',
    'large task', 'complex task', 'major feature', 'large-scale', 'monorepo',
    'multi-step', 'multi-module', 'end-to-end', 'full refactor', 'system overhaul'
  ];

  const hasVnPlanning = vnPlanningKeywords.some((kw) => lower.includes(kw));
  const hasEnPlanning = enPlanningKeywords.some((kw) => lower.includes(kw));
  const hasLargeTask = largeTaskKeywords.some((kw) => lower.includes(kw));

  // Kiểm tra nếu có từ "kế hoạch" hoặc "plan" đi kèm ngữ cảnh thực thi/xây dựng
  const hasGeneralPlanWord = /\b(kế hoạch|plan|planning|roadmap)\b/i.test(lower);
  const hasActionContext = /\b(làm|xây dựng|triển khai|viết|tạo|phát triển|refactor|build|implement|develop|create|execute)\b/i.test(lower);

  const isPlanning = hasVnPlanning || hasEnPlanning || (hasGeneralPlanWord && (hasActionContext || hasLargeTask));

  return {
    isPlanning,
    isLargeTask: hasLargeTask || isPlanning,
    reason: isPlanning ? (hasLargeTask ? 'Explicit large-task planning request' : 'Planning request detected') : undefined,
  };
}

export class SkillActivator {
  private registry: SkillRegistry;
  private capabilityCatalog?: CapabilityCatalog;

  constructor(registry: SkillRegistry, capabilityCatalog?: CapabilityCatalog) {
    this.registry = registry;
    this.capabilityCatalog = capabilityCatalog;
  }

  setCapabilityCatalog(catalog: CapabilityCatalog): void {
    this.capabilityCatalog = catalog;
  }

  /**
   * Kích hoạt xác định (Deterministic Activation) các kỹ năng phù hợp
   */
  evaluate(context: ActivationContext): ActivationResult {
    const timestamp = new Date().toISOString();
    const allSkills = this.registry.list();
    const decisions: SkillActivationDecision[] = [];
    const candidateSkills: SkillManifest[] = [];

    // 1. Phân loại candidates dựa trên autoActivate, manualOverrides, hoặc bối cảnh
    for (const skill of allSkills) {
      if (context.manualOverrides?.disabled?.includes(skill.id)) {
        decisions.push({
          skillId: skill.id,
          version: skill.version,
          decision: 'disabled',
          reason: 'Explicitly disabled by operator override',
          timestamp,
          contentHash: skill.contentHash,
        });
        continue;
      }

      const explicitlyEnabled = context.manualOverrides?.enabled?.includes(skill.id);
      const isAutoActivate = skill.autoActivate === true;

      // Cơ chế Intent-Gated đặc biệt: game-development và unity-ai-game-creator CHỈ được nạp khi có yêu cầu lập trình game
      const isGatedGameSkill = skill.id === 'game-development' || skill.id === 'unity-ai-game-creator';
      if (isGatedGameSkill) {
        let gameMatch = false;
        if (context.userRequest) {
          const gameIntent = detectGameProgrammingIntent(context.userRequest);
          if (gameIntent.isGameProgramming) {
            gameMatch = true;
          }
        }
        if (explicitlyEnabled || gameMatch) {
          candidateSkills.push(skill);
        }
        continue;
      }

      // Khớp phân loại ngữ cảnh từ userRequest (Classification)
      let matchesContext = false;
      if (context.userRequest) {
        const lowerReq = context.userRequest.toLowerCase();
        const gitIntent = detectExplicitGitMutationIntent(context.userRequest);
        const gitCommands = detectExplicitGitCommandNames(context.userRequest);
        const planningIntent = detectPlanningIntent(context.userRequest);

        const isPlanningSkill = ['writing-plans', 'planning-with-files', 'concise-planning', 'brainstorming'].includes(skill.id);

        matchesContext =
          (isPlanningSkill && planningIntent.isPlanning) ||
          lowerReq.includes(skill.id.toLowerCase()) ||
          lowerReq.includes(skill.name.toLowerCase()) ||
          skill.tags?.some((t) => {
            const tagLower = t.toLowerCase();
            if (tagLower.length <= 3) {
              // Dùng word boundary cho các tag ngắn (db, api, ui, tdd, git, sql) tránh khớp nhầm substring
              const escaped = tagLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:[^a-zA-Z0-9_]|$)`, 'i').test(lowerReq);
            }
            return lowerReq.includes(tagLower);
          }) ||
          (skill.id === 'git-operations' && gitCommands.length > 0) ||
          (skill.id === 'finishing-a-development-branch' && (gitIntent.stage || gitIntent.commit || gitIntent.push)) ||
          false;
      }

      if (explicitlyEnabled || isAutoActivate || matchesContext) {
        candidateSkills.push(skill);
      }
    }

    // 2. Sắp xếp candidates theo Priority giảm dần (số nhỏ hơn = ưu tiên cao hơn)
    candidateSkills.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    // 3. Kiểm tra Capabilities và Conflicts
    const activeSkills: SkillManifest[] = [];
    const activeSkillIds = new Set<string>();

    for (const skill of candidateSkills) {
      // 3.1 Kiểm tra capability yêu cầu
      if (skill.requiredCapabilities && skill.requiredCapabilities.length > 0 && this.capabilityCatalog) {
        const missingCapabilities = skill.requiredCapabilities.filter(
          (cap) => !this.capabilityCatalog!.hasCapability(cap)
        );
        if (missingCapabilities.length > 0) {
          decisions.push({
            skillId: skill.id,
            version: skill.version,
            decision: 'incompatible',
            reason: `Missing required capabilities: ${missingCapabilities.join(', ')}`,
            timestamp,
            contentHash: skill.contentHash,
          });
          continue;
        }
      }

      // 3.2 Kiểm tra xung đột (Conflicts)
      if (skill.conflicts && skill.conflicts.length > 0) {
        const hasConflict = skill.conflicts.some((c) => activeSkillIds.has(c));
        if (hasConflict) {
          decisions.push({
            skillId: skill.id,
            version: skill.version,
            decision: 'rejected',
            reason: `Conflicts with higher priority active skill(s)`,
            timestamp,
            contentHash: skill.contentHash,
          });
          continue;
        }
      }

      // 3.3 Kiểm tra điều kiện phụ thuộc (Requires)
      if (skill.requires && skill.requires.length > 0) {
        const missingRequires = skill.requires.filter((reqId) => {
          if (activeSkillIds.has(reqId)) return false;
          // Thử kích hoạt dependency nếu có trong registry
          const dep = this.registry.get(reqId);
          if (dep && !activeSkillIds.has(dep.id)) {
            activeSkills.push(dep);
            activeSkillIds.add(dep.id);
            decisions.push({
              skillId: dep.id,
              version: dep.version,
              decision: 'activated',
              reason: `Auto-activated as requirement for ${skill.id}`,
              timestamp,
              contentHash: dep.contentHash,
            });
            return false;
          }
          return true;
        });

        if (missingRequires.length > 0) {
          decisions.push({
            skillId: skill.id,
            version: skill.version,
            decision: 'rejected',
            reason: `Missing prerequisite skill(s): ${missingRequires.join(', ')}`,
            timestamp,
            contentHash: skill.contentHash,
          });
          continue;
        }
      }

      activeSkills.push(skill);
      activeSkillIds.add(skill.id);
      decisions.push({
        skillId: skill.id,
        version: skill.version,
        decision: 'activated',
        reason: 'Passed all policy and dependency checks',
        timestamp,
        contentHash: skill.contentHash,
      });
    }

    // 4. Tạo Prompt Sections từ các skill được kích hoạt
    const promptSections: { name: string; content: string; priority: number }[] = [];
    for (const skill of activeSkills) {
      const rawContent = this.registry.loadContent(skill.id) || skill.description;
      promptSections.push({
        name: `SKILL: ${skill.name} (${skill.id})`,
        content: `[ACTIVATED SKILL: ${skill.name} v${skill.version}]\n${rawContent}\n`,
        priority: skill.priority ?? 100,
      });
    }

    return {
      activeSkills,
      decisions,
      promptSections,
    };
  }
}
