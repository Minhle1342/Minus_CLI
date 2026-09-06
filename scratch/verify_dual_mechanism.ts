import { ToolRegistry } from '../src/tools/registry.js';
import { createReportFindingsTool, registerReportFindingsTool } from '../src/tools/report-findings.js';
import { FinalAnswerGuard, detectAnalysisOrInvestigationIntent } from '../src/agent/final-answer-guard.js';
import { ToolDescriptorRegistry } from '../src/control/tool-descriptor-registry.js';
import { DEFAULT_TOOL_ALTERNATIVES } from '../src/tools/tool-use-guardian.js';

async function runDualMechanismVerification() {
  console.log('===============================================================');
  console.log('🔍 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN KẾT HỢP CƠ CHẾ 1 & CƠ CHẾ 2');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${detail ? `: ${detail}` : ''}`);
      failed++;
    }
  }

  // -------------------------------------------------------------
  // Test Suite 1: Tool Registry & Metadata Registration (Cơ chế 2)
  // -------------------------------------------------------------
  console.log('--- TEST SUITE 1: Tool Registry & Metadata Registration ---');
  const registry = new ToolRegistry();
  const reportTool = registry.get('report_investigation_findings');
  assert(Boolean(reportTool), 'Tool report_investigation_findings được đăng ký mặc định trong ToolRegistry');
  assert(reportTool?.name === 'report_investigation_findings', 'Tên tool chính xác là report_investigation_findings');

  const descriptorRegistry = new ToolDescriptorRegistry();
  const descriptor = descriptorRegistry.describe(reportTool!);
  assert(Boolean(descriptor), 'Tool descriptor được tạo thành công');
  assert(descriptor?.capabilities.includes('inspect') === true, 'Descriptor có capability inspect');
  assert(descriptor?.capabilities.includes('complete') === true, 'Descriptor có capability complete');
  assert(descriptor?.phases.includes('explore') === true, 'Descriptor hỗ trợ phase explore');
  assert(descriptor?.phases.includes('release') === true, 'Descriptor hỗ trợ phase release');

  assert(
    DEFAULT_TOOL_ALTERNATIVES['submit_solution']?.includes('report_investigation_findings') === true,
    'Guardian alternatives gợi ý report_investigation_findings khi gọi submit_solution',
  );
  assert(
    DEFAULT_TOOL_ALTERNATIVES['report_investigation_findings']?.includes('submit_solution') === true,
    'Guardian alternatives gợi ý submit_solution khi cần',
  );

  // -------------------------------------------------------------
  // Test Suite 2: Schema Validation & Guardrails của report_investigation_findings
  // -------------------------------------------------------------
  console.log('\n--- TEST SUITE 2: Schema Validation của report_investigation_findings ---');
  const toolInstance = createReportFindingsTool();

  // 2.1: Thiếu rootCause hoặc quá ngắn (< 50 ký tự)
  const shortRootCauseRes = await toolInstance.execute({
    rootCause: 'Do loi selector trong code',
    affectedFilesAndSymbols: ['public/app.js'],
    evidenceTrace: 'Line 200',
    proposedSolution: 'Sua lai querySelector',
    userFacingReport: 'Báo cáo chi tiết nguyên nhân sự cố: '.repeat(10),
  });
  assert(
    shortRootCauseRes.error !== undefined && shortRootCauseRes.errorCode === 'INSUFFICIENT_ROOT_CAUSE',
    'Chặn rootCause quá ngắn (< 50 ký tự)',
    shortRootCauseRes.message,
  );

  // 2.2: Không có affectedFilesAndSymbols
  const emptyFilesRes = await toolInstance.execute({
    rootCause: 'Nguyên nhân là do bộ chọn DOM trong QuizManager không khớp với cấu trúc HTML thực tế trong tab Trắc nghiệm AI',
    affectedFilesAndSymbols: [],
    evidenceTrace: 'Line 200',
    proposedSolution: 'Sửa lại querySelector',
    userFacingReport: 'Báo cáo chi tiết nguyên nhân sự cố: '.repeat(10),
  });
  assert(
    emptyFilesRes.error !== undefined && emptyFilesRes.errorCode === 'MISSING_AFFECTED_COMPONENTS',
    'Chặn affectedFilesAndSymbols rỗng',
    emptyFilesRes.message,
  );

  // 2.3: userFacingReport quá ngắn (< 250 ký tự)
  const shortReportRes = await toolInstance.execute({
    rootCause: 'Nguyên nhân là do bộ chọn DOM trong QuizManager không khớp với cấu trúc HTML thực tế trong tab Trắc nghiệm AI',
    affectedFilesAndSymbols: ['public/app.js:QuizManager.filterWikiNodesByKeyword'],
    evidenceTrace: 'document.querySelector("#quiz-wiki-tree") trả về null',
    proposedSolution: 'Cập nhật id của cây thư mục thành #wiki-tree',
    userFacingReport: 'Đã phân tích xong nguyên nhân sự cố gây ra lỗi.',
  });
  assert(
    shortReportRes.error !== undefined && shortReportRes.errorCode === 'INSUFFICIENT_USER_REPORT',
    'Chặn userFacingReport quá ngắn (< 250 ký tự)',
    shortReportRes.message,
  );

  // 2.4: userFacingReport chứa Pseudo-Completion Claim (đủ độ dài nhưng chứa pseudo claim)
  const pseudoClaimRes = await toolInstance.execute({
    rootCause: 'Nguyên nhân là do bộ chọn DOM trong QuizManager không khớp với cấu trúc HTML thực tế trong tab Trắc nghiệm AI',
    affectedFilesAndSymbols: ['public/app.js:QuizManager.filterWikiNodesByKeyword'],
    evidenceTrace: 'document.querySelector("#quiz-wiki-tree") trả về null',
    proposedSolution: 'Cập nhật id của cây thư mục thành #wiki-tree',
    userFacingReport: 'Đã cung cấp câu trả lời chi tiết và chính xác bằng tiếng Việt về nguyên nhân khiến khu vực chọn trang không hiển thị gợi ý khi nhập từ khóa trong tab Trắc nghiệm AI. Toàn bộ các thông tin phân tích cần thiết đã được chuyển đến giao diện người dùng và tiến trình phân tích sự cố đã kết thúc thành công tốt đẹp.',
  });
  assert(
    pseudoClaimRes.error !== undefined && pseudoClaimRes.errorCode === 'PSEUDO_REPORT_REJECTED',
    'Chặn câu thông báo hứa hẹn/pseudo-completion claim trong userFacingReport',
    pseudoClaimRes.message,
  );

  // 2.5: Report hoàn chỉnh đầy đủ độ sâu kỹ thuật
  const fullValidRes = await toolInstance.execute({
    rootCause: 'Hàm filterWikiNodesByKeyword truy vấn sai DOM id của dropdown gợi ý (#quiz-page-select thay vì #quiz-node-select), dẫn tới event listener input không trigger được hàm renderSuggestions.',
    affectedFilesAndSymbols: [
      'public/app.js:QuizManager.filterWikiNodesByKeyword',
      'public/app.js:QuizManager.renderSuggestions',
      'public/index.html:#quiz-node-select',
    ],
    evidenceTrace: 'Dòng 420 trong public/app.js: const selectEl = document.getElementById("quiz-page-select"); luôn trả về null trong DOM.',
    proposedSolution: '1. Đổi getElementById("quiz-page-select") thành getElementById("quiz-node-select").\n2. Bổ sung kiểm tra null an toàn trước khi gọi appendChild.\n3. Thêm debouncing 200ms cho input event.',
    userFacingReport: `### Báo Cáo Điều Tra Sự Cố Tab Trắc Nghiệm AI

**1. Nguyên nhân gốc rễ (Root Cause):**
Khi người dùng nhập từ khóa tìm kiếm vào ô input của tab "Trắc nghiệm AI", hàm \`QuizManager.filterWikiNodesByKeyword\` trong \`public/app.js\` được kích hoạt. Tuy nhiên, hàm này đang cố gắng lấy phần tử DOM thông qua id \`#quiz-page-select\`. Trong mã HTML thực tế (\`public/index.html\`), phần tử dropdown gợi ý có id chính xác là \`#quiz-node-select\`. Do đó biến đại diện phần tử luôn mang giá trị \`null\`.

**2. Tác động và file liên quan:**
- \`public/app.js\`: Hàm \`filterWikiNodesByKeyword\` (dòng 420-445) và \`renderSuggestions\` (dòng 450-480).
- \`public/index.html\`: Khung giao diện modal trắc nghiệm.

**3. Đề xuất khắc phục:**
Cập nhật đúng selector DOM và thêm cơ chế kiểm tra an toàn trước khi render danh sách node gợi ý.`,
  });
  assert(
    fullValidRes.success === true && fullValidRes.reported === true,
    'Chấp nhận bản báo cáo hợp lệ và đầy đủ chiều sâu kỹ thuật',
  );

  // -------------------------------------------------------------
  // Test Suite 3: Intent-Aware Tool Scoping (Cơ chế 1)
  // -------------------------------------------------------------
  console.log('\n--- TEST SUITE 3: Intent-Aware Tool Scoping (Cơ chế 1) ---');
  const investigationQuery = 'Tại sao khu vực chọn trang không hiển thị gợi ý khi nhập từ khóa trong tab Trắc nghiệm AI?';
  const investigationIntent = detectAnalysisOrInvestigationIntent(investigationQuery);
  assert(investigationIntent.isAnalysisQuery === true, 'Nhận diện chính xác câu hỏi điều tra nguyên nhân (isAnalysisQuery = true)');

  // Giả lập lọc danh sách tool theo logic của AgentLoop
  const mockToolsBeforeScope = [
    { name: 'view_file' },
    { name: 'grep_search' },
    { name: 'submit_solution' },
    { name: 'report_investigation_findings' },
  ];

  // TH1: Query điều tra nguyên nhân, không có mutation
  const hasFileMutations_TH1 = false;
  const isEditRequired_TH1 = false;
  const isPureInvestigation_TH1 = investigationIntent.isAnalysisQuery && !hasFileMutations_TH1 && !isEditRequired_TH1;
  const scopedTools_TH1 = isPureInvestigation_TH1
    ? mockToolsBeforeScope.filter((t) => t.name !== 'submit_solution')
    : mockToolsBeforeScope;

  assert(
    scopedTools_TH1.some((t) => t.name === 'submit_solution') === false,
    'Cơ chế 1: submit_solution BỊ ẨN HOÀN TOÀN khi query là pure investigation',
  );
  assert(
    scopedTools_TH1.some((t) => t.name === 'report_investigation_findings') === true,
    'Cơ chế 1: report_investigation_findings VẪN HIỆN DIỆN cho agent sử dụng',
  );
  assert(
    scopedTools_TH1.some((t) => t.name === 'view_file') === true,
    'Cơ chế 1: view_file và các công cụ tra cứu vẫn đầy đủ',
  );

  // TH2: Query sửa code trực tiếp (mutation task)
  const codeFixQuery = 'Sửa lỗi selector trong public/app.js và chạy test kiểm tra';
  const codeFixIntent = detectAnalysisOrInvestigationIntent(codeFixQuery);
  const isPureInvestigation_TH2 = codeFixIntent.isAnalysisQuery && !false;
  const scopedTools_TH2 = isPureInvestigation_TH2
    ? mockToolsBeforeScope.filter((t) => t.name !== 'submit_solution')
    : mockToolsBeforeScope;

  assert(
    scopedTools_TH2.some((t) => t.name === 'submit_solution') === true,
    'Cơ chế 1: submit_solution VẪN KHẢ DỤNG khi task là sửa code (mutation task)',
  );

  // -------------------------------------------------------------
  // Test Suite 4: Final Answer Guard & Tích Hợp Auto-Finalize
  // -------------------------------------------------------------
  console.log('\n--- TEST SUITE 4: Final Answer Guard & Binding ---');
  const guard = new FinalAnswerGuard();

  // Khi agent cố tình emit pseudo-completion claim trực tiếp
  const badAnswer = 'Đã cung cấp câu trả lời chi tiết và chính xác bằng tiếng Việt về nguyên nhân khiến khu vực chọn trang không hiển thị gợi ý khi nhập từ khóa trong tab Trắc nghiệm AI.';
  const badDecision = guard.evaluate(badAnswer, {
    userRequest: investigationQuery,
    hasSubmittedSolution: false,
  });
  assert(badDecision.allow === false, 'FinalAnswerGuard chặn câu thông báo hoàn tất hình thức');

  // Khi agent lấy userFacingReport từ report_investigation_findings làm Final Answer
  const validReportFromTool = fullValidRes.userFacingReport;
  const goodDecision = guard.evaluate(validReportFromTool, {
    userRequest: investigationQuery,
    hasSubmittedSolution: true, // hasReportedFindings set effective submission state
  });
  assert(goodDecision.allow === true, 'FinalAnswerGuard chấp thuận userFacingReport chất lượng cao làm Final Answer');

  console.log('\n===============================================================');
  console.log(`📊 TỔNG KẾT: ${passed} PASS, ${failed} FAIL`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runDualMechanismVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
