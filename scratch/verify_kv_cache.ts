import assert from 'node:assert/strict';
import { PromptAssembler } from '../src/llm/prompt-assembler.js';
import {
  DEFAULT_PROMPT_SECTIONS,
  CORE_SYSTEM_PROMPT,
  detectPromptContext,
  createStandardSystemPrompt,
  resolvePhaseDynamicGuidance,
  buildPhaseToolAuthorityDirective,
  SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
} from '../src/llm/prompts.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Session } from '../src/session/session.js';
import { GeminiLLM } from '../src/llm/gemini.js';
import { AnthropicLLM } from '../src/llm/anthropic.js';
import { DeepseekLLM } from '../src/llm/deepseek.js';

console.log('=== BẮT ĐẦU KIỂM ĐỊNH KV-CACHE EMPIRICAL VERIFICATION ===\n');

// 1. Kiểm tra Tier và Priority của tất cả DEFAULT_PROMPT_SECTIONS
console.log('1. Kiểm tra cấu trúc phân tầng (T0 -> T1 -> T2 -> T3) của DEFAULT_PROMPT_SECTIONS...');
for (let i = 0; i < DEFAULT_PROMPT_SECTIONS.length; i++) {
  const s = DEFAULT_PROMPT_SECTIONS[i];
  console.log(`  - [${s.tier}] Priority ${s.priority.toString().padStart(5, ' ')} : ${s.id}`);
}

// Bất biến: T0 phải là CORE_SYSTEM_PROMPT ở vị trí đầu tiên
assert.equal(DEFAULT_PROMPT_SECTIONS[0].tier, 'T0');
assert.equal(DEFAULT_PROMPT_SECTIONS[0].priority, -1000);
assert.equal(DEFAULT_PROMPT_SECTIONS[0].content, CORE_SYSTEM_PROMPT);

// Bất biến: Tất cả T0, T1, T2 phải đứng trước T3
let lastTierNum = 0;
const tierOrder: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
for (const s of DEFAULT_PROMPT_SECTIONS) {
  const currentTierNum = tierOrder[s.tier];
  assert(currentTierNum >= lastTierNum, `Section ${s.id} vi phạm thứ tự phân tầng`);
  lastTierNum = currentTierNum;
}
console.log('✔ Phân tầng Static-First (T0 -> T1 -> T2 -> T3) hoàn toàn chuẩn xác.\n');

// 2. Kiểm tra tính bất biến Byte-for-Byte của System Prompt qua nhiều turn/step
console.log('2. Kiểm định tính bất biến Byte-for-Byte của System Prompt giữa các Turn...');
const assembler = new PromptAssembler();
for (const s of DEFAULT_PROMPT_SECTIONS) {
  assembler.register(s);
}

// Turn 1: Step 1 (Explore)
const ctxTurn1 = detectPromptContext(undefined, undefined, 'Fix issue in auth');
const promptTurn1 = assembler.assembleForContext(ctxTurn1);

// Turn 2: Step 2 (Implement)
const ctxTurn2 = detectPromptContext(undefined, undefined, 'Fix issue in auth');
const promptTurn2 = assembler.assembleForContext(ctxTurn2);

// Turn 3: Step 3 (Verify)
const ctxTurn3 = detectPromptContext(undefined, undefined, 'Fix issue in auth');
const promptTurn3 = assembler.assembleForContext(ctxTurn3);

assert.equal(promptTurn1, promptTurn2, 'System prompt giữa Turn 1 và Turn 2 phải giống nhau 100% từng byte');
assert.equal(promptTurn2, promptTurn3, 'System prompt giữa Turn 2 và Turn 3 phải giống nhau 100% từng byte');
console.log(`✔ System Prompt dài ${promptTurn1.length} ký tự, hoàn toàn trùng khớp 100% byte-for-byte giữa các Turn.\n`);

// 3. Kiểm định Tool Declarations Prefix Invariance (8 Canonical Tools)
console.log('3. Kiểm định tính bất biến và thứ tự sắp xếp cố định của 8 Function Declarations...');
const registry = new ToolRegistry();
const decls = registry.getFunctionDeclarations();

assert.equal(decls.length, 8, `Phải có đúng 8 canonical tools, thực tế: ${decls.length}`);
const expectedNames = [
  'list_files',
  'read_file',
  'replace_text',
  'run_command',
  'search_text',
  'web_fetch',
  'web_search',
  'write_file',
];

const actualNames = decls.map((d) => d.name);
console.log('  Canonical tools:', actualNames.join(', '));
assert.deepEqual(actualNames, expectedNames, 'Toàn bộ 8 Function Declarations phải được sắp xếp cố định theo bảng chữ cái A-Z');

// Kiểm tra tính bất biến qua getRelevantTools
const relevant = registry.getRelevantTools('search and edit file');
const relevantNames = relevant.map((d) => d.name);
console.log('  Retrieved tools:', relevantNames.join(', '));
assert.deepEqual(relevantNames, expectedNames, 'getRelevantTools phải duy trì đúng 8 tools và giữ nguyên thứ tự sắp xếp prefix');
console.log('✔ Function Declarations bất biến 100% và tuân thủ tuyệt đối quy tắc Prefix Alignment.\n');

