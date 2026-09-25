import type { Session } from '../session/session.js';
import { collectCompletionObservations, observedMutationFiles } from './completion-observations.js';
import { normalizeForMatching } from './final-answer-guard.js';
import { verifyHighMinFiles } from './verify-tier-resolver.js';

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
 * SolutionGroundingAuditor - Bộ thẩm định Grounding thực nghiệm cho submit_solution.
 * Thay thế hoàn toàn Regex Heuristics cứng nhắc bằng cơ chế:
 * 1. Semantic Action-Entity Grounding (Thực thể kỹ thuật + Hành động cụ thể)
 * 2. Execution Ledger Reconciliation (Đối chiếu & đồng bộ với Session Mutation Proof)
 * 3. Anti-Evasive Boilerplate Filter (Chặn câu văn mẫu né tránh suông)
 */
export class SolutionGroundingAuditor {
  static audit(
    payload: SubmitSolutionPayload,
    options: { session?: Session; turn?: number; workspaceRoot?: string } = {},
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

    // 4b. Đối chiếu phương pháp verify với mức ảnh hưởng đã đo (chặn "lời hứa
    // verify"): thay đổi từ ngưỡng HIGH trở lên không được nộp bằng kiểm tra
    // bằng mắt hoặc tuyên bố suông — bắt buộc automated test pass.
    const weakMethods: Array<string | undefined> = [
      undefined,
      'diff_visual_inspection',
      'direct_validation',
      'not_applicable',
    ];
    if (
      reconciledFilesModified.length >= verifyHighMinFiles()
      && payload.resolutionType !== 'investigation_only'
      && weakMethods.includes(payload.verificationMethod)
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
    
    // Câu văn mẫu né tránh: chỉ chứa cụm từ hứa hẹn/báo cáo suông mà không có bất kỳ hành động hay thực thể kỹ thuật nào
    const isPurelyEvasivePhrase =
      /\b(?:da|vua)?\s*(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+(?:cau tra loi\s+)?(?:chi tiet|chinh xac|day du)/i.test(cleanNormalized)
      || /\b(?:se|will)\s+(?:bao cao|trinh bay|giai thich|cung cap)\s+(?:chi tiet|day du)/i.test(cleanNormalized);

    const hasConcreteActionVerb =
      /\b(?:xoa|sua|cap nhat|thay doi|tao|chinh sua|khac phuc|them|trien khai|fix|fixed|delete|deleted|remove|removed|update|updated|change|changed|create|created|implement|implemented|resolve|resolved|patch|patched|add|added|replace|replaced|clean|cleaned|verify|verified|test|tested|refactor|refactored|optimize|optimized|debug|debugged)\b/i.test(
        cleanNormalized,
      );

    const isEvasiveStub = isPurelyEvasivePhrase || (!hasConcreteActionVerb && entities.length === 0 && reconciledFilesModified.length === 0 && !payload.rootCause && summary.length < 120);

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
