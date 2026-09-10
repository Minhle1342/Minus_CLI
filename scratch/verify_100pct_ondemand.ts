import assert from 'node:assert';
import { ToolSynergyAdvisor, detectBugReportIntent } from '../src/agent/tool-synergy-advisor.js';
import { resolveSubagentPromptSections, ON_DEMAND_PROMPT_MODULES, SECTION_PATCH_FORMAT_SPEC } from '../src/llm/prompts.js';

console.log('================================================================');
console.log('🧪 KIỂM CHỨNG TOÀN DIỆN 3 ĐIỂM NÂNG CẤP ON-DEMAND PROMPT (100%)');
console.log('================================================================\n');

const advisor = new ToolSynergyAdvisor();

// -----------------------------------------------------------------------------
// [1] KIỂM CHỨNG ĐIỂM 1: TỰ ĐỘNG TIÊM SECTION_PATCH_FORMAT_SPEC KHI APPLY_PATCH GẶP SỰ CỐ
// -----------------------------------------------------------------------------
console.log('--- [1] KIỂM CHỨNG APPLY_PATCH ADVISORY ---');

// Tình huống 1A: apply_patch thất bại do cú pháp sai (INVALID_PATCH)
const patchFailAdvice = advisor.advise({
  lastToolName: 'apply_patch',
  lastToolResult: { error: 'Invalid patch hunk format at line 10' },
  hasErrors: true,
});
console.log('1A. Khi apply_patch bị lỗi format:');
console.log(`- Playbook: ${patchFailAdvice.playbook}`);
console.log(`- Chứa đặc tả diff: ${patchFailAdvice.guidance.includes('UNIFIED DIFF & PATCH FORMAT SPECIFICATION')}`);
assert(patchFailAdvice.playbook === 'C_MUTATION', 'Phải duy trì Playbook C_MUTATION');
assert(patchFailAdvice.guidance.includes('UNIFIED DIFF & PATCH FORMAT SPECIFICATION'), 'Guidance phải chứa đầy đủ đặc tả diff format');
assert(patchFailAdvice.guidance.includes('1-Shot Example:'), 'Guidance phải chứa ví dụ 1-shot diff');
assert(patchFailAdvice.suggestedTools.includes('read_file'), 'Phải gợi ý read_file để lấy lại contentHash');

// Tình huống 1B: apply_patch gặp Fuzz Level 3 (FUZZY_CANDIDATE_FOUND)
const patchFuzzyAdvice = advisor.advise({
  lastToolName: 'apply_patch',
  lastToolResult: { status: 'FUZZY_CANDIDATE_FOUND', fuzzyCandidate: true },
});
console.log('\n1B. Khi apply_patch gặp FUZZY_CANDIDATE_FOUND:');
console.log(`- Playbook: ${patchFuzzyAdvice.playbook}`);
console.log(`- Chứa cảnh báo Fuzz 3: ${patchFuzzyAdvice.guidance.includes('FUZZY_CANDIDATE_FOUND')}`);
assert(patchFuzzyAdvice.guidance.includes('FUZZY_CANDIDATE_FOUND'), 'Phải cảnh báo rõ ràng về FUZZY_CANDIDATE_FOUND');
assert(patchFuzzyAdvice.guidance.includes('Disk was NOT mutated'), 'Phải nhắc nhở ổ đĩa chưa bị thay đổi');
console.log('✅ Điểm 1 ĐẠT 100%: apply_patch advisory hoạt động chính xác cho cả lỗi format và Fuzz 3.\n');

// -----------------------------------------------------------------------------
// [2] KIỂM CHỨNG ĐIỂM 2: KÍCH HOẠT 5-STAGE PROTOCOL TỪ INTENT BÁO LỖI CỦA USER
// -----------------------------------------------------------------------------
console.log('--- [2] KIỂM CHỨNG USER BUG REPORT INTENT DETECTION ---');

assert(detectBugReportIntent('Hệ thống bị lỗi crash khi ấn login') === true, 'Bắt đúng từ khóa "lỗi", "crash"');
assert(detectBugReportIntent('Please fix the bug in auth service') === true, 'Bắt đúng "fix the bug"');
assert(detectBugReportIntent('Test suite failing on step 3') === true, 'Bắt đúng "failing"');
assert(detectBugReportIntent('Phân tích kiến trúc hệ thống') === false, 'Không bắt nhầm truy vấn bình thường');

