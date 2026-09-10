import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AciGuardrails, resolveAciGuardrailMode } from './aci-guardrails.js';

test('ACI guardrails block prohibited git push to main', () => {
  const guard = new AciGuardrails();
  const res = guard.validate({
    toolName: 'run_command',
    args: { command: 'git push origin main' },
    workspaceRoot: process.cwd(),
  }, 'enforce');

  assert.equal(res.allowed, false);
  assert.equal(res.reasonCode, 'PROHIBITED_PUSH_TO_MAIN');
  assert.equal(res.riskLevel, 'BLOCKED');
});

test('ACI guardrails block ambiguous replace_text without allowMultiple', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aci-test-'));
  try {
    const filePath = path.join(tmpDir, 'sample.ts');
    await fs.writeFile(filePath, 'const a = 1;\nconst a = 2;\n');
    const guard = new AciGuardrails();

    const ambiguous = guard.validate({
      toolName: 'replace_text',
      args: { path: filePath, searchContent: 'const a =', replaceWith: 'const b =' },
      workspaceRoot: tmpDir,
    }, 'enforce');

    assert.equal(ambiguous.allowed, false);
    assert.equal(ambiguous.reasonCode, 'AMBIGUOUS_REPLACEMENT');

    const allowedMultiple = guard.validate({
      toolName: 'replace_text',
      args: { path: filePath, searchContent: 'const a =', replaceWith: 'const b =', allowMultiple: true },
      workspaceRoot: tmpDir,
    }, 'enforce');

    assert.equal(allowedMultiple.allowed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ACI guardrails prevent syntax violations in TypeScript files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aci-syntax-test-'));
  try {
    const filePath = path.join(tmpDir, 'service.ts');
    await fs.writeFile(filePath, 'export function run(): void {\n  console.log("hello");\n}\n');
    const guard = new AciGuardrails();

    // Breaking syntax with unmatched brace
    const badSyntax = guard.validate({
      toolName: 'replace_text',
      args: {
        path: filePath,
        searchContent: 'console.log("hello");',
        replaceWith: 'console.log("hello" + {{{;',
      },
      workspaceRoot: tmpDir,
    }, 'enforce');

    assert.equal(badSyntax.allowed, false);
    assert.equal(badSyntax.reasonCode, 'SYNTAX_VIOLATION_PREVENTED');
    assert.match(badSyntax.rejectionMessage || '', /fatal syntax/);

    // Valid syntax
    const goodSyntax = guard.validate({
      toolName: 'replace_text',
      args: {
        path: filePath,
        searchContent: 'console.log("hello");',
        replaceWith: 'console.log("world");',
      },
      workspaceRoot: tmpDir,
    }, 'enforce');

    assert.equal(goodSyntax.allowed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ACI guardrails resolve mode properly from environment', () => {
  assert.equal(resolveAciGuardrailMode('enforce'), 'enforce');
  assert.equal(resolveAciGuardrailMode('observe'), 'observe');
  assert.equal(resolveAciGuardrailMode('off'), 'off');
  assert.equal(resolveAciGuardrailMode(undefined), 'observe');
});
