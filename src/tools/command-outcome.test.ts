import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDockerIsolationDisabled,
  setDockerIsolationDisabled,
  toggleDockerIsolation,
  isSystemDestructiveCommand,
  canBypassDockerIsolation,
  classifyCommandOutcome,
  annotateCommandResult,
} from './command-outcome.js';
import { mustBlockUnisolatedAutoExecution } from '../sandbox/command-isolation-policy.js';

test('Docker isolation state management works correctly', () => {
  // Reset initial
  setDockerIsolationDisabled(false);
  assert.equal(isDockerIsolationDisabled(), false);

  setDockerIsolationDisabled(true);
  assert.equal(isDockerIsolationDisabled(), true);

  // Toggle
  const toggledOff = toggleDockerIsolation(false);
  assert.equal(toggledOff, false);
  assert.equal(isDockerIsolationDisabled(), false);

  const toggledOn = toggleDockerIsolation(true);
  assert.equal(toggledOn, true);
  assert.equal(isDockerIsolationDisabled(), true);

  // Clean up
  setDockerIsolationDisabled(false);
});

test('isSystemDestructiveCommand identifies dangerous commands', () => {
  assert.equal(isSystemDestructiveCommand('rm -rf /'), true);
  assert.equal(isSystemDestructiveCommand('rm -rf C:\\'), true);
  assert.equal(isSystemDestructiveCommand('rmdir /s /q c:\\'), true);
  assert.equal(isSystemDestructiveCommand('format C:'), true);
  assert.equal(isSystemDestructiveCommand('dd if=/dev/zero of=/dev/sda'), true);
  assert.equal(isSystemDestructiveCommand(':(){ :|:& };:'), true);

  // Safe commands
  assert.equal(isSystemDestructiveCommand('npm install axios'), false);
  assert.equal(isSystemDestructiveCommand('curl https://api.example.com/data'), false);
  assert.equal(isSystemDestructiveCommand('python main.py'), false);
  assert.equal(isSystemDestructiveCommand('git commit -m "feat: new feature"'), false);
  assert.equal(isSystemDestructiveCommand('dotnet build'), false);
});

test('canBypassDockerIsolation allows safe commands only when isolation is disabled', () => {
  setDockerIsolationDisabled(false);
  assert.equal(canBypassDockerIsolation('npm install axios'), false);
  assert.equal(canBypassDockerIsolation('curl https://api.example.com'), false);

  setDockerIsolationDisabled(true);
  // Safe commands can now bypass Docker isolation freely
  assert.equal(canBypassDockerIsolation('npm install axios'), true);
  assert.equal(canBypassDockerIsolation('curl https://api.example.com'), true);
  assert.equal(canBypassDockerIsolation('cargo build --release'), true);

  // Dangerous commands can NEVER bypass isolation
  assert.equal(canBypassDockerIsolation('format C:'), false);
  assert.equal(canBypassDockerIsolation('rm -rf /'), false);

  // Clean up
  setDockerIsolationDisabled(false);
});

test('mustBlockUnisolatedAutoExecution respects Docker isolation bypass', () => {
  const fallbackStatus: any = {
    mode: 'local',
    isIsolated: false,
    fallbackToLocal: true,
    dockerAvailable: false,
  };

  // When isolation is enabled: non-read-only command is blocked
  setDockerIsolationDisabled(false);
  delete process.env.MINUS_ALLOW_HOST_FALLBACK;
  delete process.env.MINUS_DISABLE_DOCKER_ISOLATION;
  assert.equal(mustBlockUnisolatedAutoExecution('npm install malicious-pkg', fallbackStatus), true);

  // When isolation is disabled: safe command is allowed without blocking
  setDockerIsolationDisabled(true);
  assert.equal(mustBlockUnisolatedAutoExecution('npm install malicious-pkg', fallbackStatus), false);
  assert.equal(mustBlockUnisolatedAutoExecution('curl -s https://test.com', fallbackStatus), false);

  // Clean up
  setDockerIsolationDisabled(false);
});
