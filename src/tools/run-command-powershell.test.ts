import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunCommandTool, wrapPowerShellCommand } from './run-command.js';
import { normalizeWindowsCommand } from './command-preflight-guard.js';
import { unwrapPowerShellCliXml } from './terminal-sanitizer.js';
import { Workspace } from '../workspace/workspace.js';

const win32 = process.platform === 'win32';

function decodeEncodedCommand(wrapped: string): string {
  const m = wrapped.match(/-EncodedCommand (\S+)$/);
  assert.ok(m, `wrapped command must carry -EncodedCommand: ${wrapped}`);
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

test('wrapPowerShellCommand encodes prelude, command and exit-code tail', () => {
  const wrapped = wrapPowerShellCommand('npm test');
  const shell = win32 ? 'powershell' : 'pwsh';
  assert.ok(
    wrapped.startsWith(`${shell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand `),
    wrapped,
  );
  const script = decodeEncodedCommand(wrapped);
  assert.ok(script.includes("$ProgressPreference='SilentlyContinue'"), script);
  assert.ok(script.includes('npm test'), script);
  assert.ok(script.includes('if ($LASTEXITCODE) { exit $LASTEXITCODE }'), script);

  // Quotes and `$` survive byte-for-byte: base64 removes every escaping layer.
  const tricky = 'Write-Output "a $b & c"';
  assert.ok(decodeEncodedCommand(wrapPowerShellCommand(tricky)).includes(tricky));
});

test('unwrapPowerShellCliXml turns PowerShell error CLIXML into readable text', () => {
  const raw = [
    '#< CLIXML',
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/1.0">',
    '<S S="Error">Get-ChildItem : Cannot find path \'C:\\nope-xyz\' because it does not exist._x000D__x000A_</S>',
    '<S S="Error">At line:2 char:1_x000D__x000A_</S>',
    '<S S="Error">+ &amp; Get-ChildItem C:\\nope-xyz_x000D__x000A_</S>',
    '</Objs>',
  ].join('\r\n');
  const out = unwrapPowerShellCliXml(raw);
  assert.ok(!out.includes('CLIXML'), out);
  assert.ok(!out.includes('<Objs'), out);
  assert.ok(out.includes("Cannot find path 'C:\\nope-xyz'"), out);
  assert.ok(out.includes('+ & Get-ChildItem'), out);
  assert.ok(!out.includes('_x000D_'), out);

  // Progress-only CLIXML (no error payload) is dropped entirely.
  const progress = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"></Obj></Objs>';
  assert.equal(unwrapPowerShellCliXml(progress), '');

  // Non-PowerShell output is untouched.
  assert.equal(unwrapPowerShellCliXml('npm ERR! missing script'), 'npm ERR! missing script');
});

test('run_command rejects an unknown shell value', async () => {
  const res = await createRunCommandTool().execute(
    { command: 'npm test', shell: 'bash' },
    new Workspace(),
  );
  assert.equal(res.errorCode, 'INVALID_SHELL');
});

test('shell: powershell is refused under Docker isolation before allowlist checks', async () => {
  const tool = createRunCommandTool({
    getStatus: () => ({
      mode: 'docker', activeProvider: 'docker', isIsolated: true, dockerAvailable: true,
    }),
    exec: async () => {
      throw new Error('must not execute');
    },
  } as any);
  const res = await tool.execute({ command: 'Write-Output hi', shell: 'powershell' }, new Workspace());
  assert.equal(res.errorCode, 'POWERSHELL_ISOLATION_UNSUPPORTED');
  assert.equal(res.commandOutcome, 'blocked_preflight');
  assert.equal(res.processStarted, false);
});

test(
  'normalizeWindowsCommand keeps PowerShell syntax when shell is powershell',
  { skip: !win32 },
  () => {
    const callOp = normalizeWindowsCommand('& ".\\bin\\x.exe" --verbose', { shell: 'powershell' });
    assert.equal(callOp.normalizedCommand, '& ".\\bin\\x.exe" --verbose');

    const which = normalizeWindowsCommand('which node', { shell: 'powershell' });
    assert.equal(which.normalizedCommand, 'which node');

    // Default (cmd.exe) path keeps the existing rewrites.
    assert.equal(normalizeWindowsCommand('& .\\bin\\x.exe').normalizedCommand, '.\\bin\\x.exe');
    assert.equal(normalizeWindowsCommand('which node').normalizedCommand, 'where node');
    assert.equal(normalizeWindowsCommand('ls -la').normalizedCommand, 'dir /a');
  },
);

test(
  'shell: powershell runs through PowerShell and keeps result payloads raw',
  { skip: !win32 },
  async () => {
    const tool = createRunCommandTool();
    const ctx: any = { permissionGranted: true };

    const ok = await tool.execute({ command: 'Write-Output hi', shell: 'powershell' }, new Workspace(), ctx);
    assert.equal(ok.exitCode, 0, JSON.stringify(ok));
    assert.equal(ok.success, true);
    assert.match(ok.stdout, /hi/);
    assert.equal(ok.command, 'Write-Output hi', 'result must report the unwrapped command');

    const fail = await tool.execute({ command: 'node -e "process.exit(4)"', shell: 'powershell' }, new Workspace(), ctx);
    assert.equal(fail.exitCode, 4, JSON.stringify(fail));
    assert.equal(fail.success, false);
  },
);

test(
  'shell: powershell executes the PowerShell call operator on a workspace script',
  { skip: !win32 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-ps-shell-'));
    try {
      await fs.writeFile(path.join(root, 'hello.ps1'), 'Write-Output "from-ps1"\n', 'utf-8');
      const res = await createRunCommandTool().execute(
        { command: '& ".\\hello.ps1"', shell: 'powershell' },
        new Workspace(root),
        { permissionGranted: true } as any,
      );
      assert.equal(res.exitCode, 0, JSON.stringify(res));
      assert.match(res.stdout, /from-ps1/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