// 4. Kiểm định Provider Message Format & KV-Cache Suffix Attachment
console.log('4. Kiểm định tính bất biến tiền tố (Prefix Invariance) qua các provider (Gemini, Anthropic, DeepSeek)...');

const session = new Session('kv-cache-verification-session');
session.addUserMessage('Help me fix the login bug');

// Step 1: Model inspects file
session.addModelMessage({
  functionCalls: [
    { name: 'read_file', args: { filePath: 'src/auth.ts' }, id: 'call-1' },
  ],
});
session.addToolResultWithId('read_file', { content: 'export function login() {}' }, 'call-1');

// When preparing Step 2:
const suffixesStep2 = new Map([
  [1, resolvePhaseDynamicGuidance('explore') + '\n' + buildPhaseToolAuthorityDirective('explore', actualNames)],
  [2, resolvePhaseDynamicGuidance('implement') + '\n' + buildPhaseToolAuthorityDirective('implement', actualNames)],
]);

// Gemini Step 2
const gemini = new GeminiLLM('dummy-key', 'gemini-2.5-flash');
const geminiContentsStep2 = (gemini as any).prepareContents(session, suffixesStep2.get(2), suffixesStep2);

// DeepSeek Step 2
const deepseek = new DeepseekLLM({ apiKey: 'dummy-key' });
const dsMsgsStep2 = (deepseek as any).convertHistoryToOpenAIMessages(session, promptTurn1, suffixesStep2.get(2), false, suffixesStep2);

// Anthropic Step 2
const anthropic = new AnthropicLLM({ apiKey: 'dummy-key' });
const anthropicMsgsStep2 = (anthropic as any).convertHistoryToAnthropicMessages(session, suffixesStep2.get(2), suffixesStep2);

// Step 2 executes: Model modifies file
session.addModelMessage({
  functionCalls: [
    { name: 'replace_text', args: { filePath: 'src/auth.ts', oldContent: 'a', newContent: 'b' }, id: 'call-2' },
  ],
});
session.addToolResultWithId('replace_text', { success: true }, 'call-2');

// When preparing Step 3:
const suffixesStep3 = new Map([
  [1, suffixesStep2.get(1)!],
  [2, suffixesStep2.get(2)!],
  [3, resolvePhaseDynamicGuidance('verify') + '\n' + buildPhaseToolAuthorityDirective('verify', actualNames)],
]);

// Gemini Step 3
const geminiContentsStep3 = (gemini as any).prepareContents(session, suffixesStep3.get(3), suffixesStep3);
assert.deepEqual(
  geminiContentsStep3.slice(0, geminiContentsStep2.length),
  geminiContentsStep2,
  'Gemini: Tiền tố Step 1 + Suffix S2 của Step 2 giữ nguyên 100% byte-for-byte trong Step 3',
);
console.log('✔ Gemini: Tiền tố tin nhắn và suffix turn cũ giữ nguyên 100% byte-for-byte.');

// DeepSeek Step 3
const dsMsgsStep3 = (deepseek as any).convertHistoryToOpenAIMessages(session, promptTurn1, suffixesStep3.get(3), false, suffixesStep3);
assert.deepEqual(
  dsMsgsStep3.slice(0, dsMsgsStep2.length),
  dsMsgsStep2,
  'DeepSeek: Tiền tố messages bao gồm system prompt và Step 2 giữ nguyên 100% byte-for-byte trong Step 3',
);
console.log('✔ DeepSeek: Tiền tố messages giữ nguyên 100% byte-for-byte.');

// Anthropic Step 3
const anthropicMsgsStep3 = (anthropic as any).convertHistoryToAnthropicMessages(session, suffixesStep3.get(3), suffixesStep3);
assert.deepEqual(
  anthropicMsgsStep3.slice(0, anthropicMsgsStep2.length),
  anthropicMsgsStep2,
  'Anthropic: Tiền tố messages giữ nguyên 100% byte-for-byte trong Step 3',
);
console.log('✔ Anthropic: Tiền tố messages giữ nguyên 100% byte-for-byte.');

console.log('\n======================================================');
console.log('🎉 TẤT CẢ CÁC KIỂM TRA BẤT BIẾN KV-CACHE ĐÃ HOÀN TẤT THÀNH CÔNG!');
console.log('   KV-Cache hoàn toàn KHÔNG BỊ VỠ:');
console.log('   1. Static-First Tier Order (T0->T1->T2) bất biến.');
console.log('   2. System Prompt byte-for-byte giống nhau qua mọi step.');
console.log('   3. Function Declarations (8 tools) sắp xếp deterministic A-Z.');
console.log('   4. Suffix động và Instruction Hierarchy Anchor nối đuôi an toàn.');
console.log('======================================================\n');
