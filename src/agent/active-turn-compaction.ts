import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type { MaskedObservationRecord, TurnWindowEntry } from './context-compactor.js';
import { computeRequestValueDigest } from '../session/session-invariants.js';

export interface ActiveTextReplacement {
  beforeDigest: string;
  afterDigest: string;
  turn: number;
}

const MARKER = '[ACTIVE ASSISTANT TEXT COMPACTED';

/** Extractive reduction, never a new model-generated claim or approval. */
function reduceDraft(text: string, archiveId: string): string | undefined {
  if (text.length < 12000 || text.includes(MARKER) || /```|~~~|\*\*\* (?:Begin Patch|Update File)/.test(text)) return undefined;
  const lines = text.split(/\r?\n/);
  // Keywords cannot identify every decision or constraint. Only collapse
  // adjacent exact duplicates: global dedup can detach repeated headings from
  // their requirements or reorder decision reversals. Keep all other lines.
  const retained = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
  const summary = [
    `${MARKER}: archiveId=${archiveId}]`,
    'Historical assistant draft excerpts, not user approval or observed tool evidence. The complete original remains in the session event log; the archive may contain a capped preview.',
    'Opening excerpt:', text.slice(0, 600),
    'Draft lines (verbatim, original order; consecutive identical lines collapsed):', ...retained,
    'Latest excerpt:', text.slice(-1200),
  ].join('\n');
  return summary.length < text.length * 0.7 ? summary : undefined;
}

/** Only event-attributed assistant prose in the open turn is eligible. */
export function compactActiveTurnText(history: Content[], entries: TurnWindowEntry[], openTurn?: number) {
  const archives: MaskedObservationRecord[] = [];
  const replacements: ActiveTextReplacement[] = [];
  const turnsByDigest = new Map<string, Set<number | undefined>>();
  for (const entry of entries) {
    const digest = computeRequestValueDigest(entry.message);
    const turns = turnsByDigest.get(digest) || new Set<number | undefined>();
    turns.add(entry.turn); turnsByDigest.set(digest, turns);
  }
  const messages = history.map(message => {
    const beforeDigest = computeRequestValueDigest(message);
    const turns = turnsByDigest.get(beforeDigest);
    if (openTurn === undefined || message.role !== 'model' || turns?.size !== 1 || !turns.has(openTurn)
      || message.parts?.some((part: any) => part.thoughtSignature || part.thought || part.inlineData || part.fileData)) return message;
    let changed = false;
    const parts = (message.parts || []).map((part, partIndex) => {
      if (typeof part.text !== 'string' || part.functionCall || part.functionResponse) return part;
      const payloadHash = createHash('sha256').update(part.text).digest('hex').slice(0, 16);
      const id = `assistant-draft-${openTurn}-${beforeDigest.slice(0, 16)}-${partIndex}-${payloadHash}`;
      const reduced = reduceDraft(part.text, id);
      if (!reduced) return part;
      archives.push({ id, toolName: 'assistant_draft', timestamp: new Date().toISOString(),
        originalPayload: { content: part.text, turn: openTurn, messageDigest: beforeDigest, partIndex },
        summary: reduced.slice(0, 400) });
      changed = true;
      return { ...part, text: reduced };
    });
    if (!changed) return message;
    const reducedMessage = { ...message, parts };
    replacements.push({ beforeDigest, afterDigest: computeRequestValueDigest(reducedMessage), turn: openTurn });
    return reducedMessage;
  });
  return { messages, archives, replacements };
}
