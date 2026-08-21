import { detectExplicitGitMutationIntent, normalizeIntentText } from '../tools/git-intent.js';
import { detectExplicitGitCommandNames } from '../tools/git-command-policy.js';

export interface FinalAnswerGuardDecision {
  allow: boolean;
  reason?: 'deferred-work' | 'unverified-capability-denial';
  continuationPrompt?: string;
}

export interface FinalAnswerGuardContext {
  userRequest?: string;
  availableToolNames?: string[];
}

interface ToolFailureSummary {
  toolName: string;
  errorCode?: string;
  detail?: string;
}

const OPTIONAL_OFFER_PATTERN = /(?:if you (?:want|would like)|if needed|neu ban (?:muon|can)|neu can)[^.!?\n]{0,180}/g;

const DEFERRED_WORK_PATTERNS = [
  /\b(?:i|we)\s+(?:will|shall|am going to|are going to|need to|plan to)\s+(?:now\s+)?(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work)\b/,
  /\b(?:i'll|we'll)\s+(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work)\b/,
  /\b(?:toi|chung toi|minh)\s+(?:se|can phai|can|du dinh)\s+(?:tiep tuc|thu|chay|thuc hien|kiem thu|test|do|benchmark|kiem tra|dieu tra|chuyen|su dung|sua|phan tich|lam)\b/,
  /\b(?:se|can)\s+tiep tuc\s+(?:bang cach|xu ly|thuc hien|chay|kiem tra|dieu tra|sua|test|do)\b/,
];

const CAPABILITY_DENIAL_PATTERNS = [
  /\b(?:i am|im|were|we are)?\s*(?:unable|not able)\s+to\b/,
  /\b(?:i|we)\s+(?:cannot|cant|dont have|do not have|lack)\b/,
  /\b(?:khong the|khong co|thieu)\b/,
];

/**
 * Prevents an in-progress status update from being accepted as the final answer.
 * A real blocker report remains valid; only high-confidence promises of future
 * tool work are rejected. State is scoped to one AgentLoop turn.
 */
export class FinalAnswerGuard {
  private latestFailure?: ToolFailureSummary;
  private observedToolNames = new Set<string>();

  reset(): void {
    this.latestFailure = undefined;
    this.observedToolNames.clear();
  }

  observeToolResult(toolName: string, result: Record<string, any>): void {
    this.observedToolNames.add(toolName);
    const isFailure = Boolean(
      result.error
      || result.errorCode
      || result.success === false
      || (typeof result.exitCode === 'number' && result.exitCode !== 0),
    );
    if (!isFailure) return;

    this.latestFailure = {
      toolName,
      errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
      detail: firstNonEmptyString(result.diagnostic, result.error, result.stderr, result.stdout)?.slice(0, 400),
    };
  }

  evaluate(answer: string, context?: FinalAnswerGuardContext): FinalAnswerGuardDecision {
    const normalized = normalizeForMatching(answer);
    const withoutOptionalOffers = normalized.replace(OPTIONAL_OFFER_PATTERN, ' ');
    const promisesFutureToolWork = DEFERRED_WORK_PATTERNS.some((pattern) => pattern.test(withoutOptionalOffers));
    if (!promisesFutureToolWork) {
      const gitDenial = this.evaluateGitCapabilityDenial(normalized, context);
      if (gitDenial) return gitDenial;
      return { allow: true };
    }

    const failureContext = this.latestFailure
      ? `The latest tool failure was ${this.latestFailure.toolName}${this.latestFailure.errorCode ? ` (${this.latestFailure.errorCode})` : ''}${this.latestFailure.detail ? `: ${this.latestFailure.detail}` : '.'}`
      : undefined;

    return {
      allow: false,
      reason: 'deferred-work',
      continuationPrompt: [
        '[SYSTEM FINAL ANSWER GUARD]: Your previous response described work you will do later, so it was not accepted as a final answer.',
        'Continue the work now by calling the appropriate tools. Do not merely announce the next action.',
        'If no safe or valid execution path remains, provide a truthful terminal blocker report with evidence and no promise of future execution.',
        failureContext,
      ].filter(Boolean).join('\n'),
    };
  }

  private evaluateGitCapabilityDenial(
    normalizedAnswer: string,
    context?: FinalAnswerGuardContext,
  ): FinalAnswerGuardDecision | undefined {
    const intent = detectExplicitGitMutationIntent(context?.userRequest);
    const commandNames = detectExplicitGitCommandNames(context?.userRequest);
    const requestedTools = new Set([
      ...(intent.stage && !intent.commit ? ['git_add'] : []),
      ...(intent.commit ? ['git_commit'] : []),
      ...(intent.push ? ['git_push'] : []),
    ]);
    const dedicatedCommands: Record<string, string> = {
      add: 'git_add',
      commit: 'git_commit',
      diff: 'git_diff',
      push: 'git_push',
      status: 'git_status',
    };
    for (const commandName of commandNames) {
      requestedTools.add(dedicatedCommands[commandName] || 'git_command');
    }
    if (requestedTools.size === 0) return undefined;

    const availableTools = new Set(context?.availableToolNames || []);
    const untriedTools = [...requestedTools].filter(
      (toolName) => availableTools.has(toolName) && !this.observedToolNames.has(toolName),
    );
    if (untriedTools.length === 0) return undefined;

    const discussesGitCapability = /\b(?:git|commit|push|repository|repo|tool|permission|quyen)\b/.test(
      normalizeIntentText(normalizedAnswer),
    );
    const deniesCapability = CAPABILITY_DENIAL_PATTERNS.some((pattern) => pattern.test(normalizedAnswer));
    if (!discussesGitCapability || !deniesCapability) return undefined;

    return {
      allow: false,
      reason: 'unverified-capability-denial',
      continuationPrompt: [
        '[SYSTEM CAPABILITY GUARD]: Your previous answer denied access to Git tools or permissions without attempting the user-authorized operation.',
        `The following requested tools are available and untried: ${untriedTools.join(', ')}.`,
        'Continue now: inspect status/diff, verify changes, then call the dedicated Git tools requested by the user.',
        'Only report a credential, remote, branch-protection, or repository blocker after a relevant tool returns that concrete failure.',
      ].join('\n'),
    };
  }
}

function normalizeForMatching(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}
