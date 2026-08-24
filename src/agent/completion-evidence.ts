import type { Session, SessionEvent } from '../session/session.js';

export type EvidenceKind = 'inspection' | 'mutation' | 'verification' | 'git' | 'external' | 'other';

const MUTATION_TOOLS = new Set([
  'write_file',
  'create_file',
  'replace_text',
  'apply_patch',
  'delete_file',
  'move_file',
]);

const INSPECTION_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_text',
  'search_codebase_fast',
  'read_compressed_code',
  'pack_codebase',
  'git_status',
  'git_diff',
  'read_memory',
  'get_task_output',
  'inspect_symbol',
  'find_references',
  'get_diagnostics',
  'get_workspace_diff',
  'analyze_impact',
]);

const GIT_TOOLS = new Set(['git_add', 'git_commit', 'git_push', 'git_command']);
const VERIFICATION_COMMAND_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check|verify))\b|\b(?:pytest|py\.test|cargo\s+test|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\s+(?:test|check)|tsc(?:\s|$)|make\s+(?:test|check))\b/i;

export function isToolResultFailure(result: Record<string, any>): boolean {
  return Boolean(
    result.error
    || result.errorCode
    || result.success === false
    || (typeof result.exitCode === 'number' && result.exitCode !== 0),
  );
}

export function isVerificationCommand(command: unknown): boolean {
  return typeof command === 'string' && VERIFICATION_COMMAND_PATTERN.test(command.trim());
}

export function classifyToolEvidence(
  toolName: string,
  args: Record<string, any> = {},
  result: Record<string, any> = {},
): EvidenceKind[] {
  if (isToolResultFailure(result)) return [];
  if (MUTATION_TOOLS.has(toolName)) return ['mutation'];
  if (toolName === 'run_command') {
    return isVerificationCommand(args.command ?? result.command) ? ['verification'] : ['other'];
  }
  if (toolName === 'git_status' || toolName === 'git_diff' || toolName === 'get_workspace_diff') {
    return ['inspection', 'git'];
  }
  if (toolName === 'git_command') {
    const sub = String(args.subcommand || result.subcommand || '').trim().toLowerCase();
    if (['log', 'status', 'diff', 'show', 'branch', 'tag', 'rev-parse', 'ls-files', 'cat-file'].includes(sub)) {
      return ['inspection', 'git'];
    }
    return ['git'];
  }
  if (GIT_TOOLS.has(toolName)) return ['git'];
  if (toolName === 'web_search' || toolName === 'web_fetch') return ['external', 'inspection'];
  if (INSPECTION_TOOLS.has(toolName)) return ['inspection'];
  return ['other'];
}

export interface CompletionEvidenceDecision {
  allow: boolean;
  reasons: string[];
  continuationPrompt?: string;
}

interface ObservedExecution {
  call: SessionEvent;
  result: SessionEvent;
  toolName: string;
  args: Record<string, any>;
  payload: Record<string, any>;
  kinds: EvidenceKind[];
}

export interface CompletionEvidenceOptions {
  turn?: number;
  codeChangeRequired?: boolean;
  userRequest?: string;
  expectedWorkspaceDigest?: string;
  expectedDiffHash?: string;
}

