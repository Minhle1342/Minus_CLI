import { Type } from '@google/genai';
import type { CitationValidatedRepositoryMemory } from '../memory/repository-memory.js';
import type { RepositoryCitation } from '../memory/repository-memory-types.js';
import type { ToolDefinition } from './types.js';

const citationSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ['file', 'session-event', 'commit', 'compose'] },
    path: { type: Type.STRING },
    contentHash: { type: Type.STRING },
    lineStart: { type: Type.NUMBER },
    lineEnd: { type: Type.NUMBER },
    sessionId: { type: Type.STRING },
    eventSeq: { type: Type.NUMBER },
    eventId: { type: Type.STRING },
    eventType: { type: Type.STRING },
    toolName: { type: Type.STRING },
    outcome: { type: Type.STRING, enum: ['success', 'failure'] },
    commit: { type: Type.STRING },
    composeId: { type: Type.STRING },
    specHash: { type: Type.STRING },
  },
  required: ['kind'],
};

export function createSaveRepositoryMemoryTool(memory: CitationValidatedRepositoryMemory): ToolDefinition {
  return {
    name: 'save_repository_memory',
    description: 'Persist a repository fact only when backed by verifiable file, durable session-event, commit, or Compose citations. Invalid citations are rejected.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        statement: { type: Type.STRING, description: 'Stable repository fact to remember.' },
        category: { type: Type.STRING, enum: ['convention', 'architecture', 'gotcha', 'rule', 'insight', 'episodic'] },
        confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
        concepts: { type: Type.ARRAY, items: { type: Type.STRING } },
        relatedFiles: { type: Type.ARRAY, items: { type: Type.STRING } },
        citations: { type: Type.ARRAY, items: citationSchema },
      },
      required: ['statement', 'citations'],
    },
    async execute(args) {
      try {
        const saved = await memory.remember({
          statement: String(args.statement || ''),
          category: args.category,
          confidence: args.confidence === undefined ? undefined : Number(args.confidence),
          concepts: Array.isArray(args.concepts) ? args.concepts.map(String) : undefined,
          relatedFiles: Array.isArray(args.relatedFiles) ? args.relatedFiles.map(String) : undefined,
          citations: Array.isArray(args.citations) ? args.citations as RepositoryCitation[] : [],
          source: 'manual',
        });
        return { success: true, saved };
      } catch (error: any) {
        return { error: error?.message || String(error), errorCode: 'INVALID_REPOSITORY_MEMORY_CITATION' };
      }
    },
  };
}

export function createRecallRepositoryMemoryTool(memory: CitationValidatedRepositoryMemory): ToolDefinition {
  return {
    name: 'recall_repository_memory',
    description: 'Retrieve repository memory after revalidating every citation against the current workspace and durable event logs. Stale facts are excluded by default.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING },
        limit: { type: Type.NUMBER, minimum: 1, maximum: 100 },
        includeStale: { type: Type.BOOLEAN },
      },
      required: ['query'],
    },
    async execute(args) {
      return memory.recall(String(args.query || ''), {
        limit: Number(args.limit) || 12,
        includeStale: args.includeStale === true,
      });
    },
  };
}

export function createVerifyRepositoryMemoryTool(memory: CitationValidatedRepositoryMemory): ToolDefinition {
  return {
    name: 'verify_repository_memory',
    description: 'Audit one repository-memory record and report the validity of each immutable citation.',
    parameters: {
      type: Type.OBJECT,
      properties: { id: { type: Type.STRING } },
      required: ['id'],
    },
    async execute(args) {
      return memory.verify(String(args.id || ''));
    },
  };
}
