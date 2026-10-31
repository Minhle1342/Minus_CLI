import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND_LAUNCH_RULE,
  CORE_SYSTEM_PROMPT,
  DEFAULT_PROMPT_SECTIONS,
  FILE_MUTATION_SAFETY_RULE,
  PROACTIVE_SERVER_LAUNCH_RULE,
  SECTION_ANTIGRAVITY_TOOLS,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
  SECTION_PHASE_EXPLORE_GUIDANCE,
  SECTION_PHASE_EXPLORE_READONLY_GUIDANCE,
  SECTION_PHASE_IMPLEMENT_GUIDANCE,
  SECTION_PHASE_PLAN_GUIDANCE,
  SECTION_PHASE_RELEASE_GUIDANCE,
  SECTION_PHASE_VERIFY_GUIDANCE,
  SECTION_PRE_SUBMIT_EVIDENCE_AUDIT,
  SECTION_TOOL_PLAYBOOKS,
  clearPromptContextCache,
  detectPromptContext,
  resolveVerifyPlaybookPrompt,
} from './prompt-sections.js';
import {
  SECTION_ANTIGRAVITY_TOOLCHAIN_FULL,
  SECTION_TERMINAL_SANDBOX_FULL,
} from './prompts.js';

test('antigravity sections name the canonical web tools', () => {
  for (const section of [SECTION_ANTIGRAVITY_TOOLS, SECTION_ANTIGRAVITY_TOOLCHAIN_FULL]) {
    assert.ok(section.includes('web_search'), 'must reference web_search');
    assert.ok(section.includes('web_fetch'), 'must reference web_fetch');
    assert.ok(!section.includes('search_web'), 'must not teach hidden alias search_web');
    assert.ok(!section.includes('read_url_content'), 'must not teach hidden alias read_url_content');
  }
});

test('codebase-intelligence short section stays lean', () => {
  const bullets = SECTION_CODEBASE_INTELLIGENCE.split('\n').filter((line) => line.trim().startsWith('-'));
  assert.ok(bullets.length <= 3, `expected at most 3 bullets, got ${bullets.length}`);
});

test('tool-playbooks short section defers to dynamic playbooks', () => {
  assert.ok(SECTION_TOOL_PLAYBOOKS.length > 0, 'export must stay non-empty');
  assert.ok(!SECTION_TOOL_PLAYBOOKS.includes('Playbook D'), 'must not repeat the static chains');
  assert.ok(/dynamic|per-step|per step/i.test(SECTION_TOOL_PLAYBOOKS), 'must point at dynamic playbooks');
});

test('final-answer-receipt is an always-on static section deferring git/tool specifics', () => {
  const receipt = DEFAULT_PROMPT_SECTIONS.find((s) => s.id === 'final-answer-receipt');
  assert.ok(receipt, 'final-answer-receipt must be registered in DEFAULT_PROMPT_SECTIONS');
  assert.equal(receipt.tier, 'T2', 'receipt must live in the cache-stable static tier');
  assert.ok(!receipt.condition, 'receipt must be always-on (no condition)');
  assert.ok(receipt.priority > 550 && receipt.priority < 1000, 'receipt sits after orchestrator (550) and before the T3 tail (1000)');
  assert.ok(receipt.content.includes('FINAL ANSWER RECEIPT'), 'receipt keeps its own header');
  assert.ok(receipt.content.includes('verification actually observed'), 'receipt reuses FinalAnswerGuard vocabulary');
  assert.ok(receipt.content.includes('ask_user'), 'receipt surfaces the deferred-decision tool');
  assert.ok(!receipt.content.includes('list_files'), 'receipt must not re-teach tool chains (TOOL PLAYBOOKS own that)');
  assert.ok(!CORE_SYSTEM_PROMPT.includes('Describe causes, changes, or verification'), 'core §5 defers answer structure to the receipt');
});

