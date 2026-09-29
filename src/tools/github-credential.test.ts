import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { getGitHubCredential } from './github-credential.js';

test('GitHub credential lookup invokes only GCM without a shell or interactive login', async () => {
  let args: string[] = [];
  let input = '';
  let options: any;
  const fakeSpawn = ((_binary: string, argv: string[], opts: any) => {
    assert.equal(_binary, 'git');
    args = argv;
    options = opts;
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString('utf8'); });
    setImmediate(() => {
      child.stdout.end('protocol=https\nhost=github.com\nusername=viewer\npassword=private-test-value\n');
      child.emit('close', 0);
    });
    return child;
  }) as typeof spawn;
  const token = await getGitHubCredential(fakeSpawn);
  assert.equal(token, 'private-test-value');
  assert.deepEqual(args, [
    '-c', 'credential.helper=', '-c', 'credential.helper=manager',
    '-c', 'credential.useHttpPath=false', 'credential', 'fill',
  ]);
  assert.equal(options.env.GCM_INTERACTIVE, 'never');
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.shell, undefined);
  assert.equal(input, 'protocol=https\nhost=github.com\n\n');
});
