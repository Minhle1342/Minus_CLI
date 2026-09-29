import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';

/** Retrieve a GitHub credential from the host's Git Credential Manager without involving a shell. */
export async function getGitHubCredential(
  spawnImpl: typeof spawn = spawn,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnImpl('git', [
      '-c', 'credential.helper=',
      '-c', 'credential.helper=manager',
      '-c', 'credential.useHttpPath=false',
      'credential', 'fill',
    ], {
      cwd: os.homedir(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    let output = '';
    let finished = false;
    const finish = (token?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(token);
    };
    const timer = setTimeout(() => { child.kill(); finish(); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 16_384) { child.kill(); finish(); }
    });
    // Never forward helper output: it may contain credentials or account details.
    child.stderr.resume();
    child.on('error', () => finish());
    child.on('close', (code) => {
      if (code !== 0) return finish();
      const token = output.split(/\r?\n/).find((line) => line.startsWith('password='))?.slice('password='.length);
      finish(token || undefined);
    });
    child.stdin.on('error', () => finish());
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}
