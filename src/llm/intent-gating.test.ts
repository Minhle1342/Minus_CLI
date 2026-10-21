import assert from 'node:assert/strict';
import test from 'node:test';
import {
  needsFrontendGuidance,
  needsCodebaseIntelligenceGuidance,
  needsSubagentOrchestratorGuidance,
  DEFAULT_PROMPT_SECTIONS,
  PromptAssembler,
  type PromptAssemblyContext,
} from './prompts.js';

test('needsFrontendGuidance gates accurately based on workspace, query, and touched files', () => {
  // Non-frontend workspace always returns false
  assert.equal(needsFrontendGuidance('fix styling in button', ['src/button.tsx'], false), false);

  // Frontend workspace with UI keywords returns true
  assert.equal(needsFrontendGuidance('Fix button styling with tailwind', [], true), true);
  assert.equal(needsFrontendGuidance('Thay đổi màu sắc và giao diện modal', [], true), true);
  assert.equal(needsFrontendGuidance('Thêm component bảng thống kê', [], true), true);

  // Frontend workspace with UI file paths returns true even if query is neutral
  assert.equal(needsFrontendGuidance('update logic', ['src/components/Header.tsx'], true), true);
  assert.equal(needsFrontendGuidance('tinh toan', ['styles/global.css'], true), true);

  // Frontend workspace with pure backend query and non-UI files returns false
  assert.equal(needsFrontendGuidance('Fix database query in repository', ['src/db/repo.ts'], true), false);
  assert.equal(needsFrontendGuidance('', [], true), false);
});

test('needsCodebaseIntelligenceGuidance gates on codebase tools and structural query intents', () => {
  // Returns false if tools are disabled
  assert.equal(needsCodebaseIntelligenceGuidance('survey architecture', 'explore', false), false);

  // Plan phase always includes codebase intelligence
  assert.equal(needsCodebaseIntelligenceGuidance('simple fix', 'plan', true), true);

  // Structural queries return true
  assert.equal(needsCodebaseIntelligenceGuidance('explain architecture topology and call graph', 'explore', true), true);
  assert.equal(needsCodebaseIntelligenceGuidance('phân tích kiến trúc và quan hệ phụ thuộc các module', 'explore', true), true);
  assert.equal(needsCodebaseIntelligenceGuidance('calculate blast radius for symbol', 'explore', true), true);

  // Simple local questions return false
  assert.equal(needsCodebaseIntelligenceGuidance('fix typo on line 42', 'implement', true), false);
  assert.equal(needsCodebaseIntelligenceGuidance('what is 2 + 2', 'explore', true), false);
});

test('needsSubagentOrchestratorGuidance gates on subagent tools and delegation query intents', () => {
  // Returns false if no subagent tools
  assert.equal(needsSubagentOrchestratorGuidance('delegate to subagent', false, 0), false);

  // Active subagents present returns true
  assert.equal(needsSubagentOrchestratorGuidance('check progress', true, 2), true);

  // Delegation keywords return true
  assert.equal(needsSubagentOrchestratorGuidance('spawn subagent to audit code', true, 0), true);
  assert.equal(needsSubagentOrchestratorGuidance('phân rã task và ủy thác cho agent con', true, 0), true);
  assert.equal(needsSubagentOrchestratorGuidance('brainstorm with parallel agents', true, 0), true);
  // Spaced "sub agent" and natural VI phrasings must fire too.
  assert.equal(needsSubagentOrchestratorGuidance('hãy phân task cho sub agent', true, 0), true);
  assert.equal(needsSubagentOrchestratorGuidance('chia việc cho nhiều agent song song', true, 0), true);

  // Simple single-agent query returns false
  assert.equal(needsSubagentOrchestratorGuidance('read file src/index.ts', true, 0), false);
});

test('DEFAULT_PROMPT_SECTIONS condition functions support dynamic omission while defaulting to true', () => {
  const assembler = new PromptAssembler();
  for (const s of DEFAULT_PROMPT_SECTIONS) assembler.register(s);

  // Default context (all undefined) keeps legacy static behavior
  const defaultCtx: PromptAssemblyContext = {
    hasGitTools: true,
    isFrontend: true,
    hasCodebaseTools: true,
    hasSubagentTools: true,
  };
  const defaultPrompt = assembler.assembleForContext(defaultCtx);
  assert.ok(defaultPrompt.includes('GIT & TESTING RUNTIME OPERATIONS'));
  assert.ok(defaultPrompt.includes('FRONTEND & UI DESIGN STANDARD'));
  assert.ok(defaultPrompt.includes('CODEBASE ARCHITECTURE & SEMANTIC INTELLIGENCE'));
  assert.ok(defaultPrompt.includes('MULTI-AGENT ORCHESTRATION & NOT-BLOCK BOUNDARIES'));

  // Gated context with static inclusion disabled strips redundant static sections
  const gatedCtx: PromptAssemblyContext = {
    hasGitTools: true,
    isFrontend: true,
    hasCodebaseTools: true,
    hasSubagentTools: true,
    includeStaticGitOperations: false,
    includeStaticFrontendUI: false,
    includeStaticCodebaseIntelligence: false,
    includeStaticToolPlaybooks: false,
    includeStaticTaskOrchestrator: false,
  };
  const gatedPrompt = assembler.assembleForContext(gatedCtx);
  assert.ok(!gatedPrompt.includes('GIT & TESTING RUNTIME OPERATIONS'));
  assert.ok(!gatedPrompt.includes('FRONTEND & UI DESIGN STANDARD'));
  assert.ok(!gatedPrompt.includes('CODEBASE ARCHITECTURE & SEMANTIC INTELLIGENCE'));
  assert.ok(!gatedPrompt.includes('TOOL SYNERGY PLAYBOOKS:'));
  assert.ok(!gatedPrompt.includes('MULTI-AGENT ORCHESTRATION & NOT-BLOCK BOUNDARIES'));
  // Invariant Core prompt is always present
  assert.ok(gatedPrompt.includes('You are a fast, precise, safe coding agent in the terminal.'));
});
