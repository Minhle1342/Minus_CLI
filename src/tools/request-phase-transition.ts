import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';

/** A model-facing request; AgentLoop is the only phase authority. */
export const requestPhaseTransitionTool: ToolDefinition = {
  name: 'request_phase_transition',
  description: 'Request a workflow phase change with concrete evidence. The Harness accepts or rejects this request and is the only component that grants tool permissions.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetPhase: {
        type: Type.STRING,
        enum: ['plan', 'implement'],
        description: 'Requested next phase.',
      },
      rationale: {
        type: Type.STRING,
        description: 'Why the requested phase is appropriate now.',
      },
      evidenceRefs: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Observed tool-result, file, symbol, test-output, or plan-task references.',
      },
    },
    required: ['targetPhase', 'rationale', 'evidenceRefs'],
  },
  async execute(): Promise<Record<string, any>> {
    return {
      success: false,
      errorCode: 'PHASE_TRANSITION_MUST_BE_EVALUATED_BY_HARNESS',
      error: 'request_phase_transition is evaluated by AgentLoop and cannot be executed directly.',
    };
  },
};
