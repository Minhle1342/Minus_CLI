import fs from 'node:fs';
import path from 'node:path';
import { detectExplicitGitMutationIntent, normalizeIntentText } from '../tools/git-intent.js';
import { detectExplicitGitCommandNames } from '../tools/git-command-policy.js';

export type FinalAnswerGuardRejectionReason =
  | 'deferred-work'
  | 'unverified-capability-denial'
  | 'empty-answer'
  | 'insufficient-architecture-answer'
  | 'unverified-architecture-claims'
  | 'insufficient-analysis-answer'
  | 'curt-final-answer'
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
  return lines.some((line) => {
    const normalized = normalizeForMatching(line)
      .replace(/(?:if you (?:want|would like)|if needed|neu ban (?:muon|can)|neu can)[^.!?]*/g, ' ');
    if (/^(?:if |suppose |neu |gia su )/.test(normalized)) return false;
    if (/\b(?:proposed|proposal|recommendation|hypothetical|for example|de xuat|phuong an|gia dinh|vi du|minh hoa)\b/.test(normalized)
      && !/\b(?:i|we|toi|minh|em|chung toi)\s+(?:will|shall|se|can phai)\b/.test(normalized)) return false;
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
        recovery: 'revise-answer',
        continuationPrompt: '[SYSTEM GUARD]: Empty response received. Execute a tool or provide a concrete final answer to the user.',
      };
    }

    const normalized = normalizeForMatching(answer);
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

    // 4. Kiểm định tính chuyên sâu, có cấu trúc và đúng sự thật cho query kiến trúc / workflow / pattern
    const archDecision = evaluateArchitectureAnalysis(answer, context);
    if (archDecision && !archDecision.allow) return archDecision;

    // 5. Kiểm định tính chuyên sâu cho query điều tra nguyên nhân / phân tích sự cố
    const analysisDecision = evaluateAnalysisOrInvestigationAnswer(answer, context);
    if (analysisDecision && !analysisDecision.allow) return analysisDecision;

    // 5b. Chặn câu trả lời cộc lốc / cụt ngủn cho tác vụ đã hoàn tất hoặc có can thiệp mã nguồn
    const curtDecision = evaluateCurtFinalAnswer(answer, context);
    if (curtDecision && !curtDecision.allow) return curtDecision;

    // 5c. Kiểm soát Ảo giác ở cấp độ Bảo mật: Chặn Tự tin thái quá vào code nhiễm độc (Insecure Code Confidence)
    const securityDecision = evaluateInsecureCodeConfidence(answer, context);
    if (securityDecision) return securityDecision;

    const advisories = [archDecision, analysisDecision, curtDecision].flatMap((d) => d?.advisories || []);
    return { allow: true, ...(advisories.length ? { advisories } : {}) };
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
      recovery: 'execute-task',
      continuationPrompt: [
        '[SYSTEM CAPABILITY GUARD]: Your previous answer denied access to Git tools or permissions without attempting the user-authorized operation.',
        `The following requested tools are available and untried: ${untriedTools.join(', ')}.`,
        'Continue now: inspect status/diff, verify changes, then call the dedicated Git tools requested by the user.',
        'Only report a credential, remote, branch-protection, or repository blocker after a relevant tool returns that concrete failure.',
      ].join('\n'),
    };
  }
}

export type ArchitectureCategory = 'architecture' | 'workflow' | 'pattern' | 'mechanism' | 'business';

export interface ArchitectureIntentResult {
  isArchitectureQuery: boolean;
  categories: ArchitectureCategory[];
}

