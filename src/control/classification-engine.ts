import { createHash } from 'node:crypto';
import type { ClassificationDecision, Capability, ControlRisk, TaskClass, TaskComplexity, TaskPhase } from './classification-types.js';

export interface ClassificationInput {
  request: string;
  activeTask?: string;
  activeAcceptance?: string;
  hasPlan?: boolean;
  hasUnverifiedChanges?: boolean;
  lastToolName?: string;
  lastToolFailed?: boolean;
  previous?: ClassificationDecision;
}

const mutationIntent = /\b(?:implement|fix|change|modify|update|create|delete|rename|refactor|migrate|upgrade|add|remove|write|patch|sửa|triển khai|thực hiện|cập nhật|tạo|xóa|đổi tên|tích hợp)\b/i;
const bugIntent = /\b(?:bug|error|fail|broken|debug|diagnos|root cause|lỗi|hỏng|không hoạt động|nguyên nhân)\b/i;
const refactorIntent = /\b(?:refactor|rename|extract|split|move|restructure|tái cấu trúc)\b/i;
const releaseIntent = /\b(?:deploy|publish|release|push|production|phát hành|triển khai production)\b/i;
const verifyIntent = /\b(?:test|verify|verification|build|lint|typecheck|kiểm thử|xác minh|đối chiếu)\b/i;
const exploreIntent = /\b(?:explain|inspect|investigate|review|analy[sz]e|how|why|what|kiểm tra|phân tích|đánh giá|giải thích|tìm hiểu)\b/i;

export class ClassificationEngine {
  classify(input: ClassificationInput): ClassificationDecision {
    const text = [input.request, input.activeTask, input.activeAcceptance].filter(Boolean).join(' ').trim();
    const reasons: string[] = [];
    let taskClass: TaskClass = 'question';
    let phase: TaskPhase = 'explore';
    let complexity: TaskComplexity = 'small';
    let risk: ControlRisk = 'R0';
    let capabilities: Capability[] = ['inspect', 'search', 'memory'];

    if (releaseIntent.test(text)) {
      taskClass = 'release'; phase = 'release'; complexity = 'large'; risk = 'R4';
      capabilities = ['inspect', 'execute', 'verify', 'git-read', 'git-write', 'network', 'complete'];
      reasons.push('RELEASE_OR_EXTERNAL_MUTATION');
    } else if (
      input.hasUnverifiedChanges
      || (input.previous?.phase === 'implement' && verifyIntent.test(text))
      || (input.previous?.phase === 'verify' && input.lastToolName === 'run_command' && !input.lastToolFailed)
    ) {
      taskClass = input.previous?.taskClass || 'feature'; phase = 'verify'; risk = input.previous?.risk || 'R2';
      complexity = input.previous?.complexity || 'medium';
      capabilities = ['inspect', 'execute', 'verify', 'git-read', 'complete'];
      reasons.push(input.hasUnverifiedChanges ? 'UNVERIFIED_MUTATION_EXISTS' : 'VERIFICATION_PHASE_STICKY_UNTIL_COMPLETION');
    } else if (mutationIntent.test(text)) {
      taskClass = refactorIntent.test(text) ? 'refactor' : bugIntent.test(text) ? 'bugfix' : 'feature';
      complexity = /\b(?:architecture|system|migration|multiple|all|kiến trúc|hệ thống|lộ trình|toàn bộ)\b/i.test(text) ? 'large' : 'medium';
      risk = complexity === 'large' ? 'R3' : 'R2';
      phase = input.hasPlan || complexity !== 'large' ? 'implement' : 'plan';
      capabilities = ['inspect', 'search', 'plan', 'memory', 'edit', 'execute', 'verify', 'git-read', 'complete'];
      reasons.push(refactorIntent.test(text) ? 'REFACTOR_INTENT' : 'WORKSPACE_MUTATION_INTENT');
    } else if (bugIntent.test(text)) {
      taskClass = 'bugfix'; phase = 'explore'; complexity = 'medium'; risk = 'R1';
      capabilities = ['inspect', 'search', 'execute', 'verify', 'memory'];
      reasons.push('BUG_REQUIRES_DIAGNOSIS');
    } else if (verifyIntent.test(text)) {
      taskClass = 'exploration'; phase = 'verify'; complexity = 'small'; risk = 'R1';
      capabilities = ['inspect', 'execute', 'verify', 'git-read'];
      reasons.push('VERIFICATION_INTENT');
    } else if (exploreIntent.test(text)) {
      taskClass = 'exploration';
      reasons.push('READ_ONLY_EXPLORATION');
    } else {
      reasons.push('CONSERVATIVE_READ_ONLY_DEFAULT');
    }

    const needsNetwork = /\b(?:web|internet|online|latest|documentation|docs|website|trực tuyến|mới nhất)\b/i.test(text);
    if (needsNetwork && !capabilities.includes('network')) {
      capabilities.push('network');
      if (risk === 'R0') risk = 'R1';
      reasons.push('NETWORK_INFORMATION_REQUIRED');
    }
    if (complexity === 'large' && !capabilities.includes('delegate')) {
      capabilities.push('delegate');
      reasons.push('PARALLEL_DELEGATION_ELIGIBLE');
    }

    if (input.lastToolFailed && input.previous && input.previous.phase !== 'release') {
      phase = 'explore';
      capabilities = Array.from(new Set<Capability>(['inspect', 'search', 'memory', ...(risk === 'R0' ? [] : ['execute' as Capability])]));
      reasons.push('FAILED_ACTION_RECLASSIFY_TO_EXPLORE');
    }

    const confidence = text.length < 8 ? 0.55 : reasons.includes('CONSERVATIVE_READ_ONLY_DEFAULT') ? 0.65 : 0.9;
    const stable = JSON.stringify({ taskClass, phase, complexity, risk, capabilities, text: text.toLowerCase() });
    return {
      id: `class-${createHash('sha256').update(stable).digest('hex').slice(0, 16)}`,
      version: 1,
      taskClass,
      phase,
      complexity,
      externality: taskClass === 'release' ? 'external-state' : needsNetwork ? 'network' : 'local',
      reversibility: risk === 'R0' ? 'read-only' : risk >= 'R4' ? 'hard-to-reverse' : 'reversible',
      risk,
      requiredCapabilities: capabilities,
      confidence,
      fastPath: complexity === 'trivial' || (risk === 'R0' && !input.hasPlan),
      reasonCodes: reasons,
      createdAt: new Date().toISOString(),
    };
  }
}
