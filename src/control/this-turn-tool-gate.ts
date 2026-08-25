import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../tools/types.js';
import type { ClassificationDecision } from './classification-types.js';
import { ToolDescriptorRegistry } from './tool-descriptor-registry.js';

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

export class ThisTurnToolGate {
  constructor(private readonly descriptors = new ToolDescriptorRegistry()) {}

  decide(classification: ClassificationDecision, tools: ToolDefinition[]): ThisTurnToolDecision {
    const required = new Set(classification.requiredCapabilities);
    const allowed: ToolDefinition[] = [];
    const denied: string[] = [];
    const riskRank = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 } as const;
    for (const tool of tools) {
      const descriptor = this.descriptors.describe(tool);
      const capabilityMatch = descriptor.capabilities.some((capability) => required.has(capability));
      const phaseMatch = descriptor.phases.includes(classification.phase);
      const riskMatch = riskRank[classification.risk] >= riskRank[descriptor.minimumRisk]
        && (classification.risk !== 'R0' || !descriptor.mutates);
      if (capabilityMatch && phaseMatch && riskMatch) allowed.push(tool);
      else denied.push(tool.name);
    }
    const names = allowed.map((tool) => tool.name).sort();
    const allowedToolSetHash = hashAllowedToolSet(names);
    const before = tools.reduce((sum, tool) => sum + this.descriptors.describe(tool).schemaCost, 0);
    const after = allowed.reduce((sum, tool) => sum + this.descriptors.describe(tool).schemaCost, 0);
    const approvalToolNames = allowed
      .filter((tool) => this.descriptors.describe(tool).requiresApproval)
      .map((tool) => tool.name)
      .sort();
    const maxCallsByRisk = { R0: 8, R1: 6, R2: 5, R3: 4, R4: 2, R5: 1 } as const;
    return {
      id: `tools-${classification.id.slice(6)}-${allowedToolSetHash.slice(0, 12)}`,
      classificationId: classification.id,
      allowedToolNames: names,
      deniedToolNames: denied.sort(),
      allowedToolSetHash,
      schemaTokensBefore: before,
      schemaTokensAfter: after,
      approvalToolNames,
      maxToolCalls: maxCallsByRisk[classification.risk],
      reasonCodes: denied.length ? ['PHASE_CAPABILITY_REDUCTION'] : ['FULL_TOOLSET_REQUIRED'],
    };
  }
}
