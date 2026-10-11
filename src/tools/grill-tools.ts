import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { GrillService } from '../agent/grill-service.js';

export function createGrillTools(service: GrillService): ToolDefinition[] {
  return [
    {
      name: 'ask_user',
      description: 'Ask the user to pick one option when the spec is ambiguous and at least two viable implementations exist. Opens an interactive modal with LLM-suggested options. Returns { picked } or { picked: null } when dismissed, capped, or headless — then proceed with best judgment.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING, description: 'One precise question naming the blocked decision.' },
          context: { type: Type.STRING, description: 'Background under 800 chars so suggestions stay grounded.' },
        },
        required: ['question'],
      },
      execute: async (args, _workspace, context) => {
        const question = String(args.question || '').trim();
        if (!question) return { error: 'question must not be empty.', errorCode: 'ASK_USER_EMPTY' };
        const background = String(args.context || '').slice(0, 800);
        const outcome = await service.ask(
          question,
          { sessionId: context?.sessionId, recentTranscript: background ? [background] : [] },
          context?.sessionId,
          context?.turn,
          context?.signal,
        );
        if (outcome.capped) return { success: true, picked: null, capped: true, message: 'Question budget for this turn is spent. Proceed with best judgment and note the assumption.' };
        if (outcome.headless || outcome.picked === null) return { success: true, picked: null, unavailable: true, message: 'No interactive user available (or the question was dismissed). Proceed with best judgment and note the assumption.' };
        return { success: true, picked: outcome.picked };
      },
    },
  ];
}
