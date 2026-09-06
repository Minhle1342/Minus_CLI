import assert from 'node:assert';
import {
  CORE_SYSTEM_PROMPT,
  SECTION_PATCH_FORMAT_SPEC,
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  LEGACY_MONOLITHIC_SYSTEM_PROMPT,
  ON_DEMAND_PROMPT_MODULES,
  createStandardSystemPrompt,
  SECTION_TERMINAL_SANDBOX_FULL,
  SECTION_ANTIGRAVITY_TOOLCHAIN_FULL,
  SECTION_CODEBASE_INTELLIGENCE_FULL,
  PromptAssembler,
} from '../src/llm/prompts.js';
import { ContextCompactor } from '../src/agent/context-compactor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/workspace/workspace.js';

console.log('================================================================');
console.log('🧪 KIỂM CHỨNG MODULAR PROMPT ARCHITECTURE & PROGRESSIVE DISCLOSURE');
console.log('================================================================\n');

// 1. Kiểm tra kích thước và tính tinh gọn của CORE_SYSTEM_PROMPT
const coreTokens = ContextCompactor.estimateTokens(CORE_SYSTEM_PROMPT);
console.log(`[1] Core Invariant System Prompt: ${CORE_SYSTEM_PROMPT.length} chars (~${coreTokens} tokens)`);
assert(!CORE_SYSTEM_PROMPT.includes('apply_patch 1-Shot format:'), 'Core Prompt đã loại bỏ thành công ví dụ diff 1-shot để tránh bloat');
assert(coreTokens < 900, `Core Prompt phải dưới 900 tokens (thực tế: ${coreTokens})`);

// 2. Kiểm tra On-Demand Patch Format Module
const patchTokens = ContextCompactor.estimateTokens(SECTION_PATCH_FORMAT_SPEC);
console.log(`[2] On-Demand Patch Format Spec: ${SECTION_PATCH_FORMAT_SPEC.length} chars (~${patchTokens} tokens)`);
assert(SECTION_PATCH_FORMAT_SPEC.includes('UNIFIED DIFF & PATCH FORMAT SPECIFICATION'), 'SECTION_PATCH_FORMAT_SPEC chứa đầy đủ đặc tả diff');
assert(SECTION_PATCH_FORMAT_SPEC.includes('1-Shot Example:'), 'SECTION_PATCH_FORMAT_SPEC chứa ví dụ 1-shot khi cần tham chiếu');

// 3. Kiểm tra Catalog ON_DEMAND_PROMPT_MODULES
console.log('\n[3] Catalog ON_DEMAND_PROMPT_MODULES:');
const moduleKeys = Object.keys(ON_DEMAND_PROMPT_MODULES);
console.log(`- Danh sách module có thể tham chiếu on-demand (${moduleKeys.length} modules):`);
for (const key of moduleKeys) {
  const content = (ON_DEMAND_PROMPT_MODULES as any)[key];
  const tokens = ContextCompactor.estimateTokens(content);
  console.log(`  * ${key.padEnd(28)}: ${content.length} chars (~${tokens} tokens)`);
  assert(typeof content === 'string' && content.length > 0, `Module ${key} phải có nội dung hợp lệ`);
}

// 4. Kiểm tra LEGACY_MONOLITHIC_SYSTEM_PROMPT vẫn nguyên vẹn
console.log('\n[4] Kiểm tra tính nguyên vẹn của LEGACY_MONOLITHIC_SYSTEM_PROMPT:');
const legacyTokens = ContextCompactor.estimateTokens(LEGACY_MONOLITHIC_SYSTEM_PROMPT);
console.log(`- Legacy Monolithic Prompt: ${LEGACY_MONOLITHIC_SYSTEM_PROMPT.length} chars (~${legacyTokens} tokens)`);
assert(LEGACY_MONOLITHIC_SYSTEM_PROMPT.includes('TERMINAL-FIRST EXPLORATION & SANDBOX EXECUTION'), 'Legacy prompt chứa section sandbox');
assert(LEGACY_MONOLITHIC_SYSTEM_PROMPT.includes('GOOGLE ANTIGRAVITY AUTONOMOUS TOOLCHAIN'), 'Legacy prompt chứa section antigravity');
assert(LEGACY_MONOLITHIC_SYSTEM_PROMPT.includes('DEEP CODEBASE ARCHITECTURE, CALL GRAPH & ROUTE INTELLIGENCE'), 'Legacy prompt chứa section call graph');
assert(LEGACY_MONOLITHIC_SYSTEM_PROMPT.includes('COMPUTER USE AGENT PROTOCOL'), 'Legacy prompt chứa section computer use');

