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
  | 'curt-final-answer';

export interface FinalAnswerGuardDecision {
  allow: boolean;
  reason?: FinalAnswerGuardRejectionReason;
  continuationPrompt?: string;
}

export interface FinalAnswerGuardContext {
  userRequest?: string;
  availableToolNames?: string[];
  hasSubmittedSolution?: boolean;
  hasCodeMutations?: boolean;
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

  // 8. Meta-reporting promises & pseudo-completion claims without body
  // e.g. "Đã cung cấp câu trả lời chi tiết và chính xác bằng tiếng Việt về nguyên nhân...",
  // "... và báo cáo chi tiết bằng tiếng Việt cho người dùng", "sẽ báo cáo chi tiết..."
  /\b(?:va\s+)?(?:se|da|vua)?\s*(?:bao cao|trinh bay|giai thich|cung cap|tra loi)\s+(?:cau tra loi\s+)?(?:chi tiet|day du|chinh xac|ro rang)(?:\s+(?:va\s+(?:chinh xac|ro rang|day du)))?(?:\s+bang tieng viet)?(?:\s+(?:cho|ve|voi)\b)/,
  /\b(?:and\s+)?(?:will|have|already)?\s*(?:report|present|explain|provide|answer)\s+(?:a |the )?(?:in detail|detailed findings|detailed report|detailed answer|detailed response)(?:\s+(?:to|for|about)\b)/,
  /\b(?:se\s+)?xac dinh (?:cac\s+)?nguyen nhan(?: tiem an)? va bao cao\b/,
  /\b(?:da|vua)\s+(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+.*?(?:nguyen nhan|ly do|khong hien thi|khong goi y)\b/,
];

const FULFILLED_INTRO_PATTERN = /^\s*(?:toi|chung toi|minh|em|i|we|agent)?\s*(?:se|will|shall|am going to|plan to|da)?[^\n]{0,140}?(?:duoi day la|ket qua|nhu sau|sau day|here is|here are|below is|results?:|as follows:)[^\n]*/i;

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

    const normalized = normalizeForMatching(answer);
    const withoutOptionalOffers = normalized.replace(OPTIONAL_OFFER_PATTERN, ' ');
    const promisesFutureToolWork = hasUnfulfilledDeferredPromise(withoutOptionalOffers);

