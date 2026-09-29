import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeShellCommand } from './shell-segmenter.js';

test('shell analysis marks single ampersands and redirects as complex', () => {
  for (const command of [
    'npm test & echo done',
    'npm test > test.log',
    'npm test 2>&1',
    'echo `whoami`',
  ]) {
    assert.equal(analyzeShellCommand(command).complex, true, command);
  }
});

test('shell analysis preserves simple && chains and quoted operator text', () => {
  const chain = analyzeShellCommand('npm run build && npm test');
  assert.equal(chain.complex, false);
  assert.deepEqual(chain.operators, ['&&']);
  assert.deepEqual(chain.segments, ['npm run build', 'npm test']);

  const quoted = analyzeShellCommand('node -e "console.log(\'a&b > c\')"');
  assert.equal(quoted.complex, false);
  assert.deepEqual(quoted.operators, []);
});
