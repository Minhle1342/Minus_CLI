import type { Session } from '../session/session.js';
import { collectCompletionObservations, observedMutationFiles } from './completion-observations.js';
import { normalizeForMatching } from './final-answer-guard.js';
import { verifyHighMinFiles } from './verify-tier-resolver.js';
import {
  CompletionEvidenceGate,
  isNonExecutableFile,
  isUserExplicitlyExemptingTests,
} from './completion-evidence.js';

export type ResolutionType =
  | 'code_fix'
  | 'code_refactor'
  | 'text_or_asset_edit'
  | 'configuration_change'
  | 'investigation_only'
  | 'feature'
  | 'other';

export type VerificationMethod =
  | 'automated_test_pass'
  | 'static_diagnostics_clean'
  | 'diff_visual_inspection'
  | 'direct_validation'
  | 'not_applicable';

export interface SubmitSolutionPayload {
  summary: string;
  rootCause?: string;
  filesModified?: string[];
  verificationEvidence?: string;
  resolutionType?: ResolutionType;
  verificationMethod?: VerificationMethod;
}

export interface GroundingAuditResult {
  allowed: boolean;
  score: number; // 0 to 100
  reconciledFilesModified: string[];
  reasons: string[];
  errorCode?: string;
  suggestion?: string;
  informationDensity: number;
  extractedEntities: string[];
}

/**
 * Trích xuất các thực thể kỹ thuật từ văn bản:
 * - Tên file / đường dẫn (src/App.tsx, package.json, /foo/bar, .env, v.v.)
 * - Ký hiệu mã nguồn / symbols trong dấu backticks hoặc quotes (`myFunc()`, "5S GROUP")
 * - Tên biến / hàm / component (PascalCase, camelCase, snake_case)
 * - Mã lỗi / Exit code / status (exit 0, 404, error code, v.v.)
 */
/**
 * Trích xuất các thực thể kỹ thuật từ văn bản:
 * - Tên file / đường dẫn (src/App.tsx, package.json, /foo/bar, .env, v.v.)
 * - Ký hiệu mã nguồn / symbols trong dấu backticks hoặc quotes (`myFunc()`, "5S GROUP")
 * - Tên biến / hàm / component (PascalCase, camelCase, snake_case)
 * - Mã lỗi / Exit code / status (exit 0, 404, error code, v.v.)
 */
