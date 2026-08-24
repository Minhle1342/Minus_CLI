import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { ComposeController } from '../agent/compose-controller.js';

export function createComposeTools(controller: ComposeController): ToolDefinition[] {
  return [
    {
      name: 'generate_spec',
      description: 'Configure and generate the active Compose spec after the Grill contract is complete.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          affectedFiles: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Exact affected files or directory roots.' },
          tasks: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Atomic implementation tasks.' },
          tests: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                scenario: { type: Type.STRING }, command: { type: Type.STRING }, expectedExitCode: { type: Type.NUMBER }, expectedOutput: { type: Type.STRING },
              },
              required: ['scenario', 'command'],
            },
          },
        },
        required: ['affectedFiles', 'tests'],
      },
      execute: async (args, workspace) => {
        try {
          await controller.configureDraft({ registeredFiles: args.affectedFiles, implementationTasks: args.tasks, testMatrix: args.tests });
          const state = await controller.generateSpec(workspace);
          return { success: true, phase: state.phase, specPath: state.specPath, message: 'Compose spec draft generated.' };
        } catch (error: any) { return { error: error.message, errorCode: 'COMPOSE_SPEC_FAILED' }; }
      },
    },
    {
      name: 'lock_spec',
      description: 'Lock the active Compose spec using a durable SHA-256 integrity seal.',
      parameters: { type: Type.OBJECT, properties: {} },
      execute: async () => {
        try {
          const state = await controller.lockSpec();
          return { success: true, phase: state.phase, specHash: state.specHash, message: 'Compose spec locked.' };
        } catch (error: any) { return { error: error.message, errorCode: 'COMPOSE_LOCK_FAILED' }; }
      },
    },
    {
      name: 'compose_answer',
      description: 'Answer the next unanswered Grill question in the active Compose run.',
      parameters: { type: Type.OBJECT, properties: { answer: { type: Type.STRING } }, required: ['answer'] },
      execute: async (args) => {
        try {
          const state = await controller.answerGrill(String(args.answer));
          return { success: true, phase: state.phase, remaining: state.grillQnA.filter((item) => !item.answer).length };
        } catch (error: any) { return { error: error.message, errorCode: 'COMPOSE_GRILL_FAILED' }; }
      },
    },
    {
      name: 'compose_status',
      description: 'Read the durable phase, spec, worktree, blast radius, and acceptance state for Compose.',
      parameters: { type: Type.OBJECT, properties: {} },
      execute: async () => ({ active: controller.isActive(), state: controller.getState() || null, context: controller.renderExecutionContext() }),
    },
    {
      name: 'verify_spec_matrix',
      description: 'Evaluate whether every locked-spec acceptance command has fresh passing evidence after the last mutation.',
      parameters: { type: Type.OBJECT, properties: {} },
      execute: async () => {
        const decision = controller.acceptanceDecision();
        return { success: decision.allow, approved: decision.allow, reason: decision.reason || 'Acceptance matrix passed.' };
      },
    },
    {
      name: 'compose_advance',
      description: 'Advance the durable Compose state machine by one legal phase. Workspace switch actions are returned to the caller.',
      parameters: { type: Type.OBJECT, properties: { answer: { type: Type.STRING } } },
      execute: async (args, workspace) => {
        try { return { success: true, ...(await controller.advance(workspace, args.answer ? String(args.answer) : undefined)) }; }
        catch (error: any) { return { error: error.message, errorCode: 'COMPOSE_ADVANCE_FAILED' }; }
      },
    },
  ];
}
