import { FinalAnswerGuard, detectAnalysisOrInvestigationIntent, detectArchitectureAnalysisIntent } from '../src/agent/final-answer-guard.js';

console.log('--- TEST VERIFICATION: FINAL ANSWER GUARD 3-STEP FIX ---');

const guard = new FinalAnswerGuard();
let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: any) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${testName}`, detail ?? '');
    failCount++;
  }
}

// Case 1: Lỗi thực tế của người dùng: Hứa báo cáo chi tiết + echo stub + hasSubmittedSolution: true
const userPrompt1 = 'kiểm tra nguyên nhân làm cơ chế lọc và gợi ý node theo từ khóa tại tab "Trắc nghiệm AI" không hoạt động';
const modelAnswer1 = 'Đã kiểm tra và phân tích toàn diện cơ chế lọc và gợi ý node theo từ khóa tại tab "Trắc nghiệm AI" (QuizManager.filterWikiNodesByKeyword trong public/app.js). Xác định các nguyên nhân tiềm ẩn và báo cáo chi tiết bằng tiếng Việt cho người dùng.';

const res1 = guard.evaluate(modelAnswer1, {
  userRequest: userPrompt1,
  hasSubmittedSolution: true,
  availableToolNames: ['submit_solution', 'read_file', 'grep_search'],
});

assert(
  !res1.allow && (res1.reason === 'deferred-work' || res1.reason === 'insufficient-analysis-answer'),
  'Case 1: User actual case MUST BE REJECTED despite hasSubmittedSolution: true',
  res1
);

// Case 2: Lời hứa hoãn việc truyền thống ("Tôi sẽ làm ở bước sau") + hasSubmittedSolution: true
const res2 = guard.evaluate('Tôi đã submit solution, tôi sẽ viết tài liệu và kiểm thử ở bước tiếp theo.', {
  userRequest: 'Cập nhật tài liệu và kiểm thử',
  hasSubmittedSolution: true,
  availableToolNames: ['submit_solution'],
});

assert(
  !res2.allow && res2.reason === 'deferred-work',
  'Case 2: Deferred work promise MUST BE REJECTED unconditionally even with hasSubmittedSolution: true',
  res2
);

// Case 3: Câu hỏi điều tra nguyên nhân nhưng trả lời cộc lốc / thiếu cấu trúc / < 300 chars
const userPrompt3 = 'Điều tra nguyên nhân tại sao node không hiện';
const modelAnswer3 = 'Nguyên nhân là do hàm filter lọc sai keyword.';
const res3 = guard.evaluate(modelAnswer3, {
  userRequest: userPrompt3,
  hasSubmittedSolution: true,
});

assert(
  !res3.allow && res3.reason === 'insufficient-analysis-answer',
  'Case 3: Short/unsubstantiated analysis answer (<300 chars) MUST BE REJECTED',
  res3
);

// Case 4: Câu hỏi điều tra nguyên nhân có phân tích chi tiết, đầy đủ cấu trúc >= 300 chars
const userPrompt4 = 'Điều tra nguyên nhân tại sao node không hiện trên giao diện';
const modelAnswer4 = `### Kết quả phân tích và điều tra nguyên nhân
1. **Nguyên nhân cốt lõi**: Hàm \`filterWikiNodesByKeyword\` trong file \`public/app.js\` đang thực hiện so sánh chuỗi phân biệt hoa thường (case-sensitive) mà không chuẩn hóa đầu vào. Khi người dùng nhập từ khóa chữ thường, hàm không thể khớp với tên node chứa chữ hoa.
2. **Vị trí phát sinh lỗi**: Dòng 142 trong tệp \`public/app.js\`, biểu thức \`node.title.includes(keyword)\` thiếu lời gọi \`.toLowerCase()\`.
3. **Phương án khắc phục**: Chuẩn hóa cả \`node.title\` và \`keyword\` về chữ thường trước khi so sánh, đồng thời kiểm tra chuỗi rỗng trước khi lọc.
4. **Đánh giá rủi ro**: Sửa đổi chỉ tác động cục bộ đến bộ lọc cây tri thức, không làm ảnh hưởng đến cơ chế hiển thị gốc.`;

const res4 = guard.evaluate(modelAnswer4, {
  userRequest: userPrompt4,
  hasSubmittedSolution: true,
});

assert(
  res4.allow === true,
  'Case 4: Comprehensive analysis answer (>=300 chars with root cause/analysis/solution) MUST BE ALLOWED',
  res4
);