// Tình huống 2A: Người dùng báo lỗi ngay tại turn đầu tiên (chưa chạy tool nào)
const userBugAdvice = advisor.advise({
  userRequest: 'Hệ thống bị lỗi crash ở module thanh toán, sửa gấp',
});
console.log('2A. Khi user báo lỗi ở prompt mở đầu:');
console.log(`- Playbook kích hoạt: ${userBugAdvice.playbook}`);
console.log(`- Chứa 5-Stage Protocol: ${userBugAdvice.guidance.includes('[5-STAGE ROOT CAUSE PROTOCOL]')}`);
assert(userBugAdvice.playbook === 'B_DEBUGGING', 'Phải kích hoạt ngay Playbook B_DEBUGGING');
assert(userBugAdvice.guidance.includes('[5-STAGE ROOT CAUSE PROTOCOL]'), 'Phải tiêm 5-Stage Root Cause Protocol');
assert(userBugAdvice.guidance.includes('Do not guess or monkey-patch'), 'Phải cảnh báo chống monkey-patching');

// Tình huống 2B: Người dùng chỉ hỏi thăm thông tin bình thường
const normalUserAdvice = advisor.advise({
  userRequest: 'Giải thích cho tôi workflow của hệ thống',
});
console.log('\n2B. Khi user hỏi bình thường:');
console.log(`- Playbook kích hoạt: ${normalUserAdvice.playbook}`);
assert(normalUserAdvice.playbook === 'GENERAL', 'Không kích hoạt nhầm Playbook B khi không có lỗi');
console.log('✅ Điểm 2 ĐẠT 100%: Bug report intent detection kích hoạt 5-Stage Protocol tức thì.\n');

// -----------------------------------------------------------------------------
// [3] KIỂM CHỨNG ĐIỂM 3: TỰ ĐỘNG PHÂN GIẢI PROMPT CHO SUBAGENTS THEO ROLE
// -----------------------------------------------------------------------------
console.log('--- [3] KIỂM CHỨNG SUBAGENT ROLE-BASED PROMPT RESOLVER ---');

// Tình huống 3A: Subagent chuyên gia Code Writer / Refactoring (Qwen-Coder / Codestral)
const coderSections = resolveSubagentPromptSections({
  capabilities: ['code', 'refactor', 'humaneval'],
  toolNames: ['read_file', 'apply_patch', 'replace_text'],
});
const coderIds = coderSections.map((s) => s.id);
console.log(`3A. Coder Subagent Sections: [${coderIds.join(', ')}]`);
assert(coderIds.includes('core'), 'Luôn có core');
assert(coderIds.includes('patch-format-spec'), 'Coder được nạp patch-format-spec');
assert(coderIds.includes('semantic-blast-radius'), 'Coder được nạp semantic-blast-radius');
assert(!coderIds.includes('antigravity-tools'), 'Coder không bị nạp antigravity tools thừa');

// Tình huống 3B: Subagent chuyên gia Debugger / SWE-bench
const debugSections = resolveSubagentPromptSections({
  capabilities: ['swe-bench', 'debug'],
  toolNames: ['read_file', 'get_diagnostics', 'query_call_graph'],
});
const debugIds = debugSections.map((s) => s.id);
console.log(`3B. Debugger Subagent Sections: [${debugIds.join(', ')}]`);
assert(debugIds.includes('core'), 'Luôn có core');
assert(debugIds.includes('error-detective'), 'Debugger được nạp 5-Stage Error Detective Protocol');
assert(debugIds.includes('codebase-intelligence'), 'Debugger có Call Graph intelligence');

// Tình huống 3C: Subagent chuyên gia DevOps / Terminal
const devopsSections = resolveSubagentPromptSections({
  toolNames: ['run_command', 'manage_task', 'schedule'],
});
const devopsIds = devopsSections.map((s) => s.id);
console.log(`3C. DevOps Subagent Sections: [${devopsIds.join(', ')}]`);
assert(devopsIds.includes('terminal-sandbox'), 'DevOps được nạp terminal-sandbox');
assert(devopsIds.includes('antigravity-tools'), 'DevOps được nạp antigravity-tools');
assert(!devopsIds.includes('patch-format-spec'), 'DevOps không bị nạp patch-format-spec thừa');

console.log('\n✅ Điểm 3 ĐẠT 100%: Subagent Role-based Prompt Resolver phân bổ chính xác từng module chuyên biệt!');

console.log('\n================================================================');
console.log('🎉 TẤT CẢ CÁC ĐIỀU KIỆN 100% ON-DEMAND PROMPT ĐỀU ĐÃ ĐẠT CHUẨN XUẤT SẮC!');
console.log('================================================================');
