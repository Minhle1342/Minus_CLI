import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_ANTIGRAVITY_TOOLS,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_TOOL_PLAYBOOKS,
} from './prompt-sections.js';
import { SECTION_ANTIGRAVITY_TOOLCHAIN_FULL } from './prompts.js';

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
