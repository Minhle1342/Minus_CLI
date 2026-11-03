import fs from 'node:fs';
import path from 'node:path';

import { detectExplicitGitCommandNames, normalizeIntentText, parseGitInvocation } from '../tools/git-command-policy.js';
import { toolResultFailed } from './completion-observations.js';

export type FinalAnswerGuardRejectionReason =
  | 'deferred-work'
  | 'unverified-capability-denial'
  | 'empty-answer'
  | 'insufficient-architecture-answer'
  | 'unverified-architecture-claims'
  | 'curt-final-answer'
  | 'system-prompt-echo'
  | 'insecure-code-confidence';

export interface FinalAnswerGuardDecision {
  allow: boolean;
  reason?: FinalAnswerGuardRejectionReason;
  continuationPrompt?: string;
  recovery?: 'revise-answer' | 'inspect-evidence' | 'execute-task' | 'verify-changes';
  advisories?: string[];
}

export interface FinalAnswerGuardContext {
  userRequest?: string;
  availableToolNames?: string[];
  hasSubmittedSolution?: boolean;
  hasCodeMutations?: boolean;
  filesModified?: string[];
  workspace?: {
    rootDir: string;
    resolveSafePath?: (targetPath: string) => string;
  };
}

interface ToolFailureSummary {
  toolName: string;
  errorCode?: string;
  detail?: string;
}

/** Remove examples before normalizing whitespace; blockquote boundaries matter. */
export function stripMarkdownFormattingForGuard(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/(^|[\s:(])'[^'\n]+'(?=[\s.,;:!?)]|$)/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ');
}

/** Only an actual first-person commitment is a deferred action, not a proposed agent design. */
export function hasUnfulfilledDeferredPromise(text: string): boolean {
  const prose = stripMarkdownFormattingForGuard(text);
  let lines = prose.split(/\r?\n/);
  const intro = lines[0] || '';
  const resultMarker = /(?:duoi day la|ket qua:|nhu sau:|here (?:is|are)|results?:|as follows:)/;
  if (resultMarker.test(normalizeForMatching(intro)) && lines.slice(1).some((line) => line.trim())) {
    // Remove the introductory sentence only. Later promises are still checked.
    lines = lines.slice(1);
  }
  const isSubstantialAnswer = text.trim().length > 150 && lines.filter((l) => l.trim()).length >= 2;
  return lines.some((line) => {
    const normalized = normalizeForMatching(line)
      .replace(/(?:if you (?:want|would like|agree|approve|wish)|if needed|neu ban (?:muon|can|dong y|yeu cau|cho phep)|neu can)[^.!?]*/g, ' ');
    if (/^(?:if |suppose |neu |gia su )/.test(normalized)) return false;
    if (/\b(?:proposed|proposal|recommendation|hypothetical|for example|de xuat|phuong an|gia dinh|vi du|minh hoa)\b/.test(normalized)
      && !/\b(?:i|we|toi|minh|em|chung toi)\s+(?:will|shall|se|can phai)\b/.test(normalized)) return false;
    // In substantive answers, expository phrases like "Tôi sẽ phân tích / giải thích / trình bày / I will explain / analyze / breakdown" are explanatory rhetoric, not deferred execution.
    if (isSubstantialAnswer) {
      const isExpositoryPromise = /\b(?:i|we)\s+(?:will|shall|am going to)\s+(?:now\s+)?(?:explain|analy[sz]e|describe|clarify|detail|break down|outline|summarize|present|discuss)\b/.test(normalized)
        || /\b(?:toi|chung toi|minh|em)\s+(?:se|du dinh|chuan bi)\s+(?:ngay\s+)?(?:giai thich|phan tich|trinh bay|lam ro|tong hop|tom tat|chia se|neu|chi ra|di sau)\b/.test(normalized);
      if (isExpositoryPromise) return false;

      // Miễn trừ cho câu kết lộ trình tương lai / đề xuất hỗ trợ / courtesy closing
      const isFutureRoadmapOrAssistanceOffer =
        /\b(?:trong|o)\s+(?:cac\s+)?(?:buoc|giai doan|phan|phien)\s+(?:tiep theo|toi|sau)\b/.test(normalized)
        || /\b(?:in (?:the\s+)?next (?:steps?|phases?|iterations?)|in future steps?)\b/.test(normalized)
        || /\b(?:san sang|ready to)\s+(?:ho tro|giup|assist|help)\b/.test(normalized)
        || /\b(?:khi|when)\s+(?:ban\s+)?(?:can|muon|yeu cau|need|request)\b/.test(normalized)
        || /\b(?:neu|if)\s+(?:ban\s+)?(?:dong y|muon|can|agree|wish)\b/.test(normalized);
      if (isFutureRoadmapOrAssistanceOffer) return false;
    }

    return /\b(?:i|we)\s+(?:will|shall|am going to|are going to|plan to|need to|intend to|am about to)\s+(?:now\s+)?(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|generate|add|remove|delete|configure|install)\b/.test(normalized)
      || /\b(?:i'll|we'll|i'm going to|we're going to)\s+(?:now\s+)?(?:continue|run|execute|test|inspect|investigate|fix|check|analy[sz]e|implement|create|write|design|refactor|modify|update|edit|build|add|remove|install)\b/.test(normalized)
      || /\b(?:toi|chung toi|minh|em)\s+(?:se|can phai|can|du dinh|chuan bi|se tien hanh|se bat dau)\s+(?:ngay\s+)?(?:tiep tuc|thu|chay|thuc hien|kiem thu|test|do|benchmark|kiem tra|dieu tra|chuyen|su dung|sua|phan tich|lam|tien hanh|thiet ke|trien khai|viet|code|tao|xay dung|chinh sua|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|chuan doan)\b/.test(normalized);
  });
}

