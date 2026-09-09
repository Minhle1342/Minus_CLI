import type { Session, SessionEvent } from '../session/session.js';
import { collectCompletionObservations, hasObservedMutation, observedMutationFiles, toolResultFailed } from './completion-observations.js';
import { FILE_MUTATION_TOOLS } from '../tools/diff-generator.js';

export type EvidenceKind = 'inspection' | 'mutation' | 'verification' | 'git' | 'external' | 'other';

const MUTATION_TOOLS = FILE_MUTATION_TOOLS;

const INSPECTION_TOOLS = new Set([
  'read_file',
  'view_file',
  'list_files',
  'list_dir',
  'search_text',
  'grep_search',
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
  'query_call_graph',
  'get_route_map',
  'get_symbol_context_360',
  'get_architecture_topology',
  'lsp_query',
  'inspect_image',
  'read_shared_context',
  'recall_repository_memory',
  'verify_repository_memory',
  'discover_tools',
  'report_findings',
  'report_investigation_findings',
  'hypothesis_tool',
  'formulate_and_verify_hypothesis',
]);

const GIT_TOOLS = new Set(['git_add', 'git_commit', 'git_push', 'git_command']);
const VERIFICATION_COMMAND_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check|verify))\b|\b(?:pytest|py\.test|cargo\s+test|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\s+(?:test|check)|\.?\/?gradlew(?:\.bat)?\s+(?:test|check)|ctest|make\s+(?:test|check)|composer\s+test|bundle\s+exec\s+rspec|phpunit|tsc(?:\s|$))\b|\b(?:node|tsx|npx\s+tsx|npx\s+ts-node)\s+(?:--test\b|test\/)|\b(?:npx\s+(?:vitest|jest|mocha|ava)\b)|\bnode\s+--test\b/i;

export function isToolResultFailure(result: Record<string, any>): boolean {
  return toolResultFailed(result);
}

export function isVerificationCommand(command: unknown): boolean {
  return typeof command === 'string' && VERIFICATION_COMMAND_PATTERN.test(command.trim());
}

export function isNonExecutableFile(filePath: string): boolean {
  const normalizedPath = (filePath || '').trim().toLowerCase();
  if (!normalizedPath) return false;
  return (
    /\.(?:md|markdown|txt|rst|csv|tsv|svg|png|jpe?g|gif|webp|ico|gitignore|gitattributes|editorconfig|npmignore|dockerignore)$/i.test(normalizedPath)
    || /(?:^|[/\\])(?:\.env(?:\.[a-zA-Z0-9_-]+)?|\.gitignore|\.editorconfig|license|copying|notice)$/i.test(normalizedPath)
  );
}