test('verify-phase prompts agree: targeted tests by default, no full-suite mandate', () => {
  assert.ok(SECTION_PHASE_VERIFY_GUIDANCE.includes('- Scope:'), 'verify phase must state test scope');
  assert.ok(SECTION_PHASE_VERIFY_GUIDANCE.includes('skip unrelated suites'), 'verify phase must forbid burning cycles on unrelated suites');
  assert.ok(SECTION_PHASE_VERIFY_GUIDANCE.includes('Widen to the full suite only when the risk or the user requires it'), 'full suite stays opt-in by risk/user');
  const r2 = resolveVerifyPlaybookPrompt('R2');
  assert.ok(!r2.includes('npm test'), 'R2 playbook must not hardcode the full suite (the Scope bullet governs selection)');
  assert.ok(r2.includes('tests covering the changed code'), 'R2 playbook runs the change-relevant tests');
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /Name the exact check run and its scope/, 'pre-submit audits report scope, not suite size');
});

test('core invariant is the first cache-stable section', () => {
  const [first] = DEFAULT_PROMPT_SECTIONS;
  assert.equal(first.id, 'core');
  assert.equal(first.priority, -1000);
  assert.equal(first.tier, 'T0');
  const firstDynamic = DEFAULT_PROMPT_SECTIONS.findIndex((s) => s.tier === 'T3');
  const lastStatic = DEFAULT_PROMPT_SECTIONS.map((s) => s.tier).lastIndexOf('T2');
  assert.ok(firstDynamic === -1 || lastStatic < firstDynamic, 'static tiers must precede the dynamic tail');
});

test('dynamic sections stay under the 500-token budget', () => {
  const dynamicSections = [
    SECTION_PHASE_EXPLORE_GUIDANCE,
    SECTION_PHASE_EXPLORE_READONLY_GUIDANCE,
    SECTION_PHASE_PLAN_GUIDANCE,
    SECTION_PHASE_IMPLEMENT_GUIDANCE,
    SECTION_PHASE_VERIFY_GUIDANCE,
    SECTION_PHASE_RELEASE_GUIDANCE,
    SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
  ];
  for (const section of dynamicSections) {
    const tokens = Math.ceil(section.length / 4);
    assert.ok(tokens <= 500, `dynamic section exceeds 500 tokens (~${tokens})`);
  }
});

test('repeated run_command and file-mutation rules are single-sourced macros', () => {
  assert.ok(CORE_SYSTEM_PROMPT.includes(BACKGROUND_LAUNCH_RULE), 'CORE must reuse the background-launch macro');
  assert.ok(SECTION_ANTIGRAVITY_TOOLS.includes(PROACTIVE_SERVER_LAUNCH_RULE), 'tools section must reuse the launch macro');
  assert.ok(SECTION_TERMINAL_SANDBOX_FULL.includes(FILE_MUTATION_SAFETY_RULE), 'sandbox module must reuse the file-mutation macro');
  assert.ok(SECTION_PHASE_IMPLEMENT_GUIDANCE.includes(FILE_MUTATION_SAFETY_RULE), 'implement guidance must reuse the file-mutation macro');
  // Canonical tools: creation with write_file, modification with replace_text.
  assert.match(FILE_MUTATION_SAFETY_RULE, /`write_file` to create/, 'must bind file creation to write_file');
  assert.match(FILE_MUTATION_SAFETY_RULE, /`replace_text` to edit/, 'must bind edits to replace_text');
  assert.match(FILE_MUTATION_SAFETY_RULE, /never run `rm`/i, 'must forbid shell deletes');
});

test('project fingerprint is cached per workspace root', () => {
  clearPromptContextCache();
  const first = detectPromptContext();
  const second = detectPromptContext();
  assert.equal(second.isFrontend, first.isFrontend);
  assert.equal(second.primaryLanguage, first.primaryLanguage);
  clearPromptContextCache();
});
