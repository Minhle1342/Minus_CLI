import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CognitiveHarness } from './cognitive-harness.js';

for (const request of ['fix error in token validation', 'Explain the module architecture']) {
  test(`explore banners stay advisory in full and compact prompts: ${request}`, () => {
    const harness = new CognitiveHarness();
    const scaffold = harness.createScaffold({ request, phase: 'explore' });
    for (const text of [harness.formatScaffoldForPrompt(scaffold), harness.formatScaffoldForCompactPrompt(scaffold)]) {
      const banner = text.split('\n').find(line => line.includes('[PHASE GOVERNANCE]'));
      assert.ok(banner, 'explore governance banner must remain visible');
      assert.ok(banner.includes('EXPLORE MODE (advisory)'));
      assert.doesNotMatch(banner, /locked|disabled|forbidden/i, 'a phase banner must not invent runtime tool permissions');
      assert.ok(banner.includes('request_phase_transition'), 'keep implementation hand-off guidance');
      assert.match(banner, /inspect/i, 'keep evidence-first guidance');
    }
  });
}
