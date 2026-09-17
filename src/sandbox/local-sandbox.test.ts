import assert from 'node:assert/strict';
import test from 'node:test';
import { isNativeAvailable } from '../native/index.js';
import { LocalProcessSandbox } from './local-sandbox.js';

test('native sandbox execution yields to the Node event loop', { skip: !isNativeAvailable() }, async () => {
  const sandbox = new LocalProcessSandbox();
  let timerFired = false;
  const command = `"${process.execPath}" -e "setTimeout(() => {}, 120)"`;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 20);

  try {
    const result = await sandbox.exec(command);
    assert.equal(result.exitCode, 0);
    assert.equal(timerFired, true, 'the timer must run while the native command is pending');
  } finally {
    clearTimeout(timer);
  }
});

test('native sandbox cancellation terminates a running command', { skip: !isNativeAvailable() }, async () => {
  const sandbox = new LocalProcessSandbox();
  const controller = new AbortController();
  const command = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`;
  const timer = setTimeout(() => controller.abort(), 40);

  try {
    const result = await sandbox.exec(command, { signal: controller.signal, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 130);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'COMMAND_CANCELLED');
    assert.notEqual(result.timedOut, true);
  } finally {
    clearTimeout(timer);
  }
});

test('native sandbox applies the same sanitized environment as the Node fallback', { skip: !isNativeAvailable() }, async () => {
  const sandbox = new LocalProcessSandbox();
  const command = process.platform === 'win32'
    ? 'echo %MINUS_NATIVE_ENV_TEST%'
    : 'printf "$MINUS_NATIVE_ENV_TEST"';

  const result = await sandbox.exec(command, { env: { MINUS_NATIVE_ENV_TEST: 'native-env' } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'native-env');
});
