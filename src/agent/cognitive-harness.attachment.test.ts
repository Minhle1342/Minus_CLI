import assert from 'node:assert/strict';
import test from 'node:test';
import { CognitiveHarness } from './cognitive-harness.js';

test('attachment anchors inject anchor rule into explore scaffold', () => {
  const harness = new CognitiveHarness();
  const scaffold = harness.createScaffold({
    request: 'Fix bug in @src/agent/agent-loop.ts',
    phase: 'explore',
    hasAttachments: true,
    anchorPaths: ['src/agent/agent-loop.ts'],
  });
  assert.ok(scaffold.negativeGate.some((gate) => gate.includes('ATTACHMENT ANCHOR RULE')));
  assert.ok(scaffold.negativeGate.some((gate) => gate.includes('src/agent/agent-loop.ts')));
  assert.ok(scaffold.executionTopology[0]?.startsWith('Attachment Neighborhood Expansion'));
});

test('attachment anchors inject anchor rule into implement scaffold', () => {
  const harness = new CognitiveHarness();
  const scaffold = harness.createScaffold({
    request: 'Fix bug in @src/agent/agent-loop.ts',
    phase: 'implement',
    hasAttachments: true,
    anchorPaths: ['src/agent/agent-loop.ts'],
  });
  assert.ok(scaffold.negativeGate.some((gate) => gate.includes('ATTACHMENT ANCHOR RULE')));
  assert.ok(scaffold.executionTopology[0]?.startsWith('Attachment Neighborhood Expansion'));
});

test('no attachments leaves scaffold untouched', () => {
  const harness = new CognitiveHarness();
  for (const phase of ['plan', 'explore', 'implement'] as const) {
    const scaffold = harness.createScaffold({ request: 'Fix bug', phase });
    assert.ok(scaffold.negativeGate.every((gate) => !gate.includes('ATTACHMENT ANCHOR RULE')), phase);
    assert.ok(scaffold.executionTopology.every((step) => !step.startsWith('Attachment Neighborhood Expansion')), phase);
  }
});
