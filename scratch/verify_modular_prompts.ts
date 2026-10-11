import assert from 'node:assert';
import {
  CORE_SYSTEM_PROMPT,
  SECTION_PATCH_FORMAT_SPEC,
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  createStandardSystemPrompt,
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
assert(coreTokens < 1500, `Core Prompt phải dưới 1500 tokens (thực tế: ${coreTokens})`);

// 2. Kiểm tra On-Demand Patch Format Module
const patchTokens = ContextCompactor.estimateTokens(SECTION_PATCH_FORMAT_SPEC);
console.log(`[2] On-Demand Patch Format Spec: ${SECTION_PATCH_FORMAT_SPEC.length} chars (~${patchTokens} tokens)`);
assert(SECTION_PATCH_FORMAT_SPEC.includes('UNIFIED DIFF & PATCH FORMAT SPECIFICATION'), 'SECTION_PATCH_FORMAT_SPEC chứa đầy đủ đặc tả diff');
assert(SECTION_PATCH_FORMAT_SPEC.includes('1-Shot Example:'), 'SECTION_PATCH_FORMAT_SPEC chứa ví dụ 1-shot khi cần tham chiếu');

// 3. Kiểm tra tính năng Progressive Filtering qua detectPromptContext
console.log('\n[3] Kiểm tra Progressive Context Filtering & Token Reduction:');
const workspace = new Workspace(process.cwd());

// Tình huống A: Tác vụ đọc hiểu thông thường với ToolRegistry đầy đủ
const fullRegistry = new ToolRegistry();
const fullCtx = detectPromptContext(workspace, fullRegistry, 'Kiểm tra dependencies trong package.json');
assert(fullCtx.hasAntigravityTools === true, 'Nhận diện đúng tool antigravity khả dụng');
assert(fullCtx.hasCodebaseTools === true, 'Nhận diện đúng tool codebase khả dụng');

const standardPrompt = createStandardSystemPrompt(fullCtx);
const standardTokens = ContextCompactor.estimateTokens(standardPrompt);
console.log(`- Standard Turn Assembled Prompt: ${standardPrompt.length} chars (~${standardTokens} tokens)`);
assert(standardTokens < 3000, `Standard turn giữ ngân sách < 3000 tokens (thực tế: ${standardTokens})`);

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
console.log(`- Minimal Agent Assembled Prompt: ${minimalPrompt.length} chars (~${minimalTokens} tokens)`);
assert(!minimalPrompt.includes('GOOGLE ANTIGRAVITY TOOLCHAIN'), 'Không nạp Antigravity toolchain khi agent không có tool');
assert(!minimalPrompt.includes('CODEBASE ARCHITECTURE & SEMANTIC INTELLIGENCE'), 'Không nạp Codebase Intelligence khi agent không có tool');
assert(minimalTokens < standardTokens, 'Minimal agent phải nhẹ hơn standard turn');

// 6. Kiểm tra Bất biến Prefix KV-Cache
console.log('\n[6] Kiểm tra KV-Cache Prefix Invariance:');
assert(standardPrompt.startsWith('You are a fast, precise, safe coding agent') || standardPrompt.startsWith('You are a high-performance coding agent'), 'Core Invariant luôn nằm ở vị trí đầu tiên (Priority -1000)');
assert(minimalPrompt.startsWith('You are a fast, precise, safe coding agent') || minimalPrompt.startsWith('You are a high-performance coding agent'), 'Minimal Prompt duy trì tiền tố bất biến');

console.log('\n✅ TẤT CẢ CÁC KIỂM CHỨNG ĐÃ ĐẠT 100% THÀNH CÔNG!');
