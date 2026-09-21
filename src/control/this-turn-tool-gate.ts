import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../tools/types.js';
import type { ClassificationDecision, ControlRisk } from './classification-types.js';
import { ToolDescriptorRegistry, READ_TOOL_NAMES } from './tool-descriptor-registry.js';

export interface ThisTurnToolDecision {
  id: string;
  classificationId: string;
  allowedToolNames: string[];
  deniedToolNames: string[];
  allowedToolSetHash: string;
  schemaTokensBefore: number;
  schemaTokensAfter: number;
  approvalToolNames: string[];
  maxToolCalls: number;
  reasonCodes: string[];
}

export function hashAllowedToolSet(names: readonly string[]): string {
  return createHash('sha256').update([...new Set(names)].sort().join('\n')).digest('hex');
}

/**
 * Tính toán Ngân sách Tool Call thích ứng linh hoạt theo độ phức tạp, pha thực thi và mức rủi ro.
 * Đảm bảo các task khó (large complexity, deep exploration, multi-step verification) không bị bóp nghẹt ngân sách.
 */
export function calculateAdaptiveToolBudget(classification: ClassificationDecision): number {
  const envBudget = process.env.MINUS_TOOL_CALL_BUDGET || process.env.MINUS_MAX_TOOL_CALLS_PER_TURN;
  if (envBudget) {
    if (envBudget.toLowerCase() === 'unlimited' || envBudget.toLowerCase() === 'inf') {
      return 100;
    }
    const parsed = parseInt(envBudget, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // 1. Ngân sách nền tảng theo Risk (R0 - R5) với headroom rộng rãi hơn
  const baseByRisk: Record<ControlRisk, number> = {
    R0: 16,
    R1: 14,
    R2: 12,
    R3: 10,
    R4: 8,
    R5: 5,
  };

  let budget = baseByRisk[classification.risk] || 12;

  // 2. Thích ứng theo độ phức tạp tác vụ (Complexity Scaling)
  switch (classification.complexity) {
    case 'large':
      budget += 8; // Tác vụ hệ thống/kiến trúc lớn cần đọc nhiều file và thực thi nhiều bước
      break;
    case 'medium':
      budget += 4;
      break;
    case 'small':
      budget += 1;
      break;
    case 'trivial':
      break;
  }

  // 3. Thích ứng theo Phase (Phase Scaling)
  // Giai đoạn Khảo sát (explore) & Lập kế hoạch (plan) là thao tác đọc, tuyệt đối an toàn với codebase
  if (classification.phase === 'explore' || classification.phase === 'plan') {
    budget = Math.max(budget, 16);
    if (classification.complexity === 'large') {
      budget += 6;
    }
  } else if (classification.phase === 'verify') {
    // Giai đoạn Kiểm thử cần chạy nhiều test suites, phân tích chẩn đoán LSP và so sánh vi sai
    budget = Math.max(budget, 12);
  } else if (classification.phase === 'implement') {
    if (classification.complexity === 'large') {
      budget = Math.max(budget, 14);
    }
  }

  // 4. Thích ứng theo Reversibility
  if (classification.reversibility === 'read-only') {
    budget = Math.max(budget, 18);
  }

  // Khống chế trần an toàn để chống lặp vô hạn (clamp trong khoảng 5..36)
  return Math.min(Math.max(budget, 5), 36);
}

export class ThisTurnToolGate {
  constructor(private readonly descriptors = new ToolDescriptorRegistry()) {}

  decide(classification: ClassificationDecision, tools: ToolDefinition[]): ThisTurnToolDecision {
    const required = new Set(classification.requiredCapabilities);
    const allowed: ToolDefinition[] = [];
    const denied: string[] = [];
    const riskRank = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 } as const;

    for (const tool of tools) {
      const descriptor = this.descriptors.describe(tool);
      // Tool đọc an toàn luôn được phép ở mọi phase vì quan sát là quyền năng cốt lõi của Agent
      const isAlwaysAllowedRead = READ_TOOL_NAMES.has(tool.name) && !descriptor.mutates;
      const capabilityMatch = descriptor.capabilities.some((capability) => required.has(capability))
        || isAlwaysAllowedRead;
      const phaseMatch = descriptor.phases.includes(classification.phase) || isAlwaysAllowedRead;
      const riskMatch = riskRank[classification.risk] >= riskRank[descriptor.minimumRisk]
        && (classification.risk !== 'R0' || !descriptor.mutates);

      if (capabilityMatch && phaseMatch && riskMatch) {
        allowed.push(tool);
      } else {
        denied.push(tool.name);
      }
    }

    const names = allowed.map((tool) => tool.name).sort();
    const allowedToolSetHash = hashAllowedToolSet(names);
    const before = tools.reduce((sum, tool) => sum + this.descriptors.describe(tool).schemaCost, 0);
    const after = allowed.reduce((sum, tool) => sum + this.descriptors.describe(tool).schemaCost, 0);
    const approvalToolNames = allowed
      .filter((tool) => this.descriptors.describe(tool).requiresApproval)
      .map((tool) => tool.name)
      .sort();

    const maxToolCalls = calculateAdaptiveToolBudget(classification);

    return {
      id: `tools-${classification.id.slice(6)}-${allowedToolSetHash.slice(0, 12)}`,
      classificationId: classification.id,
      allowedToolNames: names,
      deniedToolNames: denied.sort(),
      allowedToolSetHash,
      schemaTokensBefore: before,
      schemaTokensAfter: after,
      approvalToolNames,
      maxToolCalls,
      reasonCodes: denied.length ? ['PHASE_CAPABILITY_REDUCTION'] : ['FULL_TOOLSET_REQUIRED'],
    };
  }
}
