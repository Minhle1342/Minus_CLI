import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolUseGuardian,
  classifyToolFailure,
  DEFAULT_TOOL_ALTERNATIVES,
} from './tool-use-guardian.js';

test('tool-use-guardian: alternatives includes run_node_script (commit 18c67b2)', () => {
  assert.ok(DEFAULT_TOOL_ALTERNATIVES.run_node_script);
  assert.deepEqual(DEFAULT_TOOL_ALTERNATIVES.run_node_script, [
    'apply_patch',
    'replace_text',
    'run_command',
  ]);
});

test('tool-use-guardian: classifies failure into canonical categories', () => {
  const timeoutDiag = classifyToolFailure('run_node_script', new Error('Execution timed out after 10000ms'));
  assert.equal(timeoutDiag.category, 'API_TIMEOUT');
  assert.ok(timeoutDiag.recoveryAction.includes('Retry'));

  const schemaDiag = classifyToolFailure('submit_solution', new Error('Missing required argument: "summary" cannot be empty'));
  assert.equal(schemaDiag.category, 'SCHEMA_MISMATCH');

  const errorAs200Diag = classifyToolFailure(
    'run_command',
    undefined,
    { status: 'error', error: 'permission denied', errorCode: 'AUTH_REQUIRED' }
  );
  assert.equal(errorAs200Diag.category, 'AUTH_EXPIRED');
});

test('tool-use-guardian: pre-call validation coerces WaitMsBeforeAsync on run_command', () => {
  const guardian = new ToolUseGuardian();
  const schema = {
    type: 'OBJECT',
    properties: {
      command: { type: 'STRING' },
      WaitMsBeforeAsync: { type: 'INTEGER' },
    },
    required: ['command'],
  };

  // Agent passes waitMs (common alias)
  const validation = guardian.preCallValidate(
    'run_command',
    { command: 'npm run dev', waitMs: 5000 },
    schema
  );

  assert.equal(validation.valid, true);
  assert.equal(validation.coercedArgs?.WaitMsBeforeAsync, 5000);
});

test('tool-use-guardian: tracks failure count and flags unreliable tools after 3 consecutive failures', () => {
  const guardian = new ToolUseGuardian();
  assert.equal(guardian.isToolUnreliable('run_node_script'), false);

  guardian.recordExecution('run_node_script', { error: 'Timeout', status: 'error' }, 500);
  guardian.recordExecution('run_node_script', { error: 'Timeout', status: 'error' }, 500);
  assert.equal(guardian.isToolUnreliable('run_node_script'), false);

  guardian.recordExecution('run_node_script', { error: 'Timeout', status: 'error' }, 500);
  assert.equal(guardian.isToolUnreliable('run_node_script'), true);

  const stats = guardian.getStats('run_node_script');
  assert.deepEqual(stats.suggestedAlternatives, ['apply_patch', 'replace_text', 'run_command']);
});

test('tool-use-guardian: pre-call validation coerces old_text and new_text aliases on replace_text', () => {
  const guardian = new ToolUseGuardian();
  const schema = {
    type: 'OBJECT',
    properties: {
      path: { type: 'STRING' },
      oldText: { type: 'STRING' },
      newText: { type: 'STRING' },
    },
    required: ['path', 'oldText', 'newText'],
  };

  // Agent passes snake_case aliases instead of camelCase
  const validation = guardian.preCallValidate(
    'replace_text',
    {
      filePath: 'packages/providers/gemini/registry.py',
      old_text: 'def foo(): pass',
      new_text: 'def foo(): return 42',
    },
    schema
  );

  assert.equal(validation.valid, true);
  assert.equal(validation.coercedArgs?.path, 'packages/providers/gemini/registry.py');
  assert.equal(validation.coercedArgs?.oldText, 'def foo(): pass');
  assert.equal(validation.coercedArgs?.newText, 'def foo(): return 42');
  // Check that unknown aliases were cleaned up to pass strict schema validation
  assert.equal('old_text' in validation.coercedArgs, false);
  assert.equal('new_text' in validation.coercedArgs, false);
  assert.equal('filePath' in validation.coercedArgs, false);
});

test('tool-use-guardian: pre-call validation coerces TargetContent/ReplacementContent aliases on replace_text', () => {
  const guardian = new ToolUseGuardian();
  const schema = {
    type: 'OBJECT',
    properties: {
      path: { type: 'STRING' },
      oldText: { type: 'STRING' },
      newText: { type: 'STRING' },
    },
    required: ['path', 'oldText', 'newText'],
  };

  // Agent passes Claude Code / Antigravity format to replace_text
  const validation = guardian.preCallValidate(
    'replace_text',
    {
      path: 'src/index.ts',
      TargetContent: 'console.log(1)',
      ReplacementContent: 'console.log(2)',
    },
    schema
  );

  assert.equal(validation.valid, true);
  assert.equal(validation.coercedArgs?.oldText, 'console.log(1)');
  assert.equal(validation.coercedArgs?.newText, 'console.log(2)');
  assert.equal('TargetContent' in validation.coercedArgs, false);
  assert.equal('ReplacementContent' in validation.coercedArgs, false);
});