    // 2. Chặn lời hứa hoãn việc / thông báo hứa hẹn: BẤT KỂ hasSubmittedSolution = true, KHÔNG BAO GIỜ CHO PHÉP lời hứa hoãn việc
    if (promisesFutureToolWork) {
      const failureContext = this.latestFailure
        ? `The latest tool failure was ${this.latestFailure.toolName}${this.latestFailure.errorCode ? ` (${this.latestFailure.errorCode})` : ''}${this.latestFailure.detail ? `: ${this.latestFailure.detail}` : '.'}`
        : undefined;

      return {
        allow: false,
        reason: 'deferred-work',
        continuationPrompt: [
          '[SYSTEM FINAL ANSWER GUARD]: Your previous response described work you will do later, or merely announced an intention to report without providing the actual detailed report. It was not accepted as a final answer.',
          'Provide the complete, detailed findings and analysis now, or continue the work with the appropriate tools.',
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
    if (archDecision) return archDecision;

    // 5. Kiểm định tính chuyên sâu cho query điều tra nguyên nhân / phân tích sự cố
    const analysisDecision = evaluateAnalysisOrInvestigationAnswer(answer, context);
    if (analysisDecision) return analysisDecision;

    // 5b. Chặn câu trả lời cộc lốc / cụt ngủn cho tác vụ đã hoàn tất hoặc có can thiệp mã nguồn
    const curtDecision = evaluateCurtFinalAnswer(answer, context);
    if (curtDecision) return curtDecision;

    // 6. Nếu đã submit_solution thành công và vượt qua toàn bộ các kiểm định chất lượng trên
    if (context?.hasSubmittedSolution) {
      return { allow: true };
    }

    return { allow: true };
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
  if (!workspace || !workspace.rootDir) {
    return { isGrounded: true, validFiles: [], invalidFiles: [], reasons: [] };
  }

  // Quét các đường dẫn file được đề cập trong câu trả lời
  const pathRegex = /(?:^|[\s`('"])([a-zA-Z0-9_.-]+(?:[\/\\][a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]+|package\.json|tsconfig\.json|README\.md)(?:[\s`')"]|$)/gm;
  const rawCandidates = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pathRegex.exec(answer)) !== null) {
    const raw = match[1].replace(/^[('"`]|['"`)]$/g, '').trim();
    if (!raw.startsWith('http') && !raw.includes('node_modules') && !raw.startsWith('file://')) {
      rawCandidates.add(raw.replace(/\\/g, '/'));
    }
  }

  const fileUrlRegex = /file:\/\/\/[^\s`"')]+/g;
  while ((match = fileUrlRegex.exec(answer)) !== null) {
    const rawUrl = match[0].replace(/^file:\/\/\//, '');
    rawCandidates.add(rawUrl.replace(/\\/g, '/'));
  }

  const validFiles: string[] = [];
  const invalidFiles: string[] = [];

  for (const candidate of rawCandidates) {
    try {
      let resolved: string;
      if (path.isAbsolute(candidate)) {
        resolved = candidate;
      } else if (workspace.resolveSafePath) {
        resolved = workspace.resolveSafePath(candidate);
      } else {
        resolved = path.resolve(workspace.rootDir, candidate);
      }

      if (fs.existsSync(resolved)) {
        validFiles.push(candidate);
      } else if (
        candidate.startsWith('src/') ||
        candidate.startsWith('lib/') ||
        candidate.startsWith('app/') ||
        candidate.startsWith('deploy/') ||
        candidate.startsWith('docs/')
      ) {
        invalidFiles.push(candidate);
      }
    } catch {
      if (
        candidate.startsWith('src/') ||
        candidate.startsWith('lib/') ||
        candidate.startsWith('app/') ||
        candidate.startsWith('deploy/') ||
        candidate.startsWith('docs/')
      ) {
        invalidFiles.push(candidate);
      }
    }
  }

  const reasons: string[] = [];
  if (validFiles.length === 0) {
    reasons.push(
      'Câu trả lời phân tích không viện dẫn bất kỳ tệp nguồn hay module nào thực tế tồn tại trong workspace (thiếu empirical workspace grounding).',
    );
  }
  if (invalidFiles.length > 0 && validFiles.length === 0) {
    reasons.push(
      `Câu trả lời viện dẫn các đường dẫn tệp không tồn tại trong workspace: ${invalidFiles.slice(0, 3).join(', ')}.`,
    );
  }

  return {
    isGrounded: validFiles.length > 0,
    validFiles,
    invalidFiles,
    reasons,
  };
}

/**
 * Đánh giá tính chuyên sâu, cấu trúc và tính có căn cứ thực tế của bài phân tích kiến trúc / workflow.
 */
export function evaluateArchitectureAnalysis(
  answer: string,
  context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  const intent = detectArchitectureAnalysisIntent(context?.userRequest);
  if (!intent.isArchitectureQuery) return undefined;

  const trimmed = answer.trim();
  const deficiencies: string[] = [];

  // 1. Tiêu chí độ dài tối thiểu: Một phân tích kiến trúc nghiêm túc tối thiểu phải từ 500 ký tự trở lên
  if (trimmed.length < 500) {
    deficiencies.push(
      `Phản hồi quá ngắn (${trimmed.length} ký tự, yêu cầu tối thiểu 500 ký tự). Yêu cầu phân tích kiến trúc/workflow/pattern không được tóm tắt cụt ngủn hoặc trả lời sơ sài.`,
    );
  }

  // 2. Tiêu chí cấu trúc phân tích cốt lõi (Ít nhất 2 trong 4 khía cạnh)
  const normalized = normalizeForMatching(answer);
  const structuralSections = {
    overview: /\b(?:tong quan|muc tieu|nhiem vu|gioi thieu|boi canh|overview|introduction|architecture overview|high-level|system overview)\b/.test(
      normalized,
    ),
    workflow: /\b(?:workflow|luong|quy trinh|lifecycle|flow|sequence|cac buoc|buoc 1|step 1|dataflow|execution flow)\b/.test(
      normalized,
    ),
    pattern: /\b(?:pattern|mau thiet ke|layer|tang|module|component|thanh phan|kien truc)\b/.test(
      normalized,
    ),
    invariantsOrFiles: /\b(?:bat bien|invariant|guardrail|loi|error|file|ma nguon|source|src\/)\b/.test(
      normalized,
    ),
  };

  const sectionsCount = Object.values(structuralSections).filter(Boolean).length;
  if (sectionsCount < 2) {
    deficiencies.push(
      'Thiếu cấu trúc phân tích chuyên sâu. Bài phân tích bắt buộc phải có các mục phân cấp rõ ràng (Tổng quan hệ thống/nghiệp vụ, Luồng workflow/thực thi, Các Pattern/Component cốt lõi, và Bất biến/File nguồn dẫn chứng).',
    );
  }

  // 3. Tiêu chí kiểm định thực tế trong workspace (Grounding Verification)
  if (context?.workspace) {
    const grounding = verifyWorkspaceGrounding(answer, context.workspace);
    if (!grounding.isGrounded) {
      deficiencies.push(...grounding.reasons);
    }
  }

  if (deficiencies.length === 0) {
    return undefined; // Đạt chuẩn
  }

  return {
    allow: false,
    reason: 'insufficient-architecture-answer',
    continuationPrompt: [
      '[SYSTEM ARCHITECTURE GUARD]: Phản hồi của bạn bị TỪ CHỐI vì chưa đạt tiêu chuẩn phân tích kiến trúc, workflow, pattern hoặc nghiệp vụ của workspace.',
      'Các khiếm khuyết được phát hiện:',
      ...deficiencies.map((d) => `- ${d}`),
      '',
      'TIÊU CHUẨN BẮT BUỘC KHI PHÂN TÍCH KIẾN TRÚC & WORKFLOW (FULL-OUTPUT CODEX STANDARD):',
      '1. DẪN CHỨNG MÃ NGUỒN THỰC TẾ: Bạn PHẢI viện dẫn các file thực tế trong workspace (sử dụng read_file / search_text / query_call_graph nếu chưa khảo sát). Tuyệt đối không bịa đặt đường dẫn file hoặc thư viện ngoài.',
      '2. CẤU TRÚC BÀI PHÂN TÍCH ĐẦY ĐỦ:',
      '   - ## 1. Tổng quan & Sứ mệnh hệ thống (System Overview & Architecture Style)',
      '   - ## 2. Cơ chế & Luồng thực thi chi tiết (End-to-End Workflow / Sequence Trace)',
      '   - ## 3. Mẫu thiết kế & Trách nhiệm các thành phần (Design Patterns with File Anchors)',
      '   - ## 4. Bất biến hệ thống, Rào chắn bảo vệ & Đánh đổi kỹ thuật (System Invariants & Guardrails)',
      '3. KHÔNG RÚT GỌN: Nghiêm cấm câu trả lời cụt ngủn, cấm dùng placeholder như "...", "để ngắn gọn", "v.v.". Hãy viết đầy đủ, mạch lạc bằng đúng ngôn ngữ của người dùng.',
    ].join('\n'),
  };
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
  const requestsDetailedReport = /\b(?:bao cao|trinh bay|chi tiet|day du|tieng viet|report|in detail|detailed)\b/.test(
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
  answer: string,
  context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  const intent = detectAnalysisOrInvestigationIntent(context?.userRequest);
  if (!intent.isAnalysisQuery) return undefined;

  const trimmed = answer.trim();

  // 1. Tiêu chuẩn độ dài tối thiểu: Một báo cáo phân tích/điều tra nguyên nhân phải từ 300 ký tự trở lên
  if (trimmed.length < 300) {
    return {
      allow: false,
      reason: 'insufficient-analysis-answer',
      continuationPrompt: [
        '[SYSTEM ANALYSIS GUARD]: Phản hồi của bạn bị TỪ CHỐI vì quá ngắn và sơ sài so với yêu cầu điều tra / phân tích nguyên nhân của người dùng.',
        `Độ dài phản hồi: ${trimmed.length} ký tự (yêu cầu tối thiểu 300 ký tự có phân tích thực tế).`,
        'Yêu cầu của người dùng là điều tra nguyên nhân và báo cáo chi tiết. Bạn KHÔNG ĐƯỢC chỉ đưa ra 1-2 câu tóm tắt hoặc thông báo hứa hẹn.',
        'Hãy trình bày đầy đủ:',
        '1. Các nguyên nhân tiềm ẩn hoặc cơ chế gây lỗi (kèm trích dẫn hàm, file cụ thể).',
        '2. Luồng thực thi / phân tích logic chi tiết.',
        '3. Hướng khắc phục hoặc giải pháp đề xuất.',
      ].join('\n'),
    };
  }

  // 2. Chặn câu echo stub / hứa hẹn không có thân bài (Meta-Reporting Stub / Pseudo-Completion Claim)
  const normalized = normalizeForMatching(answer);
  const isMetaEchoOnly = trimmed.length < 450 && (
    /\b(?:va\s+)?(?:se\s+)?bao cao chi tiet(?:\s+bang tieng viet)?(?:\s+cho nguoi dung)?\.?$/i.test(normalized) ||
    /\b(?:xac dinh (?:cac\s+)?nguyen nhan(?: tiem an)? va bao cao)\b/i.test(normalized) ||
    /\b(?:da|vua)\s+(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+.*?(?:nguyen nhan|ly do|khong hien thi|khong goi y)\b/i.test(normalized) ||
    /\b(?:da|vua)?\s*(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+(?:cau tra loi\s+)?(?:chi tiet|chinh xac|day du)/i.test(normalized)
  ) && !/[-*•\d]\.\s|```|\*\*|###/.test(answer);

  if (isMetaEchoOnly) {
    return {
      allow: false,
      reason: 'insufficient-analysis-answer',
      continuationPrompt: [
        '[SYSTEM ANALYSIS GUARD]: Phản hồi của bạn bị TỪ CHỐI vì chỉ là câu thông báo hoàn tất suông ("Đã cung cấp câu trả lời...", "sẽ báo cáo chi tiết...") mà không có nội dung phân tích thực tế.',
        'Hãy viết trực tiếp bản phân tích chi tiết cho người dùng ngay tại đây với các mục phân tích cụ thể, mã nguồn liên quan và giải pháp đề xuất.',
      ].join('\n'),
    };
  }

  return undefined;
}

/**
 * Đánh giá tính đầy đủ của câu trả lời khi kết thúc tác vụ đã thực hiện chỉnh sửa mã hoặc submit_solution.
 * Ngăn chặn câu trả lời cộc lốc, cụt ngủn hoặc chỉ là một dòng thông báo suông ("Đã sửa xong", "Fixed", "Hoàn thành").
 */
export function evaluateCurtFinalAnswer(
  answer: string,
  context?: FinalAnswerGuardContext,
): FinalAnswerGuardDecision | undefined {
  if (!context?.hasSubmittedSolution && !context?.hasCodeMutations) return undefined;

  const trimmed = (answer || '').trim();
  const normalized = normalizeForMatching(trimmed);

  // 1. Chặn câu trả lời quá ngắn (< 30 ký tự) cho tác vụ đã có can thiệp mã hoặc submit_solution (ví dụ: "Đã sửa xong.", "Fixed.")
  if (trimmed.length < 30) {
    return {
      allow: false,
      reason: 'curt-final-answer',
      continuationPrompt: [
        '[SYSTEM QUALITY GUARD]: Câu trả lời cuối cùng của bạn quá ngắn hoặc cộc lốc so với tác vụ vừa thực hiện.',
        `Độ dài hiện tại: ${trimmed.length} ký tự (yêu cầu giải thích kỹ thuật rõ ràng).`,
        'TIÊU CHUẨN CÂU TRẢ LỜI HOÀN TẤT (FULL-OUTPUT CODEX STANDARD):',
        '1. Nêu rõ nguyên nhân cốt lõi hoặc bối cảnh vấn đề.',
        '2. Liệt kê cụ thể các tệp tin và logic đã thay đổi/bổ sung.',
        '3. Báo cáo kết quả kiểm thử/xác thực (build, test) để người dùng yên tâm.',
        '4. Trình bày tự nhiên, mạch lạc bằng đúng ngôn ngữ của người dùng (tiếng Việt). Tuyệt đối không chỉ trả về 1 dòng cụt ngủn như "Đã sửa xong" hay placeholder.',
      ].join('\n'),
    };
  }

  // 2. Chặn các câu kết thúc mang tính thủ tục suông không có nội dung kỹ thuật (ví dụ: "The task has been completed and submitted.")
  const isGenericCompletionStub =
    /^(?:da|vua)?\s*(?:hoan tat|hoan thanh|sua xong|xong|done|task completed|fixed|success|giai phap da duoc submit)\.?$/i.test(normalized) ||
    /^(?:i have|we have|agent has)?\s*(?:completed|fixed|resolved|finished|submitted)\s*(?:the task|the bug|the issue)?\.?$/i.test(normalized);

  const lacksAnyTechnicalDetail = !/(?:\/|\.ts|\.js|\.tsx|\.jsx|\.py|\.rs|\.json|\.css|\.md|```|hàm|function|class|lỗi|error|test|build|exit|evidence|step|plan|task|code)/i.test(trimmed);

  if (isGenericCompletionStub && lacksAnyTechnicalDetail) {
    return {
      allow: false,
      reason: 'curt-final-answer',
      continuationPrompt: [
        '[SYSTEM QUALITY GUARD]: Phản hồi của bạn chỉ là một câu thông báo hoàn tất hình thức mà không có giải thích kỹ thuật thực tế cho người dùng.',
        'Hãy giải thích chi tiết: vấn đề được giải quyết thế nào, các tệp tin đã thay đổi, và kết quả kiểm chứng thực nghiệm.',
      ].join('\n'),
    };
  }

  return undefined;
}
