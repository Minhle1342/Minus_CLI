import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerLaunch, PLAYWRIGHT_MCP_PINNED_SPEC } from './mcp-manager.js';

describe('playwright-mcp launch resolution (spawn EINVAL fix)', () => {
  it('prefers explicit command override', () => {
    const launch = resolveServerLaunch(['--headless'], { command: '/opt/pw-mcp' }, { platform: 'linux' });
    assert.equal(launch.source, 'explicit');
    assert.equal(launch.command, '/opt/pw-mcp');
    assert.deepEqual(launch.args, ['--headless']);
    assert.equal(launch.shell, false);
  });

  it('uses shell:true for .cmd shims on win32 (explicit)', () => {
    const launch = resolveServerLaunch([], { command: 'npx.cmd' }, { platform: 'win32' });
    assert.equal(launch.shell, true);
  });

  it('prefers local package entry via node (no shell, no npx)', () => {
    const launch = resolveServerLaunch(['--headless'], {}, {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      resolveLocalEntry: () => 'C:\\proj\\node_modules\\@playwright\\mcp\\cli.js',
      pathExists: () => true,
    });
    assert.equal(launch.source, 'local-package');
    assert.equal(launch.command, 'C:\\node\\node.exe');
    assert.deepEqual(launch.args[0], 'C:\\proj\\node_modules\\@playwright\\mcp\\cli.js');
    assert.equal(launch.shell, false);
  });

  it('falls back to pinned npx with shell:true on win32 (no EINVAL)', () => {
    const launch = resolveServerLaunch(['--headless'], {}, {
      platform: 'win32',
      resolveLocalEntry: () => undefined,
    });
    assert.equal(launch.source, 'npx');
    assert.equal(launch.command, 'npx.cmd');
    assert.equal(launch.shell, true);
    assert.ok(launch.args.includes(PLAYWRIGHT_MCP_PINNED_SPEC));
    assert.ok(!launch.args.join(' ').includes('@latest'));
  });

  it('falls back to plain npx without shell on posix', () => {
    const launch = resolveServerLaunch([], {}, {
      platform: 'linux',
      resolveLocalEntry: () => undefined,
    });
    assert.equal(launch.command, 'npx');
    assert.equal(launch.shell, false);
  });

  it('completes explicit npx into a pinned launch (fallback launcher)', () => {
    const win = resolveServerLaunch(['--headless'], { command: 'C:\\nodejs\\npx.cmd' }, { platform: 'win32' });
    assert.equal(win.source, 'npx');
    assert.equal(win.shell, true);
    assert.ok(win.args.includes(PLAYWRIGHT_MCP_PINNED_SPEC));
    const nix = resolveServerLaunch([], { command: 'npx' }, { platform: 'linux' });
    assert.equal(nix.source, 'npx');
    assert.equal(nix.shell, false);
  });
});