/** A completion receipt alone is not a user-facing answer; no length or heading quota. */
export function isCompletionStub(answer: string): boolean {
  const text = normalizeForMatching(answer).replace(/[.!]+$/, '');
  return /^(?:\(?nhiem vu da hoan tat\)?|\(?task completed\)?|\(?solution submitted\)?|each task must be atomic|execution sequence satisfied|done|fixed|success|da (?:xong|sua xong|hoan tat|hoan thanh)|giai phap da duoc submit)$/.test(text)
    || /^(?:i have|we have|agent has)?\s*(?:completed|fixed|resolved|finished|submitted)\s*(?:the task|the bug|the issue)?$/.test(text)
    || /^(?:(?:da|vua)\s+)?(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+(?:cau tra loi\s+)?(?:chi tiet|chinh xac|day du)(?:\s+va\s+(?:chinh xac|day du))?(?:\s+bang tieng viet)?(?:\s+(?:cho|ve)\s+[^:;.!?]+)?$/.test(text);
}

/**
 * Machine-generated system markers that must never surface in a user-facing
 * final answer. If the model echoes them (common after [SYSTEM ...] guard
 * re-prompts or per-step [RESPONSE LANGUAGE]/[STRONG ADVISORY] injections),
 * the echo is stripped before render and pure-echo answers are rejected.
 */
const SYSTEM_PROMPT_ECHO_MARKERS = [
  '[SYSTEM ',
  '[STRONG ADVISORY',
  '[SUBMISSION REQUIRED]',
  '[ADAPTIVE REASONING',
  '🧠 [ADAPTIVE REASONING',
  '[READY TO SUBMIT]',
  '[VERIFICATION REQUIREMENTS SATISFIED]',
  '[RESPONSE LANGUAGE]',
  '[INVESTIGATION SCOPE',
  '[ATTACHMENT NEIGHBORHOOD',
  '[PRE-MUTATION GATE]',
  '[EVIDENCE_GATE_OBSERVE]',
  '[UNVERIFIED_MUTATION',
  '[CASCADE_REPAIR_',
  '[REPRODUCTION_VERIFICATION_',
  '[WEAK_SUBMISSION_SUMMARY_',
  '[VERIFICATION LADDER',
  '[COGNITIVE SCAFFOLD',
  '[HARNESS PROFILE]',
  '[STEP EXECUTION PLAN]',
  '[DYNAMIC EXECUTION PLAN]',
  '[NEXT ACTION ADVICE]',
  '[ADAPTIVE SOFT LATENCY',
  '[PHASE TOOL AUTHORITY',
  '[SYSTEM COMPLETION RECOVERY',
  '[SYSTEM EVIDENCE GATE]',
  '[TOOL PLAYBOOK',
  '[ROOT-CAUSE',
  '[5-STAGE',
  '[DOMAIN INTENT',
  '[LATS',
  '[TOOL GUARDIAN',
  '[RELIABLE RETRIEVAL',
  '[RELIABLE ',
  '[BLAST RADIUS',
  '[VERIFICATION OPTIONS]',
  '[ACTIVE PLAN',
  '[SYSTEM LOOP',
  '[SYSTEM GUARD]',
  '[SYSTEM CAPABILITY',
  '[SYSTEM SECURITY',
  '[SYSTEM SOURCE',
  '[SYSTEM QUALITY',
  '[SYSTEM ANALYSIS',
];

/** A paragraph counts as leaked prompt iff its first non-blank line carries a system marker. */
function escapeEchoMarker(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SYSTEM_ECHO_PARAGRAPH_PATTERN = new RegExp(
  '^(?:' + SYSTEM_PROMPT_ECHO_MARKERS.map(escapeEchoMarker).join('|') + ')[^\\n]*(?:\\n(?!\\n)[^\\n]*)*',
  'gmi',
);

/** Strip leaked system-prompt paragraphs; never touches user content or code fences' inner meaning. */
export function stripSystemPromptEcho(answer: string): string {
  if (!answer || !answer.includes('[')) return answer;
  const stripped = answer
    .replace(SYSTEM_ECHO_PARAGRAPH_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped;
}

/**
 * Pure-echo answers (nothing substantive left after stripping, or a system
 * block leads the answer) must be revised, not shown on the TUI.
 */
export function isSystemPromptEcho(answer: string): boolean {
  if (!answer || !answer.includes('[')) return false;
  const trimmed = answer.trim();
  if (SYSTEM_PROMPT_ECHO_MARKERS.some((m) => trimmed.toUpperCase().startsWith(m))) return true;
  const stripped = stripSystemPromptEcho(answer);
  if (!stripped) return true;
  if (isCompletionStub(stripped)) return true;
  return stripped.length * 3 < trimmed.length;
}

const CAPABILITY_DENIAL_PATTERNS = [
  /\b(?:i am|im|were|we are)?\s*(?:unable|not able)\s+to\b/,
  /\b(?:i|we)\s+(?:cannot|cant|dont have|do not have|lack)\b/,
  // Only a first-person inability/permission claim denies capability.
  // Bare "khong co" (e.g. "khong co conflict") is ordinary factual reporting.
  /\b(?:khong the|khong co quyen|thieu quyen|thieu cong cu|thieu tool)\b/,
];

/**
 * Prevents an in-progress status update from being accepted as the final answer.
 * A real blocker report remains valid; only high-confidence promises of future
 * tool work are rejected. State is scoped to one AgentLoop turn.
 */
export class FinalAnswerGuard {
  private latestFailure?: ToolFailureSummary;
  private observedToolNames = new Set<string>();
  private observedGitEquivalents = new Set<string>();

  reset(): void {
    this.latestFailure = undefined;
    this.observedToolNames.clear();
    this.observedGitEquivalents.clear();
  }

  observeToolResult(toolName: string, result: Record<string, any>, args?: Record<string, any>): void {
    this.observedToolNames.add(toolName);
    for (const equivalent of deriveGitEquivalentTools(toolName, args, result)) {
      this.observedGitEquivalents.add(equivalent);
    }
    const isFailure = toolResultFailed(result);
    if (!isFailure) return;

    this.latestFailure = {
      toolName,
      errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
      detail: firstNonEmptyString(result.diagnostic, result.error, result.stderr, result.stdout)?.slice(0, 400),
    };
  }

  private hasTriedTool(toolName: string): boolean {
    return this.observedToolNames.has(toolName) || this.observedGitEquivalents.has(toolName);
  }

  evaluate(answer: string, context?: FinalAnswerGuardContext): FinalAnswerGuardDecision {
    const trimmed = (answer || '').trim();

    // 1. Chặn câu trả lời hoàn toàn rỗng
    if (!trimmed) {
      return {
        allow: false,
        reason: 'empty-answer',
        recovery: 'revise-answer',
        continuationPrompt: '[SYSTEM GUARD]: Empty response received. Execute a tool or provide a concrete final answer to the user.',
      };
    }

    const normalized = normalizeForMatching(answer);
    if (isSystemPromptEcho(answer)) {
      return {
        allow: false,
        reason: 'system-prompt-echo',
        recovery: 'revise-answer',
        continuationPrompt: [
          '[SYSTEM FINAL ANSWER GUARD]: Your previous response quoted system instructions or prompt blocks (e.g. [SYSTEM ...], [STRONG ADVISORY], [RESPONSE LANGUAGE]) instead of answering the user.',
          'Answer in your own words with the findings, root cause, and evidence. Never restate system directives, guard messages, or scaffold blocks.',
        ].join('\n'),
      };
    }
    const promisesFutureToolWork = hasUnfulfilledDeferredPromise(answer);
    if (promisesFutureToolWork || isCompletionStub(answer)) {
      const failureContext = this.latestFailure
        ? `The latest tool failure was ${this.latestFailure.toolName}${this.latestFailure.errorCode ? ` (${this.latestFailure.errorCode})` : ''}${this.latestFailure.detail ? `: ${this.latestFailure.detail}` : '.'}`
        : undefined;

      return {
        allow: false,
        reason: 'deferred-work',
        recovery: promisesFutureToolWork ? 'execute-task' : 'revise-answer',
        continuationPrompt: [
          '[SYSTEM FINAL ANSWER GUARD]: Your previous response described work you will do later, or merely announced an intention to report without providing the answer itself. It was not accepted as a final answer.',
          'Provide the findings at the requested level of detail, or continue only the user-authorized work still needed.',
          'Do not merely announce the next action, echo the prompt, or promise a future report.',
          failureContext,
        ].filter(Boolean).join('\n'),
      };
    }

    // 3. Kiểm tra từ chối năng lực Git trái phép
    const gitDenial = this.evaluateGitCapabilityDenial(normalized, context);
    if (gitDenial) return gitDenial;

    // 4. Kiểm tra dẫn chứng file có thật cho mọi câu trả lời (mechanical grounding)
    const archDecision = evaluateArchitectureAnalysis(answer, context);
    if (archDecision && !archDecision.allow) return archDecision;

    // 5. Chặn câu trả lời cộc lốc / cụt ngủn cho tác vụ đã hoàn tất hoặc có can thiệp mã nguồn
    const curtDecision = evaluateCurtFinalAnswer(answer, context);
    if (curtDecision && !curtDecision.allow) return curtDecision;

    // 5b. Kiểm soát Ảo giác ở cấp độ Bảo mật: Chặn Tự tin thái quá vào code nhiễm độc (Insecure Code Confidence)
    const securityDecision = evaluateInsecureCodeConfidence(answer, context);
    if (securityDecision) return securityDecision;

    const advisories = [archDecision, curtDecision].flatMap((d) => d?.advisories || []);
    return { allow: true, ...(advisories.length ? { advisories } : {}) };
  }

  private evaluateGitCapabilityDenial(
    normalizedAnswer: string,
    context?: FinalAnswerGuardContext,
  ): FinalAnswerGuardDecision | undefined {
    const commandNames = detectExplicitGitCommandNames(context?.userRequest);
    const requestedTools = new Set<string>();
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
    // Dedicated git_* tools are unregistered; a requested git operation stays
    // actionable through run_command "git ...", which this guard already credits
    // via observed shell invocations (see deriveGitEquivalentTools).
    const GIT_RUNNABLE_VIA_SHELL = new Set(['git_add', 'git_commit', 'git_push', 'git_status', 'git_diff', 'git_command']);
    const isAvailable = (toolName: string) =>
      availableTools.has(toolName) ||
      (GIT_RUNNABLE_VIA_SHELL.has(toolName) && availableTools.has('run_command'));
    const untriedTools = [...requestedTools].filter(
      (toolName) => isAvailable(toolName) && !this.hasTriedTool(toolName),
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
      recovery: 'execute-task',
      continuationPrompt: [
        '[SYSTEM CAPABILITY GUARD]: Your previous answer denied access to Git tools or permissions without attempting the user-authorized operation.',
        `The following requested Git operations have an available, untried execution path: ${untriedTools.join(', ')}.`,
        'Continue only the user-authorized Git operation using an available tool; when dedicated tools are absent, use run_command with the corresponding git command. Inspect relevant state and preserve unrelated changes.',
        'Only report a credential, remote, branch-protection, or repository blocker after a relevant tool returns that concrete failure.',
      ].join('\n'),
    };
  }
}

export interface GroundingVerificationResult {
  isGrounded: boolean;
  validFiles: string[];
  invalidFiles: string[];
  reasons: string[];
}

/**
 * Kiểm định xem bài phân tích có dẫn chứng các tệp nguồn có thật trong workspace hay không.
 */
export function verifyWorkspaceGrounding(
  answer: string,
  workspace?: { rootDir: string; resolveSafePath?: (targetPath: string) => string },
): GroundingVerificationResult {
  if (!workspace) return { isGrounded: true, validFiles: [], invalidFiles: [], reasons: [] };
  const candidates = new Set<string>();
  let proposedSection = false;
  let fencedExample = false;
  for (const line of answer.split(/\r?\n/)) {
    const normalized = normalizeForMatching(line);
    if (/^\s*(?:```|~~~)/.test(line)) { fencedExample = !fencedExample; continue; }
    if (fencedExample || /^\s*>/.test(line)) continue;
    const isProposal = /\b(?:propos(?:al|ed)|recommend(?:ation|ed)|pseudocode|hypothetical|for example|de xuat|phuong an|gia ma|gia dinh|vi du|minh hoa)\b/.test(normalized);
    if (/^\s*#{1,6}\s/.test(line)) proposedSection = isProposal;
    if (proposedSection || isProposal || /\b(?:does not exist|doesn't exist|not found|absent|khong ton tai|chua co|khong tim thay)\b/.test(normalized)) continue;
    const add = (raw: string) => {
      let candidate = raw.trim().replace(/^<|>$/g, '').replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?(?:-\d+)?)$/, '');
      if (/^https?:|^app:|^codex:/i.test(candidate)) return;
      candidate = candidate.replace(/^file:\/\/\//i, '').replace(/\\/g, '/');
      if (/^\/[a-z]:\//i.test(candidate)) candidate = candidate.slice(1);
      if (candidate && !candidate.includes('node_modules/')) {
        if (!/^(?:path\/|example\/|examples\/|samples?\/|foo\/|bar\/|\.{3}\/)/i.test(candidate)) {
          candidates.add(candidate);
        }
      }
    };
    // Markdown targets can contain spaces inside <...>; retain line anchors until add().
    const withoutLinks = line.replace(/\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g, (_, target: string) => {
      add(target.replace(/\s+"[^"]*"$/, '')); return ' ';
    });
    for (const match of withoutLinks.replace(/https?:\/\/[^\s]+/g, ' ').matchAll(/(?:file:\/\/\/|[a-zA-Z]:[\/\\]|\.?\.?[\/\\]|\/)?[\w.-]+(?:[\/\\][\w.-]+)+\.[a-zA-Z0-9]+(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?|\b(?:package\.json|tsconfig\.json|README\.md)\b/g)) add(match[0]);
  }
  const validFiles: string[] = [];
  const invalidFiles: string[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = workspace.resolveSafePath
        ? workspace.resolveSafePath(candidate)
        : path.resolve(workspace.rootDir, candidate);
      const relative = path.relative(workspace.rootDir, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        invalidFiles.push(candidate); continue;
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) validFiles.push(candidate);
      else invalidFiles.push(candidate);
    } catch { invalidFiles.push(candidate); }
  }
  return {
    isGrounded: validFiles.length > 0 && invalidFiles.length === 0,
    validFiles, invalidFiles,
    reasons: invalidFiles.length
      ? [`Referenced source files could not be resolved: ${invalidFiles.join(', ')}.`]
      : validFiles.length ? [] : ['No file citation was recognized; symbol references or existing context may still support the answer.'],
  };
}

/**
 * Mechanical signal that an answer talks about repository source, not about
 * the user's intent: it names a file path, contains a code fence, or declares
 * a code symbol. Used where a prose-intent guess used to decide whether to
 * force evidence.
 */
export function referencesWorkspaceCode(answer: string): boolean {
  if (!answer) return false;
  return /```|~~~|(?:[\w.-]+[\\/])+[\w.-]+\.[a-zA-Z0-9]+|\b(?:function|class|interface)\s+[A-Za-z_$]|\b(?:import|export)\s+[A-Za-z_${*]/.test(answer);
}

/**
 * Citation existence is a mechanical check, not a claim that the prose is true.
 * It runs on every answer: a false file citation is wrong regardless of what
 * the user's prose looked like.
 */
export function evaluateArchitectureAnalysis(
  answer: string, context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  const grounding = verifyWorkspaceGrounding(answer, context?.workspace);
  if (grounding.invalidFiles.length) {
    if (grounding.validFiles.length >= 2 && grounding.validFiles.length > grounding.invalidFiles.length) {
      return {
        allow: true,
        advisories: [`Some referenced paths could not be found locally: ${grounding.invalidFiles.join(', ')}.`],
      };
    }
    return {
      allow: false, reason: 'unverified-architecture-claims', recovery: 'inspect-evidence',
      continuationPrompt: `[SYSTEM SOURCE CHECK]: ${grounding.reasons.join(' ')} Correct the citations using existing evidence, inspect the specific missing source if necessary, or label hypothetical paths as proposals. No minimum length or fixed outline is required.`,
    };
  }
  return undefined;
}

export function normalizeForMatching(value: string): string {
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

/**
 * Công nhận Git qua `run_command` / `git_command` như tool chuyên dụng.
 * Giữ đối xứng với `completion-evidence.ts`: commit/push/add/status/diff thực hiện
 * qua `run_command "git ..."` hoặc `git_command { subcommand }` được tính là đã thử
 * `git_commit` / `git_push` / `git_add` / `git_status` / `git_diff` tương ứng.
 */
function extractCommandText(args: Record<string, any> | undefined, result: Record<string, any>): string {
  const candidates = [
    args?.command, args?.CommandLine, args?.commandLine, args?.cmd,
    result?.command, result?.CommandLine,
  ];
  const found = candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return found ? found.trim() : '';
}

function extractGitSubcommand(command: string): string | undefined {
  return parseGitInvocation(command)?.subcommand;
}

function mapGitSubcommandToDedicated(subcommand: string | undefined): string | undefined {
  switch (subcommand) {
    case 'add': return 'git_add';
    case 'commit': return 'git_commit';
    case 'push': return 'git_push';
    case 'status': return 'git_status';
    case 'diff': return 'git_diff';
    default: return undefined;
  }
}

function deriveGitEquivalentTools(
  toolName: string,
  args: Record<string, any> | undefined,
  result: Record<string, any>,
): string[] {
  if (result?.commandOutcome === 'blocked_preflight' || result?.processStarted === false) return [];
  if (toolName === 'git_command') {
    const dedicated = mapGitSubcommandToDedicated(
      String(args?.subcommand || result?.subcommand || '').trim().toLowerCase() || undefined,
    );
    return dedicated ? [dedicated] : [];
  }
  if (toolName === 'run_command') {
    const subcommand = extractGitSubcommand(extractCommandText(args, result));
    if (!subcommand) return [];
    const dedicated = mapGitSubcommandToDedicated(subcommand);
    // Mọi `git <subcommand>` qua shell đều tính là đã thử `git_command`,
    // tương đương độ nới lỏng sẵn có khi dùng tool `git_command` trực tiếp.
    return dedicated ? [dedicated, 'git_command'] : ['git_command'];
  }
  return [];
}

export function evaluateCurtFinalAnswer(
  answer: string, context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  if (!context?.hasSubmittedSolution && !context?.hasCodeMutations) return undefined;
  if (!isCompletionStub(answer)) return undefined;
  return { allow: false, reason: 'curt-final-answer', recovery: 'revise-answer',
    continuationPrompt: '[SYSTEM QUALITY GUARD]: State the concrete outcome and relevant verification status, using the level of detail requested by the user.' };
}

export function claimsAbsoluteSecurity(text: string): boolean {
  const normalized = normalizeForMatching(text);
  return /\b(?:hoan toan an toan|an toan tuyet doi|bao mat tuyet doi|hoan toan bao mat|an toan 100%|bao mat 100%|da toi uu bao mat|chong (?:sql injection|xss|tan cong) tuyet doi|khong the bi tan cong|khong co lo hong|fully secure|completely secure|100% secure|bulletproof|immune to (?:sql injection|xss|vulnerabilities|attacks)|no vulnerabilities?|safest? implementation)\b/i.test(
    normalized,
  );
}

export function hasSecurityDisclaimer(text: string): boolean {
  const normalized = normalizeForMatching(text);
  return /\b(?:luu y|canh bao|chu y|khuyen nghi|demo|minh hoa|tam thoi|chua xu ly|can bo sung|can loc|can validate|can parameter|chua an toan|warning|caution|note|disclaimer|for illustration|only for testing|not production ready|should sanitize|must parameterize|insecure for production)\b/i.test(
    normalized,
  );
}

export interface DetectedVulnerability {
  type: 'sql-injection' | 'hardcoded-credentials' | 'unsafe-eval-xss';
  description: string;
}

export function detectClassicVulnerabilities(codeSnippet: string): DetectedVulnerability[] {
  const vulns: DetectedVulnerability[] = [];

  // 1. SQL Injection: Ghép trực tiếp biến đầu vào vào câu lệnh SQL
  const hasSqlKeywords = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(codeSnippet);
  if (hasSqlKeywords) {
    const hasInterpolatedSqlInput = /`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{[^}]*(?:req\.|params|query|body|userInput|input\b|payload\b|username\b|password\b|email\b)[^}]*\}[^`]*`/i.test(
      codeSnippet,
    );
    const hasConcatSqlInput = /["']\s*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[\s\S]{0,60}["']\s*\+\s*(?:req\.|params|query|body|userInput|input\b|payload\b|username\b|password\b|email\b)/i.test(
      codeSnippet,
    );

    const hasParameterized = /\$1|\?|:\w+|prepare\(|query\([^,]+,\s*\[|\bprisma\.|\bknex\(|\bdrizzle\(/i.test(codeSnippet);

    if ((hasInterpolatedSqlInput || hasConcatSqlInput) && !hasParameterized) {
      vulns.push({
        type: 'sql-injection',
        description: 'SQL Injection: user input variables concatenated directly into SQL statements (no Parameterized Queries / Prepared Statements)',
      });
    }
  }

  // 2. Hardcoded Real Credentials / Private Keys
  const isMockToken = /dummy|mock|fake|test|example|placeholder|SAMPLE_|YOUR_|xxxx/i.test(codeSnippet);
  if (!isMockToken) {
    if (/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(codeSnippet)) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: Private Key embedded directly in source code',
      });
    } else if (/\bAKIA[0-9A-Z]{16}\b/.test(codeSnippet) && !codeSnippet.includes('AKIAIOSFODNN7EXAMPLE')) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: real AWS Access Key ID embedded directly in source code',
      });
    } else if (/\bghp_[a-zA-Z0-9]{36}\b/.test(codeSnippet)) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: GitHub Personal Access Token embedded directly in source code',
      });
    } else if (/\bsk-[a-zA-Z0-9]{32,}\b|\bsk-ant-[a-zA-Z0-9]{32,}\b/.test(codeSnippet)) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: API Key secret (OpenAI/Anthropic) embedded directly in source code',
      });
    }
  }

  // 3. Raw Dangerous Code Execution / Direct XSS
  const hasRawEval = /\beval\s*\(\s*(?:req\.|userInput|input\b|params\.|query\.|body\.)\b/i.test(codeSnippet);
  const hasRawInnerHTML = /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?:req\.|userInput|input\b|params\.|query\.|body\.)\b/i.test(
    codeSnippet,
  );
  const hasSanitize = /DOMPurify|sanitize|escapeHtml/i.test(codeSnippet);

  if ((hasRawEval || hasRawInnerHTML) && !hasSanitize) {
    vulns.push({
      type: 'unsafe-eval-xss',
      description: 'Dangerous Execution / XSS: eval or dangerouslySetInnerHTML fed directly from user data without sanitization',
    });
  }

  return vulns;
}

function isTestOrDocFile(filePath: string): boolean {
  return /(?:^|[\\/])(?:test|tests|__tests__|scratch)[\\/]|(?:\.(?:test|spec)\.[a-z0-9]+$)|\.(?:md|txt|json|yaml|yml)$/i.test(
    filePath,
  );
}

/**
 * Đánh giá tính chân thực bảo mật (Insecure Code Confidence Guard):
 * Ngăn chặn hiện tượng Agent tạo ra các lỗ hổng bảo mật kinh điển (SQLi, Hardcoded Key, XSS)
 * nhưng lại khẳng định tuyệt đối là code hoàn toàn an toàn / đã tối ưu bảo mật.
 *
 * Tiêu chí nới lỏng linh hoạt (Non-Pedantic):
 * 1. Chỉ kích hoạt khi Agent đưa ra tuyên bố an toàn tuyệt đối (claimsAbsoluteSecurity).
 * 2. Miễn trừ nếu Agent có kèm Security Disclaimer / cảnh báo rủi ro trung thực.
 * 3. Miễn trừ các file kiểm thử (test, tests, scratch) và dummy tokens.
 */
export function evaluateInsecureCodeConfidence(
  answer: string,
  context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  // 1. Fast Path: Nếu Agent không đưa ra khẳng định an toàn tuyệt đối, bỏ qua ngay
  if (!claimsAbsoluteSecurity(answer)) {
    return undefined;
  }

  // 2. Miễn trừ nếu Agent có cảnh báo / disclaimer trung thực về bảo mật
  if (hasSecurityDisclaimer(answer)) {
    return undefined;
  }

  // 3. Thu thập các đoạn mã cần kiểm tra
  const codeSnippets: string[] = [];

  // 4a. Thu thập code blocks trong câu trả lời (answer)
  const codeBlockMatches = answer.match(/```[\s\S]*?```/g) || [];
  for (const block of codeBlockMatches) {
    codeSnippets.push(block);
  }
  if (codeSnippets.length === 0 && answer.length < 5000) {
    codeSnippets.push(answer);
  }

  // 4b. Thu thập nội dung từ các file mã nguồn đã sửa (loại trừ file test, scratch, docs)
  if (context?.filesModified && Array.isArray(context.filesModified)) {
    for (const filePath of context.filesModified) {
      if (isTestOrDocFile(filePath)) continue;

      let absolutePath = filePath;
      if (!path.isAbsolute(filePath) && context.workspace?.rootDir) {
        absolutePath = path.resolve(context.workspace.rootDir, filePath);
      }

      try {
        if (fs.existsSync(absolutePath)) {
          const content = fs.readFileSync(absolutePath, 'utf8');
          // Giới hạn 5000 ký tự đầu tiên để tối ưu hiệu năng
          codeSnippets.push(content.slice(0, 5000));
        }
      } catch {
        // Bỏ qua lỗi đọc file nếu không truy cập được
      }
    }
  }

  // 5. Quét tìm các lỗ hổng kinh điển
  const allVulns: DetectedVulnerability[] = [];
  for (const snippet of codeSnippets) {
    const vulns = detectClassicVulnerabilities(snippet);
    for (const v of vulns) {
      if (!allVulns.some((existing) => existing.type === v.type)) {
        allVulns.push(v);
      }
    }
  }

  // 6. Nếu phát hiện mâu thuẫn trực diện: Tuyên bố an toàn tuyệt đối nhưng chứa lỗ hổng kinh điển
  if (allVulns.length > 0) {
    return {
      allow: false,
      reason: 'insecure-code-confidence',
      continuationPrompt: [
        '[SYSTEM SECURITY GUARD]: Your response is REJECTED for "overconfidence in tainted code" (Insecure Code Confidence).',
        'You claimed the code is "completely safe" or "security-optimized", but the source contains classic severe security vulnerabilities:',
        ...allVulns.map((v) => `- ${v.description}`),
        'REMEDIATION GUIDANCE:',
        '1. If this code will run in production: you must fix the vulnerability (use Parameterized Query / Prepared Statements, move secrets into environment variables, or sanitize inputs).',
        '2. OR if this is illustrative/sample code: state the risk warning (Security Disclaimer) honestly instead of claiming absolute safety.',
      ].join('\n'),
    };
  }

  return undefined;
}

