import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactor } from './context-compactor.js';
import { buildReadySubmissionDirective } from './submission-readiness.js';
import {
  CORE_SYSTEM_PROMPT,
  DEFAULT_PROMPT_SECTIONS,
  SECTION_PRE_SUBMIT_EVIDENCE_AUDIT,
} from '../llm/prompt-sections.js';

test('pre-submit audit is compact and claim-focused', () => {
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /\[PRE-SUBMIT EVIDENCE AUDIT\]/);
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /Match claims to THIS turn's observed evidence/i);
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /drop unverified/i);
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /exact check run/i);
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /one pass is not the suite/i);
  assert.match(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT, /authorized work/i);

  const tokens = ContextCompactor.estimateTokens(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT);
  assert.ok(tokens <= 80, `audit expected <= 80 tokens, got ~${tokens}`);
  assert.ok(SECTION_PRE_SUBMIT_EVIDENCE_AUDIT.length <= 400, 'audit text must stay compact');
});

test('audit is submit-time only, never part of the static prompt', () => {
  assert.ok(!CORE_SYSTEM_PROMPT.includes('[PRE-SUBMIT EVIDENCE AUDIT]'), 'must not bloat the always-on core prompt');
  assert.equal(
    DEFAULT_PROMPT_SECTIONS.some((section) => section.content.includes('[PRE-SUBMIT EVIDENCE AUDIT]')),
    false,
    'must not be registered as a static section',
  );
});

test('ready-to-submit directive carries observed metadata and the audit exactly once', () => {
  const directive = buildReadySubmissionDirective({
    filesModified: ['src/a.ts'],
    verificationMethod: 'direct_validation',
  });

  assert.match(directive, /\[READY TO SUBMIT\]/);
  assert.match(directive, /Call submit_solution alone/);
  assert.match(directive, /"filesModified":\["src\/a\.ts"\]/);
  assert.match(directive, /\[PRE-SUBMIT EVIDENCE AUDIT\]/);
  assert.equal(directive.split('[PRE-SUBMIT EVIDENCE AUDIT]').length - 1, 1, 'audit must not be duplicated');
  assert.ok(directive.length < 1200, 'directive must stay small');
});
