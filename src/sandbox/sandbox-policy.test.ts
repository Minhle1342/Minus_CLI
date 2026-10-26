import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxPolicyEngine } from './sandbox-policy.js';

const engine = new SandboxPolicyEngine(process.cwd(), 'strict');
const risk = (command: string) => engine.evaluateCommand(command).riskLevel;

test('read-only command chains stay read-only', () => {
  for (const command of [
    'git status && git log --oneline',
    'git diff; git status',
    'git status\ngit log --oneline',
    'cat package.json | head -n 5',
  ]) {
    assert.equal(risk(command), 'SAFE_READ_ONLY', command);
  }
});

test('a chain with a mutating command is not read-only', () => {
  assert.notEqual(risk('cat package.json && rm -rf src'), 'SAFE_READ_ONLY');
});

test('fd redirects are read-only but writing to a file named like an fd is not', () => {
  assert.equal(risk('cat package.json 2>&1'), 'SAFE_READ_ONLY');
  assert.equal(risk('cat package.json 2>/dev/null'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('cat package.json > 1'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('cat package.json >> 2'), 'SAFE_READ_ONLY');
});

test('only read-only codegraph subcommands are sandbox-safe', () => {
  assert.equal(risk('codegraph explore AgentLoop'), 'SAFE_READ_ONLY');
  assert.equal(risk('codegraph impact AgentLoop'), 'SAFE_READ_ONLY');
  assert.equal(risk('codegraph status'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('codegraph init'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('codegraph sync'), 'SAFE_READ_ONLY');
});