export function classifyToolEvidence(
  toolName: string,
  args: Record<string, any> = {},
  result: Record<string, any> = {},
): EvidenceKind[] {
  if (isToolResultFailure(result)) return [];
  if (hasObservedMutation(toolName, result)) return ['mutation'];
  if (toolName === 'submit_solution' || toolName === 'run_test_suite') return ['verification'];
  if (toolName === 'run_command') {
    return isVerificationCommand(args.command ?? result.command) ? ['verification'] : ['other'];
  }
  if (toolName === 'get_diagnostics') {
    if (result.clean === true && (!result.totalErrors || result.totalErrors === 0)) {
      return ['inspection', 'verification'];
    }
    return ['inspection'];
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
  if (toolName === 'web_search' || toolName === 'web_fetch' || toolName === 'search_web' || toolName === 'read_url_content') {
    return ['external', 'inspection'];
  }
  if (INSPECTION_TOOLS.has(toolName)) return ['inspection'];
  return ['other'];
}

export interface CompletionEvidenceDecision {
  allow: boolean;
  reasons: string[];
  continuationPrompt?: string;
  recovery?: 'revise-answer' | 'inspect-evidence' | 'execute-task' | 'verify-changes';
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
  hasSubmittedSolution?: boolean;
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
    const hasSubmitSolutionTool = successful.some((item) => item.toolName === 'submit_solution' && item.result.seq > latestMutationSeq);
    const verifications = successful.filter(
      (item) => (item.kinds.includes('verification') || item.toolName === 'submit_solution') && item.result.seq > latestMutationSeq,
    );

    // A fresh submission certifies completion requirements, never unrelated Git or execution claims.
    const hasCertifiedSubmission = hasSubmitSolutionTool || (options.hasSubmittedSolution === true && mutations.length === 0);

    const reasons: string[] = [];

    // Thu thập đường dẫn các file đã được chỉnh sửa
    const mutatedFilePaths = mutations.flatMap((m) => observedMutationFiles(m.toolName, m.args, m.payload));
    const allMutationsAreNonExecutable = mutatedFilePaths.length > 0 && mutatedFilePaths.every(isNonExecutableFile) && mutations.every((m) => observedMutationFiles(m.toolName, m.args, m.payload).length > 0);
    const userExplicitlyExemptsTesting = Boolean(
      options.userRequest &&
      /\b(?:khong can (?:chay )?(?:test|kiem thu|build)|no test(?:ing)? required|skip test(?:ing)?|do not run tests?)\b/i.test(
        options.userRequest.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      )
    );

    if (!hasCertifiedSubmission && options.codeChangeRequired && mutations.length === 0) {
      reasons.push('The request requires a code change, but no successful mutation result exists in this turn.');
    }
    if (!hasCertifiedSubmission && (options.codeChangeRequired || mutations.length > 0) && verifications.length === 0 && !allMutationsAreNonExecutable && !userExplicitlyExemptsTesting) {
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
    const normalized = proseToScan
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();

    const sentences = normalized.split(/(?<=[.!?;\n])\s+/).map((s) => s.trim()).filter(Boolean);

    // 1. First-person verification assertion (Ưu tiên bắt buộc chứng cứ khi Agent tự nhận ở ngôi thứ nhất)
    const claimsFirstPersonVerification = sentences.some((sentence) => {
      const isDirect =
        /\b(?:i|we)\s+(?:have\s+|had\s+)?(?:just\s+|already\s+)?(?:ran|run|executed|tested|verified)\b.{0,80}\b(?:pass|passed|success|successful|green|ok)\b/.test(sentence)
        || /\b(?:i|we)\s+(?:have\s+|had\s+)?(?:just\s+)?(?:verified|confirmed)\s+that\s+.*?\b(?:pass|passed|succeeded|green)\b/.test(sentence)
        || /\b(?:toi|chung\s+toi|minh)\s+(?:da\s+|vua\s+|moi\s+)?(?:chay|thuc\s+hien|test|kiem\s+thu|kiem\s+tra|xac\s+minh)\b.{0,80}\b(?:pass|passed|thanh\s+cong|green|ok|dat)\b/.test(sentence)
        || /\b(?:toi|chung\s+toi|minh)\s+(?:da\s+|vua\s+)?(?:kiem\s+tra|xac\s+nhan)\s+(?:va\s+)?(?:thay\s+)?.*?\b(?:pass|passed|thanh\s+cong|dat)\b/.test(sentence);

      if (!isDirect) return false;

      // Loại trừ câu phủ định ("did not run tests", "chưa chạy kiểm thử", "không chạy test")
      const isNegative =
        /\b(?:did\s+not|didn't|have\s+not|haven't|not\s+yet)\s+(?:run|ran|execute|test|verify)\b/.test(sentence)
        || /\b(?:chua|khong|chua\s+kip)\s+(?:chay|test|kiem\s+thu|thuc\s+hien)\b/.test(sentence);

      return !isNegative;
    });

    // 2. General verification description (Câu mô tả kiểm thử chung)
    // Chỉ phạt nếu ngữ cảnh khẳng định kết quả của lượt chạy hiện tại,
    // bỏ qua nếu có từ chỉ CI/CD, remote, ngoại vi, hoặc quá khứ/giả định.
    const claimsCurrentTurnVerification = sentences.some((sentence) => {
      const isGeneral =
        /\b(?:test|tests|build|lint|typecheck|verification|kiem\s+thu|kiem\s+chung|bien\s+dich)\b.{0,80}\b(?:pass|passed|success|successful|green|ok|thanh\s+cong|dat)\b/.test(sentence);

      if (!isGeneral) return false;

      // Bỏ qua nếu là CI/CD, remote, hoặc môi trường ngoại vi
      const isExternal =
        /\b(?:ci|cd|ci\/cd|pipeline|github\s+actions|gitlab|jenkins|circleci|travis|docker|cloud|remote|server|staging|production|upstream)\b/.test(sentence)
        || /\b(?:tu\s+xa|ngoai\s+vi|he\s+thong\s+ci|moi\s+truong\s+staging|moi\s+truong\s+production)\b/.test(sentence);

      if (isExternal) return false;

      // Bỏ qua nếu nói về quá khứ / lịch sử test trước đó
      const isHistorical =
        /\b(?:previously|earlier|prior|before|past|old|original|history|historical|last\s+run)\b/.test(sentence)
        || /\b(?:truoc\s+do|tu\s+truoc|ban\s+dau|lich\s+su|lan\s+chay\s+truoc|cu)\b/.test(sentence);

      if (isHistorical) return false;

      // Bỏ qua nếu là câu tương lai / giả định ("will pass", "sẽ pass", "should pass")
      const isHypotheticalOrFuture =
        /\b(?:will|would|should|could|might|can|may|expect|hope)\s+(?:pass|be\s+green|succeed)\b/.test(sentence)
        || /\b(?:se|co\s+the|ky\s+vong|mong\s+doi)\s+(?:pass|thanh\s+cong|dat)\b/.test(sentence);

      if (isHypotheticalOrFuture) return false;

      // Khẳng định kết quả của lượt chạy hiện tại
      const isCurrentRunAssertion =
        /\b(?:now|all\s+tests\s+now|new\s+tests?|currently|after\s+(?:the\s+)?(?:fix|change|modification)|result\s+is\s+now)\b/.test(sentence)
        || /\b(?:hien\s+tai|gio\s+day|sau\s+khi\s+sua|tat\s+ca\s+(?:cac\s+)?test\s+deu\s+pass|ket\s+qua\s+kiem\s+thu\s+(?:dat|thanh\s+cong|pass))\b/.test(sentence)
        || /\b(?:all\s+tests?\s+passed|tests?\s+passed\s+completely|build\s+(?:and\s+test\s+)?passed|tests?:?\s*(?:\d+\s+passed|\d+\/\d+|passed\s+all))\b/.test(sentence);

      return isCurrentRunAssertion;
    });

    if (verifications.length === 0 && (claimsFirstPersonVerification || (claimsCurrentTurnVerification && (options.codeChangeRequired || mutations.length > 0)))) {
      reasons.push('The final answer claims successful verification without matching run_command evidence.');
    }
    const isFirstPersonMutationClaim = sentences.some((sentence) => {
      const isDirect =
        /\b(?:i|we)\s+(?:have\s+|had\s+)?(?:just\s+|already\s+)?(?:implemented|fixed|modified|changed|created|updated|written|wrote|patched|refactored)\b/.test(sentence)
        || /\b(?:toi|chung\s+toi|minh)\s+(?:da\s+|vua\s+|moi\s+)?(?:sua|sua\s+xong|fix|khac\s+phuc|trien\s+khai|trien\s+khai\s+xong|cap\s+nhat|tao\s+file|tao\s+moi|viet|chinh\s+sua|va\s+loi|refactor)\b/.test(sentence);

      if (!isDirect) return false;

      const isPassiveOrHistorical =
        /\b(?:was|were|is|are|been|being)\s+(?:already\s+|previously\s+)?(?:implemented|fixed|modified|changed|created|updated|written|patched)\b/.test(sentence)
        || /\b(?:already|previously)\s+(?:implemented|fixed|modified|changed|created|updated|written|patched)\b/.test(sentence)
        || /\b(?:fixed|resolved|implemented)\s+(?:upstream|earlier|previously|beforehand|in\s+(?:an?\s+)?(?:previous|earlier|past|old)\s+(?:version|commit|release|pr|issue))\b/.test(sentence)
        || /\b(?:da\s+duoc|duoc|da\s+tung\s+duoc)\s+(?:sua|sua\s+xong|trien\s+khai|cap\s+nhat|fix|khac\s+phuc|chinh\s+sua|va\s+loi|giai\s+quyet)\b/.test(sentence)
        || /\b(?:da\s+(?:sua|fix|trien\s+khai|khac\s+phuc)\s+(?:tu\s+truoc|truoc\s+do|san))\b/.test(sentence)
        || /\b(?:co\s+san|von\s+da\s+duoc|da\s+ton\s+tai\s+tu\s+truoc)\b/.test(sentence);

      return isDirect && !isPassiveOrHistorical;
    });

    if (isFirstPersonMutationClaim && mutations.length === 0 && !hasCertifiedSubmission) {
      reasons.push('The final answer claims workspace changes without a successful mutation tool result.');
    }

    const trimmedAnswer = (answer || '').trim();

    const claimsCommit = /\b(?:i\s+(?:have\s+)?committed|da\s+tao\s+commit(?:\s+moi|\s+thanh\s+cong)?|da\s+commit\s+thanh\s+cong)\b/.test(normalized);
    const hasSuccessfulCommit = successful.some((item) =>
      item.toolName === 'git_commit'
      || (item.toolName === 'git_command' && ['commit'].includes(String(item.args.subcommand || '').trim().toLowerCase()))
      || (item.toolName === 'run_command' && /\bgit\s+commit\b/i.test(String(item.args.command || '')))
    );
    if (claimsCommit && !hasSuccessfulCommit) {
      reasons.push('The final answer claims a commit without a successful git_commit result.');
    }

    const claimsPush = /\b(?:i\s+(?:have\s+)?pushed|da\s+push\s+(?:code|thanh\s+cong|len\s+repo))\b/.test(normalized);
    const hasSuccessfulPush = successful.some((item) =>
      item.toolName === 'git_push'
      || (item.toolName === 'git_command' && ['push'].includes(String(item.args.subcommand || '').trim().toLowerCase()))
      || (item.toolName === 'run_command' && /\bgit\s+push\b/i.test(String(item.args.command || '')))
    );
    if (claimsPush && !hasSuccessfulPush) {
      reasons.push('The final answer claims a push without a successful git_push result.');
    }

    const claimsBlocker = /\b(?:blocked|cannot|unable|khong the|bi chan|that bai)\b/.test(normalized);
    if (executions.length > 0 && claimsBlocker) {
      const hasInspections = successful.some((item) => item.kinds.includes('inspection'));
      const isSubstantialTechnicalExplanation = trimmedAnswer.length >= 60;

      const blockerChecks: Array<{ claimed: boolean; supported: boolean; label: string }> = [
        {
          claimed: /\b(?:test|tests|build|lint|typecheck|verification|kiem\s+thu|bien\s+dich)\b.{0,60}\b(?:that\s+bai|fail|failed|error|loi|blocked|bi\s+chan)\b/.test(normalized)
            || /\b(?:blocked|cannot|unable|khong the|bi chan|that bai)\b.{0,40}\b(?:test|tests|build|lint|typecheck|verification)\b/.test(normalized),
          supported: failures.some((item) => (item.toolName === 'run_command' && isVerificationCommand(item.args.command)) || item.toolName === 'run_test_suite'),
          label: 'verification command failure',
        },
        {
          claimed: /\b(?:git\s+)?push(?:ed)?\b.{0,40}\b(?:that\s+bai|fail|failed|error|rejected|tu\s+choi|bi\s+chan|blocked)\b/.test(normalized),
          supported: failures.some((item) =>
            item.toolName === 'git_push'
            || (item.toolName === 'git_command' && ['push'].includes(String(item.args.subcommand || '').trim().toLowerCase()))
            || (item.toolName === 'run_command' && /\bgit\s+push\b/i.test(String(item.args.command || '')))
          ),
          label: 'push command failure',
        },
        {
          claimed: /\b(?:git\s+)?commit(?:ted)?\b.{0,40}\b(?:that\s+bai|fail|failed|error|bi\s+chan|blocked)\b/.test(normalized),
          supported: failures.some((item) =>
            item.toolName === 'git_commit'
            || (item.toolName === 'git_command' && ['commit'].includes(String(item.args.subcommand || '').trim().toLowerCase()))
            || (item.toolName === 'run_command' && /\bgit\s+commit\b/i.test(String(item.args.command || '')))
          ),
          label: 'commit command failure',
        },
        {
          claimed: /\b(?:write|modify|save|ghi\s+file|chinh\s+sua\s+file)\b.{0,40}\b(?:that\s+bai|fail|failed|error|permission\s+denied|bi\s+tu\s+choi)\b/.test(normalized),
          supported: failures.some((item) => MUTATION_TOOLS.has(item.toolName)),
          label: 'workspace mutation failure',
        },
      ];

      const specificCommandClaims = blockerChecks.filter((check) => check.claimed);
      if (specificCommandClaims.length > 0) {
        for (const unsupported of specificCommandClaims.filter((check) => !check.supported)) {
          reasons.push(`The final answer reports a ${unsupported.label} blocker without a matching failed tool observation.`);
        }
      } else if (failures.length === 0 && !(hasInspections && isSubstantialTechnicalExplanation)) {
        // Chỉ phạt nếu không có tool lỗi VÀ cũng không có khảo sát mã kèm giải thích kỹ thuật hợp lệ
        reasons.push('The final answer reports a blocker, but no failed tool observation supports it.');
      }
    }

    if (reasons.length === 0) return { allow: true, reasons: [] };
    const missingMutation = Boolean(options.codeChangeRequired && mutations.length === 0);
    const missingVerification = mutations.length > 0 && verifications.length === 0 && !allMutationsAreNonExecutable && !userExplicitlyExemptsTesting;
    const recovery = missingMutation ? 'execute-task' : missingVerification ? 'verify-changes' : 'revise-answer';
    return {
      allow: false, reasons, recovery,
      continuationPrompt: [
        '[SYSTEM EVIDENCE GATE]: Completion claims do not match observed outcomes.',
        ...reasons.map((reason) => `- ${reason}`),
        missingMutation ? 'Perform the requested code change, or report the concrete blocker honestly.'
          : missingVerification ? 'Verify the changes with an appropriate check, or report the concrete verification blocker.'
            : 'Correct unsupported claims using existing evidence. Do not run tools merely to justify wording; inspect more only if needed to answer the request.',
      ].join('\n'),
    };
  }

  private executionsForTurn(session: Session, turn?: number): ObservedExecution[] {
    return collectCompletionObservations(session, turn).map((item) => ({
      ...item, kinds: classifyToolEvidence(item.toolName, item.args, item.payload),
    }));
  }

  /**
   * Kiểm tra xem trong turn (hoặc toàn bộ session) đã có ít nhất một lệnh kiểm thử thành công sau lần sửa code cuối cùng hay chưa.
   */
  hasVerifiedPassingTest(session: Session, turn?: number): boolean {
    const executions = this.executionsForTurn(session, turn);
    const successful = executions.filter((item) => !isToolResultFailure(item.payload));
    const mutations = successful.filter((item) => item.kinds.includes('mutation'));
    const latestMutationSeq = mutations.at(-1)?.result.seq ?? -1;
    return successful.some(
      (item) => item.kinds.includes('verification') && item.result.seq > latestMutationSeq,
    );
  }
}
