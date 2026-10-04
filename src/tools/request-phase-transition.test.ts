import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchemaValue } from './schema-validator.js';
import { requestPhaseTransitionTool } from './request-phase-transition.js';

test('request_phase_transition requires concrete, schema-valid evidence', () => {
  const schema = requestPhaseTransitionTool.parameters as any;

  assert.equal(validateSchemaValue({
    targetPhase: 'implement',
    rationale: 'Inspected the exact target.',
    evidenceRefs: ['src/example.ts:12'],
  }, schema, '$', { rejectUnknownProperties: true }).valid, true);

  const invalid = validateSchemaValue({
    targetPhase: 'implement',
    rationale: '',
    evidenceRefs: [],
  }, schema, '$', { rejectUnknownProperties: true });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('rationale')));
  assert.ok(invalid.errors.some((error) => error.includes('evidenceRefs')));
});