export function detectArchitectureAnalysisIntent(userRequest?: string): ArchitectureIntentResult {
  if (!userRequest || typeof userRequest !== 'string') {
    return { isArchitectureQuery: false, categories: [] };
  }

  const normalized = normalizeForMatching(userRequest);
  const categories = new Set<ArchitectureCategory>();

  // 1. Nhóm từ khóa hành vi phân tích chuyên sâu (Loại bỏ các động từ tác vụ thường ngày như "kiem tra", "inspect", "mo ta")
  const hasAnalyticalAction =
    /\b(?:phan tich|giai thich|tim hieu|khao sat|tong quan|trinh bay|analyze|explain|breakdown|trace|explore|understand|overview|walkthrough)\b/.test(
      normalized,
    ) || /\b(?:hoat dong nhu the nao|hoat dong the nao|van hanh the nao|to chuc nhu the nao|how does .* work|how it works)\b/.test(
      normalized,
    );

  // 2. Nhóm Kiến trúc (Architecture / System Topology)
  if (
    /\b(?:kien truc|kien truc he thong|cau truc he thong|kien truc tong the|architecture|system design|system architecture|software architecture|architectural|topology)\b/.test(
      normalized,
    )
  ) {
    categories.add('architecture');
  }

  // 3. Nhóm Workflow & Luồng dữ liệu (Workflow / Dataflow / Execution trace)
  // Chỉ khớp các cụm luồng cụ thể, tránh khớp chữ "luong" đứng đơn lẻ (gây bắt nhầm số lượng, chất lượng, âm lượng, lưu lượng)
  if (
    /\b(?:workflow|luong hoat dong|luong thuc thi|luong du lieu|luong xu ly|luong goi|dataflow|data flow|execution flow|call flow|call graph|lifecycle|execution trace)\b/.test(
      normalized,
    )
  ) {
    categories.add('workflow');
  }

  // 4. Nhóm Mẫu thiết kế (Design Patterns)
  if (
    /\b(?:pattern|design pattern|mau thiet ke|mo hinh thiet ke|creational pattern|structural pattern|behavioral pattern)\b/.test(
      normalized,
    )
  ) {
    categories.add('pattern');
  }

  // 5. Nhóm Cơ chế (Mechanisms)
  if (
    /\b(?:co che|co che hoat dong|co che van hanh|co che ben trong|internal mechanism|mechanism|engine mechanism)\b/.test(
      normalized,
    )
  ) {
    categories.add('mechanism');
  }

  // 6. Nhóm Nghiệp vụ (Business Mechanisms / Domain logic)
  if (
    /\b(?:nghiep vu|logic nghiep vu|business logic|business mechanism|domain model|domain logic)\b/.test(
      normalized,
    )
  ) {
    categories.add('business');
  }

  // Nếu câu chứa tác vụ sửa lỗi / debug / đo đạc / hiệu năng cụ thể và KHÔNG có từ khóa kiến trúc hệ thống rõ ràng,
  // thì đó là tác vụ kỹ thuật thông thường, không phải bài luận phân tích kiến trúc.
  const isBugOrTechnicalTask =
    /\b(?:sua|fix|debug|loi|error|crash|latency|cham|slow|commit|patch|update|refactor|benchmark)\b/.test(
      normalized,
    );
  if (isBugOrTechnicalTask && !categories.has('architecture')) {
    return { isArchitectureQuery: false, categories: Array.from(categories) };
  }

  // Query được coi là query phân tích kiến trúc khi có từ 2 danh mục trở lên HOẶC có 1 danh mục đi kèm hành động phân tích/giải thích/walkthrough
  const isArchitectureQuery = categories.size >= 2 || (categories.size >= 1 && hasAnalyticalAction);

  return {
    isArchitectureQuery,
    categories: Array.from(categories),
  };
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
      try { candidate = decodeURIComponent(candidate); } catch { return; }
      candidate = candidate.replace(/^file:\/\/\//i, '').replace(/\\/g, '/');
      if (/^\/[a-z]:\//i.test(candidate)) candidate = candidate.slice(1);
      if (candidate && !candidate.includes('node_modules/')) candidates.add(candidate);
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

/** Citation existence is a mechanical check, not a claim that the prose is true. */
export function evaluateArchitectureAnalysis(
  answer: string, context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  if (!detectArchitectureAnalysisIntent(context?.userRequest).isArchitectureQuery) return undefined;
  const grounding = verifyWorkspaceGrounding(answer, context?.workspace);
  if (grounding.invalidFiles.length) {
    return {
      allow: false, reason: 'unverified-architecture-claims', recovery: 'inspect-evidence',
      continuationPrompt: `[SYSTEM SOURCE CHECK]: ${grounding.reasons.join(' ')} Correct the citations using existing evidence, inspect the specific missing source if necessary, or label hypothetical paths as proposals. No minimum length or fixed outline is required.`,
    };
  }
  if (!grounding.validFiles.length && context?.workspace) {
    return { allow: true, advisories: ['Anchor important repository claims in inspected code or reliable context; use the detail and format requested by the user.'] };
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

export interface AnalysisIntentResult {
  isAnalysisQuery: boolean;
  categories: string[];
}

export function detectAnalysisOrInvestigationIntent(userRequest?: string): AnalysisIntentResult {
  if (!userRequest || typeof userRequest !== 'string') {
    return { isAnalysisQuery: false, categories: [] };
  }

  const normalized = normalizeForMatching(userRequest);
  const categories: string[] = [];

  // 1. Nhóm mục tiêu điều tra nguyên nhân / sự cố / bug / bất cập
  const hasInvestigationTarget = /\b(?:nguyen nhan|vi sao|tai sao|ly do|loi|bug|van de|issue|su co|tiem an|diem yeu|bat cap|cause|root cause|why)\b/.test(
    normalized,
  );

  // 1b. Nhóm câu hỏi trực diện về nguyên nhân / lý do ("Tại sao...", "Vì sao...", "Lý do gì...", "Nguyên nhân khiến...")
  const hasDirectWhyQuestion = /\b(?:tai sao|vi sao|ly do (?:gi|nao|khien)?|nguyen nhan (?:gi|nao|khien)?|tai vi sao|how come)\b/.test(
    normalized,
  );

  // 1c. Nhóm sự cố không hoạt động / không hiển thị / lỗi giao diện hoặc logic
  const hasMalfunctionTarget = /\b(?:khong (?:hien thi|hoat dong|chay|goi y|click|bam|nhan|an|chuyen|load|tai|tim thay)|bi (?:loi|treo|an|mat|crash|freeze)|not (?:showing|working|displaying|rendering|suggesting))\b/.test(
    normalized,
  );

  // 2. Nhóm hành động phân tích / khảo sát / tìm hiểu / kiểm tra
  const hasAnalyticalAction = /\b(?:phan tich|giai thich|tim hieu|khao sat|dieu tra|xac dinh|tim|kiem tra|soi|nghiem thu|audit|inspect|investigate|diagnose|find|analyze|explain|report|breakdown)\b/.test(
    normalized,
  );

  // 3. Nhóm yêu cầu báo cáo / trình bày chi tiết
  const requestsDetailedReport = /\b(?:bao cao|trinh bay|chi tiet|day du|report|in detail|detailed)\b/.test(
    normalized,
  );

  if (hasDirectWhyQuestion) {
    categories.push('direct-why-question');
  }
  if (hasInvestigationTarget && hasAnalyticalAction) {
    categories.push('root-cause-investigation');
  }
  if (hasMalfunctionTarget) {
    categories.push('malfunction-investigation');
  }
  if (requestsDetailedReport && hasAnalyticalAction) {
    categories.push('detailed-report');
  }

  // Nếu người dùng yêu cầu sửa mã trực tiếp và không yêu cầu báo cáo chi tiết
  const isDirectCodeFixRequest = /\b(?:sua loi|fix loi|fix bug|viet code|viet ham|code giup|chinh sua file|sua file|tao file|thay the)\b/.test(
    normalized,
  ) && !requestsDetailedReport;

  const isAnalysisQuery = categories.length > 0 && !isDirectCodeFixRequest;

  return {
    isAnalysisQuery,
    categories,
  };
}

export function evaluateAnalysisOrInvestigationAnswer(
  answer: string, context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  if (!detectAnalysisOrInvestigationIntent(context?.userRequest).isAnalysisQuery) return undefined;
  if (isCompletionStub(answer)) {
    return { allow: false, reason: 'insufficient-analysis-answer', recovery: 'revise-answer',
      continuationPrompt: '[SYSTEM ANALYSIS GUARD]: Provide the findings themselves. Distinguish confirmed causes, hypotheses, and remaining uncertainty; a concise answer is valid.' };
  }
  return undefined;
}

export function evaluateCurtFinalAnswer(
  answer: string, context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  if (!context?.hasSubmittedSolution && !context?.hasCodeMutations) return undefined;
  if (!isCompletionStub(answer)) return undefined;
  return { allow: false, reason: 'curt-final-answer', recovery: 'revise-answer',
    continuationPrompt: '[SYSTEM QUALITY GUARD]: State the concrete outcome and relevant verification status, using the level of detail requested by the user.' };
}

export function detectSecurityAuditIntent(userRequest?: string): boolean {
  if (!userRequest || typeof userRequest !== 'string') return false;
  const normalized = normalizeForMatching(userRequest);
  return /\b(?:audit|kiem tra bao mat|quet lo hong|security audit|security review|vulnerability scan|pentest|tim lo hong|tim bug bao mat|kiem thu bao mat)\b/.test(
    normalized,
  );
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
        description: 'SQL Injection: Ghép trực tiếp biến đầu vào người dùng vào câu lệnh SQL (chưa dùng Parameterized Queries / Prepared Statements)',
      });
    }
  }

  // 2. Hardcoded Real Credentials / Private Keys
  const isMockToken = /dummy|mock|fake|test|example|placeholder|SAMPLE_|YOUR_|xxxx/i.test(codeSnippet);
  if (!isMockToken) {
    if (/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(codeSnippet)) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: Khóa bảo mật Private Key được nhúng trực tiếp trong mã nguồn',
      });
    } else if (/\bAKIA[0-9A-Z]{16}\b/.test(codeSnippet) && !codeSnippet.includes('AKIAIOSFODNN7EXAMPLE')) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: AWS Access Key ID thực tế được nhúng trực tiếp trong mã nguồn',
      });
    } else if (/\bghp_[a-zA-Z0-9]{36}\b/.test(codeSnippet)) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: GitHub Personal Access Token được nhúng trực tiếp trong mã nguồn',
      });
    } else if (/\bsk-[a-zA-Z0-9]{32,}\b|\bsk-ant-[a-zA-Z0-9]{32,}\b/.test(codeSnippet)) {
      vulns.push({
        type: 'hardcoded-credentials',
        description: 'Hardcoded Secret: Khóa bí mật API Key (OpenAI/Anthropic) được nhúng trực tiếp trong mã nguồn',
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
      description: 'Dangerous Execution / XSS: eval hoặc dangerouslySetInnerHTML trực tiếp từ dữ liệu người dùng mà không sanitize',
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
 * 1. Bỏ qua nếu query của user là audit / pentest / security review.
 * 2. Chỉ kích hoạt khi Agent đưa ra tuyên bố an toàn tuyệt đối (claimsAbsoluteSecurity).
 * 3. Miễn trừ nếu Agent có kèm Security Disclaimer / cảnh báo rủi ro trung thực.
 * 4. Miễn trừ các file kiểm thử (test, tests, scratch) và dummy tokens.
 */
export function evaluateInsecureCodeConfidence(
  answer: string,
  context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  // 1. Miễn trừ nếu người dùng yêu cầu security audit / pentest / scan lỗ hổng
  if (detectSecurityAuditIntent(context?.userRequest)) {
    return undefined;
  }

  // 2. Fast Path: Nếu Agent không đưa ra khẳng định an toàn tuyệt đối, bỏ qua ngay
  if (!claimsAbsoluteSecurity(answer)) {
    return undefined;
  }

  // 3. Miễn trừ nếu Agent có cảnh báo / disclaimer trung thực về bảo mật
  if (hasSecurityDisclaimer(answer)) {
    return undefined;
  }

  // 4. Thu thập các đoạn mã cần kiểm tra
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
        '[SYSTEM SECURITY GUARD]: Phản hồi của bạn bị TỪ CHỐI do hiện tượng "Tự tin thái quá vào code nhiễm độc" (Insecure Code Confidence).',
        'Bạn đã tuyên bố đoạn mã là "hoàn toàn an toàn" hoặc "đã tối ưu bảo mật", nhưng mã nguồn lại chứa lỗ hổng bảo mật nghiêm trọng kinh điển:',
        ...allVulns.map((v) => `- ${v.description}`),
        'HƯỚNG DẪN KHẮC PHỤC:',
        '1. Nếu đây là code đưa vào vận hành: Bắt buộc sửa chữa lỗ hổng (dùng Parameterized Query / Prepared Statements, đưa Secret vào biến môi trường, hoặc sanitize đầu vào).',
        '2. HOẶC nếu đây là mã minh họa / ví dụ đơn giản: Hãy nêu rõ cảnh báo rủi ro (Security Disclaimer) một cách trung thực thay vì khẳng định an toàn tuyệt đối.',
      ].join('\n'),
    };
  }

  return undefined;
}

