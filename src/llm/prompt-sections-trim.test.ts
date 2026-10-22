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
  SECTION_TOOL_PLAYBOOKS,
  clearPromptContextCache,
  detectPromptContext,
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
  assert.ok(SECTION_CODEBASE_INTELLIGENCE.includes('codegraph'), 'must point at the CodeGraph policy');
});

test('tool-playbooks short section defers to dynamic playbooks', () => {
  assert.ok(SECTION_TOOL_PLAYBOOKS.length > 0, 'export must stay non-empty');
  assert.ok(!SECTION_TOOL_PLAYBOOKS.includes('Playbook D'), 'must not repeat the static chains');
  assert.ok(/dynamic|per-step|per step/i.test(SECTION_TOOL_PLAYBOOKS), 'must point at dynamic playbooks');
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
  // Regression: renaming must not degrade into delete_file (observed with gemini-3.5-flash-lite).
  assert.match(FILE_MUTATION_SAFETY_RULE, /`move_file` for renames/, 'must bind renames to move_file');
  assert.match(FILE_MUTATION_SAFETY_RULE, /never shell `mv`/, 'must forbid shell mv');
  assert.match(FILE_MUTATION_SAFETY_RULE, /never delete\+recreate/, 'must forbid delete+recreate as a rename');
});

test('project fingerprint is cached per workspace root', () => {
  clearPromptContextCache();
  const first = detectPromptContext();
  const second = detectPromptContext();
  assert.equal(second.isFrontend, first.isFrontend);
  assert.equal(second.primaryLanguage, first.primaryLanguage);
  clearPromptContextCache();
});