function stripQuotedAndToolOutputs(answer: string, toolOutputs: string[] = []): string {
  // Strip code blocks and inline code
  let cleaned = answer.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/`[^`]+`/g, ' ');
  // Strip blockquotes
  cleaned = cleaned.replace(/^>.*$/gm, ' ');

  // Strip exact output lines or substrings from tool payloads
  for (const output of toolOutputs) {
    if (typeof output !== 'string' || output.length < 6) continue;
    for (const line of output.split('\n')) {
      const trimmedLine = line.trim();
      if (trimmedLine.length >= 8 && cleaned.includes(trimmedLine)) {
        cleaned = cleaned.split(trimmedLine).join(' ');
      }
    }
  }
  return cleaned;
}

/**
 * Cross-checks completion claims against durable tool observations (Codex CLI Standard).
 * Cung cấp thông tin telemetry và phân loại bằng chứng mà không tạo ra các chốt chặn nhân tạo.
 */
export class CompletionEvidenceGate {
  evaluate(
    answer: string,
    session: Session,
    options: CompletionEvidenceOptions = {},
  ): CompletionEvidenceDecision {
    const executions = this.executionsForTurn(session, options.turn);
    const successful = executions.filter((item) => !isToolResultFailure(item.payload));
    const failures = executions.filter((item) => isToolResultFailure(item.payload));
    const mutations = successful.filter((item) => item.kinds.includes('mutation'));
    const latestMutationSeq = mutations.at(-1)?.result.seq ?? -1;
    const verifications = successful.filter(
      (item) => item.kinds.includes('verification') && item.result.seq > latestMutationSeq,
    );

    const reasons: string[] = [];

    if (options.codeChangeRequired && mutations.length === 0) {
      reasons.push('The request requires a code change, but no successful mutation result exists in this turn.');
    }
    if ((options.codeChangeRequired || mutations.length > 0) && verifications.length === 0) {
      reasons.push('No successful test/build/lint/typecheck command was observed after the latest code modification.');
    }

    // Collect string fragments from executed tool results so quotes/summaries of logs are not misclassified as new claims
    const toolOutputs: string[] = [];
    for (const item of executions) {
      const p = item.payload;
      if (typeof p.stdout === 'string') toolOutputs.push(p.stdout);
      if (typeof p.stderr === 'string') toolOutputs.push(p.stderr);
      if (typeof p.content === 'string') toolOutputs.push(p.content);
      if (typeof p.error === 'string') toolOutputs.push(p.error);
    }

    const proseToScan = stripQuotedAndToolOutputs(answer, toolOutputs);
    const normalized = proseToScan.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    const claimsVerification = /\b(?:test|tests|build|lint|typecheck|verification|kiem thu|kiem chung|bien dich)\b.{0,80}\b(?:pass|passed|success|successful|green|ok|thanh cong)\b/.test(normalized);
    if (claimsVerification && verifications.length === 0) {
      reasons.push('The final answer claims successful verification without matching run_command evidence.');
    }

    // First-person or explicit assertion of completed workspace modification by the agent
    const isFirstPersonMutationClaim =
      /\b(?:i\s+(?:have\s+)?(?:implemented|fixed|modified|changed|created|updated|written|wrote)|toi\s+da\s+(?:sua|sua\s+xong|trien\s+khai|cap\s+nhat|tao\s+file|viet))\b/.test(normalized)
      || (/\b(?:implemented|fixed|da\s+sua\s+xong|da\s+trien\s+khai\s+xong)\b/.test(normalized) && !/\b(?:commit|log|lich\s+su|history)\b/.test(normalized));

    if (isFirstPersonMutationClaim && mutations.length === 0) {
      reasons.push('The final answer claims workspace changes without a successful mutation tool result.');
    }

    const claimsCommit = /\b(?:i\s+(?:have\s+)?committed|da\s+tao\s+commit(?:\s+moi|\s+thanh\s+cong)?|da\s+commit\s+thanh\s+cong)\b/.test(normalized);
    if (claimsCommit && !successful.some((item) => item.toolName === 'git_commit')) {
      reasons.push('The final answer claims a commit without a successful git_commit result.');
    }
    const claimsPush = /\b(?:i\s+(?:have\s+)?pushed|da\s+push\s+(?:code|thanh\s+cong|len\s+repo))\b/.test(normalized);
    if (claimsPush && !successful.some((item) => item.toolName === 'git_push')) {
      reasons.push('The final answer claims a push without a successful git_push result.');
    }

    const claimsBlocker = /\b(?:blocked|cannot|unable|khong the|bi chan|that bai)\b/.test(normalized);
    if (executions.length > 0 && claimsBlocker) {
      const blockerChecks: Array<{ claimed: boolean; supported: boolean; label: string }> = [
        {
          claimed: /\b(?:test|tests|build|lint|typecheck|verification|kiem thu|bien dich)\b/.test(normalized),
          supported: failures.some((item) => item.toolName === 'run_command' && isVerificationCommand(item.args.command)),
          label: 'verification',
        },
        {
          claimed: /\bpush(?:ed)?\b/.test(normalized),
          supported: failures.some((item) => item.toolName === 'git_push'),
          label: 'push',
        },
        {
          claimed: /\bcommit(?:ted)?\b/.test(normalized),
          supported: failures.some((item) => item.toolName === 'git_commit'),
          label: 'commit',
        },
        {
          claimed: /\b(?:write|modify|change|update|sua|cap nhat)\b/.test(normalized),
          supported: failures.some((item) => MUTATION_TOOLS.has(item.toolName)),
          label: 'workspace mutation',
        },
      ];
      const specificClaims = blockerChecks.filter((check) => check.claimed);
      if (specificClaims.length > 0) {
        for (const unsupported of specificClaims.filter((check) => !check.supported)) {
          reasons.push(`The final answer reports a ${unsupported.label} blocker without a matching failed tool observation.`);
        }
      } else if (failures.length === 0) {
        reasons.push('The final answer reports a blocker, but no failed tool observation supports it.');
      }
    }

    if (reasons.length === 0) return { allow: true, reasons: [] };
    return {
      allow: false,
      reasons,
      continuationPrompt: [
        '[SYSTEM EVIDENCE GATE]: The previous final answer was not accepted because its completion claims are not supported by durable observations.',
        ...reasons.map((reason) => `- ${reason}`),
        'Continue with the missing mutation/verification/tool action, or provide a terminal blocker supported by an actual failed tool result.',
      ].join('\n'),
    };
  }

  private executionsForTurn(session: Session, turn?: number): ObservedExecution[] {
    const calls = new Map<string, SessionEvent>();
    const executions: ObservedExecution[] = [];
    for (const event of session.getEvents()) {
      if (event.type === 'tool/call' && event.data.toolCallId && (turn === undefined || event.data.turn === turn)) {
        calls.set(event.data.toolCallId, event);
      }
      if (event.type !== 'tool/result' || !event.data.toolCallId) continue;
      const call = calls.get(event.data.toolCallId);
      if (!call) continue;
      const toolName = call.data.toolName || event.data.toolName || 'unknown_tool';
      const args = call.data.args || {};
      const payload = event.data.result || {};
      executions.push({
        call,
        result: event,
        toolName,
        args,
        payload,
        kinds: classifyToolEvidence(toolName, args, payload),
      });
    }
    return executions;
  }
}