export function extractTechnicalEntities(text: string): string[] {
  if (!text) return [];
  const entities = new Set<string>();

  // 1. Chuỗi trong backticks hoặc ngoặc kép: `foo()`, "5S GROUP"
  const quoted = text.matchAll(/[`"']([^`"'\n]{2,60})[`"']/g);
  for (const match of quoted) {
    if (match[1]?.trim()) entities.add(match[1].trim());
  }

  // 2. File paths (ví dụ: src/app.ts, index.html, deploy/compose.yaml, .env)
  const paths = text.matchAll(/(?:^|[\s(])([a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9_-]+|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|html|css|scss|md|py|cs|go|rs|yaml|yml|toml|sql|sh|env))\b/g);
  for (const match of paths) {
    if (match[1]?.trim()) entities.add(match[1].trim());
  }

  // 3. Exit codes: exit 0, exit 1
  const exitCodes = text.matchAll(/\bexit\s+\d+\b/gi);
  for (const match of exitCodes) {
    if (match[0]?.trim()) entities.add(match[0].trim());
  }

  // 4. Uppercase Error codes / acronyms (MSB1003, ERR_001, HTTP404, etc.)
  const acronyms = text.matchAll(/\b[A-Z]{2,}[-_0-9A-Z]+\b/g);
  for (const match of acronyms) {
    if (match[0]?.trim()) entities.add(match[0].trim());
  }

  // 5. Code identifiers: CamelCase with 2+ humps (e.g. SolutionGroundingAuditor, executeCommand) or snake_case with `_`
  const identifiers = text.matchAll(/\b([A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g);
  for (const match of identifiers) {
    if (match[1]?.trim()) entities.add(match[1].trim());
  }

  return Array.from(entities);
}

/**
 * Tính toán chỉ số Mật độ Thông tin Kỹ thuật (Technical Information Density Index):
 * Tỷ lệ giữa các thực thể kỹ thuật & hành động cụ thể so với tổng số từ.
 */
export function computeInformationDensity(text: string, entities: string[]): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  // Mỗi entity có trọng số đóng góp vào density
  const entityScore = Math.min(1.0, (entities.length * 2.5) / Math.max(1, words.length));
  return Number(entityScore.toFixed(3));
}

/**
 * Danh sách mở rộng các động từ hành động kỹ thuật cụ thể (Anh + Việt)
 */
export const CONCRETE_ACTION_VERBS_REGEX =
  /\b(?:xoa|sua|cap nhat|thay doi|tao|chinh sua|khac phuc|them|trien khai|toi uu|nang cap|cau hinh|chuyen doi|dieu chinh|khoi tao|chuan hoa|bo sung|viet lai|ghi|doc|dong bo|lap trinh|fix|fixed|delete|deleted|remove|removed|update|updated|change|changed|create|created|implement|implemented|resolve|resolved|patch|patched|add|added|replace|replaced|clean|cleaned|verify|verified|test|tested|refactor|refactored|optimize|optimized|debug|debugged|configure|configured|upgrade|upgraded|migrate|migrated|adjust|adjusted|validate|validated|revert|reverted|restore|restored|simplify|simplified|isolate|isolated|enable|enabled|disable|disabled|extract|extracted)\b/i;

/**
 * Mẫu phát hiện câu văn né tránh / hứa hẹn suông không có hành động thực nghiệm
 */
export const PURELY_EVASIVE_PHRASE_REGEX =
  /\b(?:da|vua)?\s*(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+(?:cau tra loi\s+)?(?:chi tiet|chinh xac|day du)/i;

export const FUTURE_EVASIVE_PHRASE_REGEX =
  /\b(?:se|will)\s+(?:bao cao|trinh bay|giai thich|cung cap|report|explain|present|provide)\s+(?:cau tra loi\s+)?(?:chi tiet|day du|details?|answers?)/i;

export function isPurelyEvasiveText(text: string): boolean {
  return PURELY_EVASIVE_PHRASE_REGEX.test(text) || FUTURE_EVASIVE_PHRASE_REGEX.test(text);
}

/**
 * SolutionGroundingAuditor - Bộ thẩm định Grounding thực nghiệm cho submit_solution.
 * Thay thế hoàn toàn Regex Heuristics cứng nhắc bằng cơ chế:
 * 1. Semantic Action-Entity Grounding (Thực thể kỹ thuật + Hành động cụ thể)
 * 2. Execution Ledger Reconciliation (Đối chiếu & đồng bộ với Session Mutation Proof)
 * 3. Anti-Evasive Boilerplate Filter (Chặn câu văn mẫu né tránh suông)
 */
export class SolutionGroundingAuditor {
  static audit(
    payload: SubmitSolutionPayload,
    options: {
      session?: Session;
      turn?: number;
      workspaceRoot?: string;
      userRequest?: string;
    } = {},
  ): GroundingAuditResult {
    const summary = (payload.summary || '').trim();
    const reasons: string[] = [];

    // 1. Kiểm tra trường summary bắt buộc
    if (!summary) {
      return {
        allowed: false,
        score: 0,
        reconciledFilesModified: [],
        reasons: ['Trường "summary" không được để trống.'],
        errorCode: 'EMPTY_SUMMARY',
        suggestion: 'Hãy cung cấp tóm tắt các thay đổi đã triển khai và kết quả kiểm chứng thực nghiệm.',
        informationDensity: 0,
        extractedEntities: [],
      };
    }

    // 2. Trích xuất thực thể kỹ thuật & tính Information Density
    const entities = extractTechnicalEntities(summary);
    const density = computeInformationDensity(summary, entities);

    // 3. Lấy dữ liệu mutation thực tế từ Session (nếu có)
    let sessionMutatedFiles: string[] = [];
    if (options.session) {
      const observations = collectCompletionObservations(options.session, options.turn);
      const mutations = observations.filter((item) =>
        observedMutationFiles(item.toolName, item.args, item.payload).length > 0,
      );
      sessionMutatedFiles = Array.from(
        new Set(mutations.flatMap((m) => observedMutationFiles(m.toolName, m.args, m.payload))),
      );
    }

    // 4. Đồng bộ danh sách file thay đổi (Reconcile Files Modified)
    const declaredFiles = Array.isArray(payload.filesModified)
      ? payload.filesModified.map((f) => String(f).trim()).filter(Boolean)
      : [];

    const reconciledFilesModified = Array.from(
      new Set([...declaredFiles, ...sessionMutatedFiles]),
    );

    // 4b. Đối chiếu phương pháp verify với mức ảnh hưởng đã đo:
    // Thay đổi từ ngưỡng HIGH (>= 3 file code) trở lên không được nộp bằng kiểm tra
    // bằng mắt hoặc tuyên bố suông — bắt buộc automated test pass hoặc diagnostics clean.
    // Miễn trừ nếu:
    // - Toàn bộ file thay đổi là tài liệu/asset/cấu hình tĩnh (isNonExecutableFile)
    // - Nhiệm vụ thuần văn bản/tài liệu (text_or_asset_edit, configuration_change, investigation_only)
    // - Người dùng chỉ định rõ ràng miễn trừ kiểm thử (userExplicitlyExemptsTesting)
    // - Đã có kiểm chứng thực tế trong session (automated test pass, scratch repro pass exit 0, hoặc diagnostics clean)
    const weakMethods: Array<string | undefined> = [
      undefined,
      'diff_visual_inspection',
      'direct_validation',
      'not_applicable',
    ];

    const allDocsOrNonExecutable = (
      reconciledFilesModified.length > 0
      && reconciledFilesModified.every((file) => isNonExecutableFile(file))
    ) || (
      options.session
        ? new CompletionEvidenceGate().hasOnlyNonExecutableMutations(options.session, options.turn)
        : false
    );

    const isExemptResolution =
      payload.resolutionType === 'investigation_only'
      || payload.resolutionType === 'text_or_asset_edit'
      || payload.resolutionType === 'configuration_change';

    const userExempted = isUserExplicitlyExemptingTests(options.userRequest);

    const sessionVerified = options.session
      ? (
          new CompletionEvidenceGate().hasPostFixReproductionPass(options.session, options.turn)
          || new CompletionEvidenceGate().hasVerifiedPassingTest(options.session, options.turn)
        )
      : false;

    if (
      reconciledFilesModified.length >= verifyHighMinFiles()
      && !isExemptResolution
      && !userExempted
      && weakMethods.includes(payload.verificationMethod)
      && !allDocsOrNonExecutable
      && !sessionVerified
    ) {
      return {
        allowed: false,
        score: 40,
        reconciledFilesModified,
        reasons: [
          `submit_solution bị từ chối: ${reconciledFilesModified.length} file đã đổi (ngưỡng HIGH) nhưng verificationMethod khai báo là "${payload.verificationMethod || '(trống)'}". Thay đổi mức này bắt buộc automated test pass thật, không chấp nhận kiểm tra bằng mắt hay tuyên bố suông.`,
        ],
        errorCode: 'VERIFICATION_TIER_MISMATCH',
        suggestion:
          'Hãy chạy test suite thật (npm test / pytest / go test ...) và khai báo verificationMethod là "automated_test_pass" kèm lệnh đã chạy trong verificationEvidence.',
        informationDensity: density,
        extractedEntities: entities,
      };
    }

    // 5. Kiểm tra phát hiện câu văn mẫu né tránh (Evasive Boilerplate Detection)
    const cleanNormalized = normalizeForMatching(summary).replace(/[.!?,;:]+$/g, '').trim();
    
    const isEvasivePhrase = isPurelyEvasiveText(cleanNormalized);
    const hasConcreteActionVerb = CONCRETE_ACTION_VERBS_REGEX.test(cleanNormalized);

    // Quyền phủ quyết (Veto Rule): Nếu có thực thể kỹ thuật, có file thay đổi, hoặc có rootCause rõ ràng thì KHÔNG PHẢI là stub né tránh
    const hasEvidenceOfSubstance =
      entities.length > 0 ||
      reconciledFilesModified.length > 0 ||
      Boolean(payload.rootCause && String(payload.rootCause).trim().length > 0);

    const isEvasiveStub =
      !hasEvidenceOfSubstance &&
      (isEvasivePhrase || (!hasConcreteActionVerb && summary.length < 140));

    if (isEvasiveStub && summary.length < 250 && !/[-*•\d]\.\s|```|\*\*|###/.test(summary)) {
      return {
        allowed: false,
        score: 10,
        reconciledFilesModified,
        reasons: [
          'submit_solution bị từ chối: trường "summary" chỉ chứa câu thông báo chung chung ("Đã cung cấp câu trả lời...", "sẽ báo cáo...") mà không có hành động cụ thể hay thực thể kỹ thuật nào.',
        ],
        errorCode: 'INVALID_SUMMARY_CONTENT',
        suggestion:
          'Hãy đưa trực tiếp kết quả phân tích nguyên nhân gốc rễ, vị trí phát sinh lỗi, các file đã chỉnh sửa và giải pháp cụ thể vào trường "summary".',
        informationDensity: density,
        extractedEntities: entities,
      };
    }

    // 6. Tính điểm Grounding Score
    let score = 100;
    if (sessionMutatedFiles.length > 0 && declaredFiles.length === 0) {
      score = 90;
    }

    if (entities.length > 0 || hasConcreteActionVerb || reconciledFilesModified.length > 0) {
      score = Math.max(score, 85);
    }

    return {
      allowed: true,
      score,
      reconciledFilesModified,
      reasons: [],
      informationDensity: density,
      extractedEntities: entities,
    };
  }
}