// 5. Kiểm tra tính năng Progressive Filtering qua detectPromptContext
console.log('\n[5] Kiểm tra Progressive Context Filtering & Token Reduction:');
const workspace = new Workspace(process.cwd());

// Tình huống A: Tác vụ đọc hiểu thông thường với ToolRegistry đầy đủ
const fullRegistry = new ToolRegistry();
const fullCtx = detectPromptContext(workspace, fullRegistry, 'Kiểm tra dependencies trong package.json');
assert(fullCtx.hasAntigravityTools === true, 'Nhận diện đúng tool antigravity khả dụng');
assert(fullCtx.hasCodebaseTools === true, 'Nhận diện đúng tool codebase khả dụng');

const standardPrompt = createStandardSystemPrompt(fullCtx);
const standardTokens = ContextCompactor.estimateTokens(standardPrompt);
const savingsVsLegacy = ((legacyTokens - standardTokens) / legacyTokens) * 100;
console.log(`- Standard Turn Assembled Prompt: ${standardPrompt.length} chars (~${standardTokens} tokens)`);
console.log(`  -> Tiết kiệm so với Legacy Monolith: ${savingsVsLegacy.toFixed(1)}%`);
assert(savingsVsLegacy > 70, `Phải tiết kiệm > 70% so với legacy (thực tế: ${savingsVsLegacy.toFixed(1)}%)`);

// Tình huống B: Agent tối giản (chỉ có tool đọc file cơ bản, không có Antigravity Tools hay Codebase Tools)
const minimalCtx: any = {
  workspace,
  toolNames: ['read_file', 'list_files'],
  hasAntigravityTools: false,
  hasCodebaseTools: false,
  hasComputerTool: false,
  hasGitTools: false,
  hasSubagentTools: false,
  isFrontend: false,
  isUnity: false,
  isArchitectureAnalysis: false,
};
const minimalPrompt = createStandardSystemPrompt(minimalCtx);
const minimalTokens = ContextCompactor.estimateTokens(minimalPrompt);
const savingsMinimal = ((legacyTokens - minimalTokens) / legacyTokens) * 100;
console.log(`- Minimal Agent Assembled Prompt: ${minimalPrompt.length} chars (~${minimalTokens} tokens)`);
console.log(`  -> Tiết kiệm so với Legacy Monolith: ${savingsMinimal.toFixed(1)}%`);
assert(!minimalPrompt.includes('GOOGLE ANTIGRAVITY TOOLCHAIN'), 'Không nạp Antigravity toolchain khi agent không có tool');
assert(!minimalPrompt.includes('CODEBASE ARCHITECTURE & SEMANTIC INTELLIGENCE'), 'Không nạp Codebase Intelligence khi agent không có tool');
assert(savingsMinimal > 75, `Minimal agent phải tiết kiệm > 75% (thực tế: ${savingsMinimal.toFixed(1)}%)`);

// 6. Kiểm tra Bất biến Prefix KV-Cache
console.log('\n[6] Kiểm tra KV-Cache Prefix Invariance:');
assert(standardPrompt.startsWith('You are a high-performance coding agent'), 'Core Invariant luôn nằm ở vị trí đầu tiên (Priority -1000)');
assert(minimalPrompt.startsWith('You are a high-performance coding agent'), 'Minimal Prompt duy trì tiền tố bất biến');

console.log('\n✅ TẤT CẢ CÁC KIỂM CHỨNG ĐÃ ĐẠT 100% THÀNH CÔNG!');
