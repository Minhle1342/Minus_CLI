import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionEvent } from '../session/session.js';
import type { DreamConfig, DreamCursor, DreamEvidence, DreamEvidenceKind, DreamScanResult } from './types.js';

const SECRET_KEY_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s,"'}]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KNOWN_TOKEN_PATTERN = /\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi;

export function redactDreamText(value: string): string {
  return value
    .replace(SECRET_KEY_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(KNOWN_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
}

export function containsLikelySecret(value: string): boolean {
  SECRET_KEY_PATTERN.lastIndex = 0;
  BEARER_PATTERN.lastIndex = 0;
  KNOWN_TOKEN_PATTERN.lastIndex = 0;
  return SECRET_KEY_PATTERN.test(value) || BEARER_PATTERN.test(value) || KNOWN_TOKEN_PATTERN.test(value);
}

function truncate(value: string, max = 900): string {
  const clean = redactDreamText(value).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)} …`;
}

function contentText(content: any): string {
  if (!content || !Array.isArray(content.parts)) return '';
  return content.parts
    .map((part: any) => typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function isFailure(result: Record<string, any>): boolean {
  return Boolean(result.error || result.errorCode || result.success === false
    || (typeof result.exitCode === 'number' && result.exitCode !== 0));
}

function safeResultSummary(result: Record<string, any>, omitPayload: boolean): string {
  const summary: Record<string, unknown> = {};
  for (const key of ['success', 'exitCode', 'errorCode', 'path', 'filePath', 'command', 'reason']) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  if (!omitPayload) {
    for (const key of ['error', 'stderr', 'stdout', 'content', 'summary']) {
      if (typeof result[key] === 'string') summary[key] = truncate(result[key], 500);
    }
  }
  return truncate(JSON.stringify(summary), 800);
}

function evidenceFromEvent(
  sessionId: string,
  event: SessionEvent,
  calls: Map<string, { toolName: string; args: Record<string, any> }>,
): DreamEvidence | undefined {
  let kind: DreamEvidenceKind | undefined;
  let text = '';
  let verified = false;

  if (event.type === 'user/message' && event.data.source === 'human') {
    kind = 'human';
    text = contentText(event.data.content);
  } else if (event.type === 'tool/call') {
    if (event.data.toolCallId && event.data.toolName) {
      calls.set(event.data.toolCallId, { toolName: event.data.toolName, args: event.data.args || {} });
    }
    return undefined;
  } else if (event.type === 'tool/result' && event.data.toolName) {
    const result = event.data.result || {};
    const failed = isFailure(result);
    const call = event.data.toolCallId ? calls.get(event.data.toolCallId) : undefined;
    const args = call?.args || {};
    const target = String(args.path || args.filePath || result.path || result.filePath || '');
    const omitPayload = /(^|[\\/])\.env(?:\.|$)|credential|secret/i.test(target);
    const callContext = {
      path: args.path || args.filePath,
      command: args.command,
      query: args.query,
    };
    kind = failed ? 'tool-failure' : 'tool-success';
    verified = !failed;
    text = `${event.data.toolName} ${truncate(JSON.stringify(callContext), 300)} => ${safeResultSummary(result, omitPayload)}`;
  } else if (event.type === 'plan/change' && event.data.plan) {
    kind = 'plan';
    text = event.data.plan.map((item) => `${item.status}: ${item.title}${item.notes ? ` (${item.notes})` : ''}`).join('; ');
  } else if (event.type === 'goal/change' && event.data.goal) {
    kind = 'goal';
    text = `${event.data.goal.phase}: ${event.data.goal.objective}${event.data.goal.blocker ? `; blocker=${event.data.goal.blocker}` : ''}`;
  } else if (event.type === 'memory/change' && event.data.memory) {
    kind = 'memory';
    text = `${event.data.memory.key}: ${event.data.memory.insight} [${event.data.memory.trustStatus}]`;
  } else if (event.type === 'audit/task-completion') {
    kind = 'audit';
    verified = true;
    text = truncate(JSON.stringify(event.data), 900);
  }

  text = truncate(text);
  if (!kind || !text) return undefined;
  return {
    id: `${sessionId}:${event.seq}`,
    sessionId,
    eventSeq: event.seq,
    createdAt: event.createdAt,
    kind,
    text,
    verified,
  };
}

/** Reads the durable JSONL event source without loading or mutating sessions. */
export class DreamTrajectoryReader {
  private sessionsDir: string;

  constructor(workspaceDir: string) {
    this.sessionsDir = path.join(path.resolve(workspaceDir), '.codingagent', 'sessions');
  }

  setWorkspace(workspaceDir: string): void {
    this.sessionsDir = path.join(path.resolve(workspaceDir), '.codingagent', 'sessions');
  }

  async scan(cursors: Record<string, DreamCursor>, config: DreamConfig): Promise<DreamScanResult> {
    const nextCursors = { ...cursors };
    const evidence: DreamEvidence[] = [];
    let scannedEvents = 0;
    let inputChars = 0;
    let truncated = false;

    let entries: Array<{ name: string; mtimeMs: number }> = [];
    try {
      const names = (await fs.readdir(this.sessionsDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
      entries = await Promise.all(names.map(async (entry) => ({
        name: entry.name,
        mtimeMs: (await fs.stat(path.join(this.sessionsDir, entry.name))).mtimeMs,
      })));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { evidence, nextCursors, scannedSessions: 0, scannedEvents, truncated };
      }
      throw error;
    }

    const selected = entries
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, config.maxSessions)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let scannedSessions = 0;
    outer: for (const entry of selected) {
      const raw = await fs.readFile(path.join(this.sessionsDir, entry.name), 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) continue;
      let header: any;
      try {
        header = JSON.parse(lines[0]);
      } catch {
        continue;
      }
      if (header?.kind !== 'session' || !header.id) continue;
      const sessionId = String(header.id);
      const cursor = cursors[sessionId]?.lastSeq || 0;
      const calls = new Map<string, { toolName: string; args: Record<string, any> }>();
      let touched = false;

      for (const line of lines.slice(1)) {
        let event: SessionEvent;
        try {
          event = JSON.parse(line) as SessionEvent;
        } catch {
          continue;
        }
        if (!Number.isFinite(event.seq) || event.seq <= cursor) continue;
        if (scannedEvents >= config.maxEvents) {
          truncated = true;
          break outer;
        }
        const item = evidenceFromEvent(sessionId, event, calls);
        const addedChars = item?.text.length || 0;
        if (inputChars + addedChars > config.maxInputChars) {
          truncated = true;
          break outer;
        }
        scannedEvents++;
        inputChars += addedChars;
        touched = true;
        nextCursors[sessionId] = { lastSeq: event.seq };
        if (item) evidence.push(item);
      }
      if (touched) scannedSessions++;
    }

    return { evidence, nextCursors, scannedSessions, scannedEvents, truncated };
  }
}
