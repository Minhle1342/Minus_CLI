import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { GrillService } from '../agent/grill-service.js';

export function createGrillTools(service: GrillService): ToolDefinition[] {
  const executeHandler = async (args: any, _workspace: any, context: any) => {
    const question = String(args.question || '').trim();
    if (!question) return { error: 'question must not be empty.', errorCode: 'ASK_USER_EMPTY' };
    const background = String(args.context || '').slice(0, 800);
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const outcome = await service.ask(
      question,
      {
        sessionId: context?.sessionId,
        recentTranscript: background ? [background] : [],
        ...(rawOptions.length > 0 ? { providedOptions: rawOptions } : {}),
      },
      context?.sessionId,
      context?.turn,
      context?.signal,
    );
    if (outcome.capped) {
      return {
        success: true,
        picked: null,
        capped: true,
        message: 'Question budget for this turn is spent. Proceed with best judgment and note the assumption.',
      };
    }
    if (outcome.headless || outcome.picked === null) {
      return {
        success: true,
        picked: null,
        unavailable: true,
        message: 'No interactive user available (or the question was dismissed). Proceed with best judgment and note the assumption.',
      };
    }
    return { success: true, picked: outcome.picked };
  };

  const toolParameters = {
    type: Type.OBJECT,
    properties: {
      question: { type: Type.STRING, description: 'One precise question naming the blocked decision or choice to elicit.' },
      options: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional list of 2-5 structured options for the user to choose from (MCP Elicitation / V2 Form). If omitted, options will be auto-suggested.',
      },
      context: { type: Type.STRING, description: 'Background under 800 chars so suggestions stay grounded.' },
    },
    required: ['question'],
  };

  return [
    {
      name: 'ask_user',
      description: 'Ask the user to pick one option when the spec is ambiguous or confirmation is needed (MCP Elicitation & V2 Form). Opens the interactive Grill modal with options. Returns { picked } or { picked: null } when dismissed, capped, or headless — then proceed with best judgment.',
      parameters: toolParameters,
      execute: executeHandler,
    },
    {
      name: 'ask_question',
      description: 'Standard MCP Elicitation & V2 Form tool: Ask the user a question with structured options. Opens the interactive Grill modal for single-click selection. Returns { picked } or { picked: null } if dismissed.',
      parameters: toolParameters,
      execute: executeHandler,
    },
  ];
}
