import { Session, type SessionMessage } from '../session/session.js';

export const COMPACTION_SYSTEM_PROMPT = `You are an expert technical state summarizer for an advanced AI software engineering agent.
Your task is to analyze the conversation history and compress older dialogue turns into a comprehensive, high-density Technical State Snapshot.

CRITICAL GUIDELINES:
1. DO NOT aggressively compress or omit technical facts. Verbose, complete, and exhaustive technical detail is explicitly desired.
2. PRESERVE VERBATIM EVIDENCE:
   - Full CLI commands, tool executions, and their exit codes.
   - HTTP methods, URLs, status codes, response headers, and exact JSON payloads (e.g., curl outputs).
   - Error messages, exception traces, and specific error pages.
   - Exact absolute file paths and relevant line numbers/ranges.
3. STRUCTURE: You MUST format the output using EXACTLY the following 7 sections:

Objective
- Core goals of the task and what was requested.
- Background setup or prerequisite steps already taken.

Requirements
- Constraints, explicit instructions, and rules given by the user (e.g., "Do not edit code yet", "Investigate only", "Use specific tools").

Decisions
- Architectural choices, tools/MCP servers configured, debugging strategies chosen, or solutions agreed upon.

Work State
Completed
- Detailed list of completed investigations, code reads, environment analyses, and tests with concrete proof (status codes, log lines, findings).
Active
- The specific task currently in progress or waiting for user review.
Blocked
- Obstacles, lack of permissions, unreachable environments, or missing information preventing progress.

Next Move
- Numbered, actionable, prioritized immediate next steps.

Relevant Files
- Exact file paths examined or modified, with line numbers/ranges and short annotations explaining what was checked or found in each.

Important Context
- Environmental facts (OS, web server, runtime versions, IIS configurations, DB state).
- Tool/session state (e.g., open browser tabs, MCP connections).
- Key operational constraints and user reminders.`;

const MAX_COMPACTION_TRANSCRIPT_CHARS = 120_000;

/**
 * Serializes turn messages into a readable conversation transcript for the LLM to summarize.
 */
export function serializeMessagesForCompaction(messages: SessionMessage[]): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'model' || msg.role === 'assistant' ? 'ASSISTANT' : 'USER';
    const lines: string[] = [];
    for (const part of msg.parts || []) {
      if ((part as any).thought) {
        // Skip thought parts to keep prompt focused on observable actions and decisions
        continue;
      }
      if (part.text) {
        lines.push(`[${role}]: ${part.text.trim()}`);
      }
      if (part.functionCall) {
        const call = part.functionCall;
        const name = call.name || 'unknown_tool';
        const args = typeof call.args === 'object' ? JSON.stringify(call.args) : String(call.args ?? '');
        lines.push(`[TOOL CALL: ${name}]: args=${args}`);
      }
      if (part.functionResponse) {
        const resp = part.functionResponse;
        const name = resp.name || 'unknown_tool';
        const raw = (resp as any).response;
        let content = '';
        if (typeof raw === 'string') {
          content = raw;
        } else if (raw && typeof raw === 'object') {
          content = typeof raw.content === 'string' ? raw.content
            : typeof raw.output === 'string' ? raw.output
            : JSON.stringify(raw);
        } else {
          content = String(raw ?? '');
        }
        // Cap single tool output to 8000 characters to fit context comfortably
        if (content.length > 8000) {
          content = content.slice(0, 4000) + '\n... [truncated for compaction] ...\n' + content.slice(-4000);
        }
        lines.push(`[TOOL RESULT: ${name}]:\n${content.trim()}`);
      }
    }
    if (lines.length > 0) blocks.push(lines.join('\n\n'));
  }

  // Cap the whole transcript, not just each result: keep the newest turns (the
  // ones the preserved tail continues from) and drop the oldest wholesale.
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (used + blocks[i].length > MAX_COMPACTION_TRANSCRIPT_CHARS) break;
    kept.unshift(blocks[i]);
    used += blocks[i].length + 2;
  }
  if (kept.length === 0 && blocks.length > 0) {
    kept.push(`[... truncated ...]\n${blocks[blocks.length - 1].slice(-MAX_COMPACTION_TRANSCRIPT_CHARS)}`);
  }
  if (kept.length < blocks.length) {
    kept.unshift(`[... ${blocks.length - kept.length} older message(s) omitted to fit the compaction context ...]`);
  }
  return kept.join('\n\n');
}

export interface LLMCompactionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Invokes LLM to produce the 7-section technical state snapshot.
 */
export async function compactHistoryWithLLM(
  messagesToCompact: SessionMessage[],
  llm: any,
  options?: LLMCompactionOptions,
): Promise<string> {
  if (!llm || typeof llm.generate !== 'function') {
    throw new Error('Valid LLM client with generate() is required for LLM compaction');
  }

  const transcript = serializeMessagesForCompaction(messagesToCompact);
  if (!transcript.trim()) {
    throw new Error('No readable conversation history to compact');
  }

  const tempSession = new Session(`llm-compaction-temp-${Date.now()}`);
  tempSession.addUserMessage(
    `Below is the chronological conversation history of older turns to compact:\n\n${transcript}\n\n` +
    `Please generate the exhaustive 7-section Technical State Snapshot following the system prompt rules.`,
  );

  const timeoutMs = options?.timeoutMs ?? 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const sig = options?.signal ?? controller.signal;
  let rejectOnAbort: (err: Error) => void = () => {};
  const abortPromise = new Promise<never>((_, reject) => { rejectOnAbort = reject; });
  const onAbort = () => rejectOnAbort(new Error('LLM compaction request timed out or was aborted'));
  sig.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await Promise.race([
      llm.generate(tempSession, [], {
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        signal: sig,
        functionCallingMode: 'NONE',
      }),
      abortPromise,
    ]);

    const text = response?.text || '';
    if (!text.trim()) {
      throw new Error('LLM returned empty compaction output');
    }

    return text.trim();
  } finally {
    clearTimeout(timeoutId);
    sig.removeEventListener('abort', onAbort);
  }
}
