import { SkillManifest, SkillActivationDecision } from './types.js';
import { SkillRegistry } from './skill-registry.js';
import { Session } from '../session/session.js';
import { CapabilityCatalog } from '../capabilities/capability-catalog.js';

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

      // Khớp từ khóa yêu cầu từ userRequest
      let matchesContext = false;
      if (context.userRequest) {
        const lowerReq = context.userRequest.toLowerCase();
        matchesContext =
          skill.id.includes(lowerReq) ||
          skill.name.toLowerCase().includes(lowerReq) ||
          skill.tags?.some((t) => lowerReq.includes(t.toLowerCase())) ||
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