// Case 5: Báo cáo có mở đầu "báo cáo chi tiết như sau:" và có nội dung thực tế đi kèm
const modelAnswer5 = `Dưới đây là báo cáo chi tiết như sau:
Hệ thống xử lý sự kiện theo 3 bước tuần tự:
- Bước 1: Tiếp nhận payload từ nguồn gọi và xác thực schema đầu vào.
- Bước 2: Đẩy message vào hàng đợi nội bộ để xử lý bất đồng bộ.
- Bước 3: Ghi nhận nhật ký trạng thái xử lý vào sổ cái EffectLedger.`;

const res5 = guard.evaluate(modelAnswer5, {
  userRequest: 'Tóm tắt luồng xử lý sự kiện',
  hasSubmittedSolution: true,
});

assert(
  res5.allow === true,
  'Case 5: Fulfilled introduction ("như sau:") with body MUST BE ALLOWED',
  res5
);

// Case 6: Regression - Code task bình thường có hasSubmittedSolution: true
const res6 = guard.evaluate('Đã triển khai hoàn tất hàm tính tổng sum(a, b) và các bài unit test liên quan đều đã chạy thành công.', {
  userRequest: 'Tạo hàm sum(a, b)',
  hasSubmittedSolution: true,
});

assert(
  res6.allow === true,
  'Case 6: Standard code completion with hasSubmittedSolution: true MUST BE ALLOWED',
  res6
);

// Case 7: Test-suite line 5531 exact check: 'Bây giờ tôi sẽ tổng kết kết quả cho bạn'
const res7 = guard.evaluate('Bây giờ tôi sẽ tổng kết kết quả cho bạn', { hasSubmittedSolution: true });
assert(
  res7.allow === true,
  'Case 7: Test-suite line 5531 regression check MUST BE ALLOWED',
  res7
);

// Case 8: Câu bị lọt mới của người dùng: "Đã cung cấp câu trả lời chi tiết và chính xác..." (Pseudo-completion claim)
const userPrompt8 = 'khu vực chọn trang không hiển thị gợi ý khi nhập từ khóa trong tab Trắc nghiệm AI';
const modelAnswer8 = 'Đã cung cấp câu trả lời chi tiết và chính xác bằng tiếng Việt về nguyên nhân khiến khu vực chọn trang không hiển thị gợi ý khi nhập từ khóa trong tab Trắc nghiệm AI.';
const res8 = guard.evaluate(modelAnswer8, {
  userRequest: userPrompt8,
  hasSubmittedSolution: true,
});

assert(
  !res8.allow && (res8.reason === 'deferred-work' || res8.reason === 'insufficient-analysis-answer'),
  'Case 8: Newly reported pseudo-completion claim MUST BE REJECTED by FinalAnswerGuard',
  res8
);

// Case 9: Kiểm tra detectAnalysisOrInvestigationIntent nhận diện đúng prompt lỗi không hiển thị/không gợi ý
const intent8 = detectAnalysisOrInvestigationIntent(userPrompt8);
assert(
  intent8.isAnalysisQuery === true && intent8.categories.includes('malfunction-investigation'),
  'Case 9: detectAnalysisOrInvestigationIntent must classify malfunction query as isAnalysisQuery = true',
  intent8
);

// Case 10: Tool-Use Guardian Pre-Call Validation chặn submit_solution với summary rác
import { ToolUseGuardian } from '../src/tools/tool-use-guardian.js';
const guardian = new ToolUseGuardian();
const preCheck = guardian.preCallValidate('submit_solution', {
  summary: modelAnswer8,
  verificationEvidence: 'empirical check passed',
});
assert(
  preCheck.valid === false && preCheck.errorCode === 'INVALID_SUMMARY_CONTENT',
  'Case 10: ToolUseGuardian preCallValidate MUST REJECT pseudo-completion summary for submit_solution',
  preCheck
);

// Case 11: submit_solution execution handler chặn summary rác
import { createSubmitSolutionTool } from '../src/tools/submit-solution.js';
import { Workspace } from '../src/workspace/workspace.js';
const fakeWs = new Workspace();
const submitTool = createSubmitSolutionTool(fakeWs);
const execResult = await submitTool.execute({
  summary: modelAnswer8,
  verificationEvidence: 'npm test',
}, fakeWs, { completionEvidenceVerified: true } as any);
assert(
  execResult.success === false && (execResult as any).errorCode === 'INVALID_SUMMARY_CONTENT',
  'Case 11: submit_solution tool MUST REJECT pseudo-completion summary during execution',
  execResult
);

console.log(`\nVerification Summary: ${passCount} passed, ${failCount} failed.`);
if (failCount > 0) {
  process.exit(1);
} else {
  console.log('ALL VERIFICATIONS PASSED SUCCESSFULLY!');
}

