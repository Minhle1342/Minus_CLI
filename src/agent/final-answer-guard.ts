import { detectExplicitGitMutationIntent, normalizeIntentText } from '../tools/git-intent.js';
import { detectExplicitGitCommandNames } from '../tools/git-command-policy.js';

export interface FinalAnswerGuardDecision {
  allow: boolean;
  reason?: 'deferred-work' | 'unverified-capability-denial' | 'empty-answer';
  continuationPrompt?: string;
}

export interface FinalAnswerGuardContext {
  userRequest?: string;
  availableToolNames?: string[];
  hasSubmittedSolution?: boolean;
}

interface ToolFailureSummary {
  toolName: string;
  errorCode?: string;
  detail?: string;
}

const OPTIONAL_OFFER_PATTERN = /(?:if you (?:want|would like)|if needed|neu ban (?:muon|can)|neu can)[^.!?\n]{0,180}/g;

const DEFERRED_WORK_PATTERNS = [
  // 1. English: Subject + future modal + verbs
  /\b(?:i|we|agent|assistant)\s+(?:will|shall|am going to|are going to|plan to|aim to|need to|intend to|am about to|will now|shall now|will proceed to|will start to|will begin to|will move on to|will go ahead and|will next|am ready to)\s+(?:now\s+)?(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|construct|generate|add|remove|delete|setup|configure|install)\b/,

  // 2. English contractions (I'll, We'll, I'm going to)
  /\b(?:i'll|we'll|i'm going to|we're going to|i'm about to)\s+(?:now\s+)?(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|construct|generate|add|remove|delete|setup|configure|install)\b/,

  // 3. English temporal sequence transitions ("Now I will...", "Next, I will...", "In the next step, I will...")
  /\b(?:now|next|then|in the next step|moving forward|going forward)\s*,?\s*(?:i|we|agent)?\s*(?:will|shall|am going to|plan to|proceed to|start to|begin to)\s+(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|construct|generate|add|remove|delete|setup|configure|install)\b/,

  // 4. Vietnamese subject + future modal + verbs
  /\b(?:toi|chung toi|minh|em|agent)\s+(?:se|can phai|can|du dinh|chuan bi|dang chuan bi|du kien|len ke hoach|se tien hanh|se bat dau|se bat tay vao|se di vao)\s+(?:ngay\s+)?(?:tiep tuc|thu|chay|thuc hien|kiem thu|test|do|benchmark|kiem tra|dieu tra|chuyen|su dung|sua|phan tich|lam|tien hanh|thiet ke|thiet ke lai|trien khai|viet|code|tao|xay dung|chinh sua|sua doi|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|tai cau truc|implement|debug|chuan doan)\b/,

  // 5. Vietnamese temporal sequence transitions ("Bây giờ tôi sẽ...", "Tiếp theo tôi sẽ...", "Bước tiếp theo tôi sẽ...")
  /\b(?:bay gio|gio|luc nay|hien tai|tiep theo|ke tiep|buoc tiep theo|sau day|sau do)\s*,?\s*(?:toi|chung toi|minh|em|agent)?\s*(?:se|can|chuan bi|du dinh|tien hanh|bat dau)\s+(?:tiep tuc|thu|chay|thuc hien|kiem thu|test|do|benchmark|kiem tra|dieu tra|chuyen|su dung|sua|phan tich|lam|tien hanh|thiet ke|thiet ke lai|trien khai|viet|code|tao|xay dung|chinh sua|sua doi|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|tai cau truc|implement|debug|chuan doan)\b/,

  // 6. Vietnamese explicit action intention without subject ("sẽ tiến hành thiết kế...", "chuẩn bị triển khai...", "sẽ thực hiện bước...")
  /\b(?:se|chuan bi|du dinh)\s+(?:tien hanh|bat dau|trien khai|thuc hien|bat tay vao)\s+(?:thiet ke|thiet ke lai|viet|code|tao|xay dung|chinh sua|sua|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|kiem thu|test|chay|khao sat|kiem tra|doc)\b/,

  // 7. General promise to execute ("sẽ tiếp tục bằng cách...", "cần tiếp tục xử lý...")
  /\b(?:se|can)\s+tiep tuc\s+(?:bang cach|xu ly|thuc hien|chay|kiem tra|dieu tra|sua|test|do|trien khai|thiet ke|viet|code)\b/,
];

const FULFILLED_INTRO_PATTERN = /^\s*(?:toi|chung toi|minh|em|i|we|agent)?\s*(?:se|will|shall|am going to|plan to)?[^\n]{0,140}?(?:duoi day la|ket qua|here is|here are|below is|results?:)[^\n]*/i;

function hasUnfulfilledDeferredPromise(normalizedText: string): boolean {
  // Strip opening intro greetings that are immediately fulfilled in the same message
  const remainingText = normalizedText.replace(FULFILLED_INTRO_PATTERN, '').trim();
  return DEFERRED_WORK_PATTERNS.some((pattern) => pattern.test(remainingText));
}

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
    const trimmed = (answer || '').trim();

    // 1. Chặn câu trả lời hoàn toàn rỗng
    if (!trimmed) {
      return {
        allow: false,
        reason: 'empty-answer',
        continuationPrompt: '[SYSTEM GUARD]: Empty response received. Execute a tool or provide a concrete final answer to the user.',
      };
    }

    // 2. Nếu đã submit_solution thành công (Codex CLI Standard), câu trả lời trực tiếp là Final Answer hợp lệ cho người dùng
    if (context?.hasSubmittedSolution) {
      return { allow: true };
    }

    const normalized = normalizeForMatching(answer);
    const withoutOptionalOffers = normalized.replace(OPTIONAL_OFFER_PATTERN, ' ');
    const promisesFutureToolWork = hasUnfulfilledDeferredPromise(withoutOptionalOffers);
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

    const discussesGitCapability = /\b(?:git|commit|push|branch|repository|repo|tool|permission|quyen)\b/.test(
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
