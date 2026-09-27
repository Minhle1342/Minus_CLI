import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  findRecipeForBinary,
  getAllSupportedBinaries,
  TOOLCHAIN_RECIPES,
} from './toolchain-recipes.js';
import { ToolchainProvisioner } from './toolchain-provisioner.js';
import { probeMissingBinary } from '../tools/command-preflight-guard.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { Workspace } from '../workspace/workspace.js';

test('findRecipeForBinary correctly resolves supported binary names', () => {
  assert.equal(findRecipeForBinary('node')?.id, 'nodejs');
  assert.equal(findRecipeForBinary('npm')?.id, 'nodejs');
  assert.equal(findRecipeForBinary('npx')?.id, 'nodejs');
  assert.equal(findRecipeForBinary('node.exe')?.id, 'nodejs');
  assert.equal(findRecipeForBinary('npm.cmd')?.id, 'nodejs');

  assert.equal(findRecipeForBinary('uv')?.id, 'uv');
  assert.equal(findRecipeForBinary('uvx')?.id, 'uv');

  assert.equal(findRecipeForBinary('python')?.id, 'python');
  assert.equal(findRecipeForBinary('python3')?.id, 'python');
  assert.equal(findRecipeForBinary('pip')?.id, 'python');
  assert.equal(findRecipeForBinary('pip3')?.id, 'python');
  assert.equal(findRecipeForBinary('py')?.id, 'python');

  assert.equal(findRecipeForBinary('bun')?.id, 'bun');
  assert.equal(findRecipeForBinary('bunx')?.id, 'bun');

  assert.equal(findRecipeForBinary('deno')?.id, 'deno');

  assert.equal(findRecipeForBinary('go')?.id, 'go');
  assert.equal(findRecipeForBinary('gofmt')?.id, 'go');

  assert.equal(findRecipeForBinary('java')?.id, 'java');
  assert.equal(findRecipeForBinary('javac')?.id, 'java');
  assert.equal(findRecipeForBinary('jar')?.id, 'java');

  assert.equal(findRecipeForBinary('zig')?.id, 'zig');

  assert.equal(findRecipeForBinary('cmake')?.id, 'cmake');
  assert.equal(findRecipeForBinary('ctest')?.id, 'cmake');

  assert.equal(findRecipeForBinary('ninja')?.id, 'ninja');

  assert.equal(findRecipeForBinary('php')?.id, 'php');

  assert.equal(findRecipeForBinary('rg')?.id, 'ripgrep');
  assert.equal(findRecipeForBinary('ripgrep')?.id, 'ripgrep');

  assert.equal(findRecipeForBinary('git')?.id, 'mingit');

  assert.equal(findRecipeForBinary('__unknown_binary_xyz__'), undefined);
});

test('getAllSupportedBinaries returns all expected toolchain commands', () => {
  const binaries = getAllSupportedBinaries();
  assert.ok(binaries.includes('node'));
  assert.ok(binaries.includes('npm'));
  assert.ok(binaries.includes('npx'));
  assert.ok(binaries.includes('uv'));
  assert.ok(binaries.includes('python'));
  assert.ok(binaries.includes('pip'));
  assert.ok(binaries.includes('bun'));
  assert.ok(binaries.includes('bunx'));
  assert.ok(binaries.includes('deno'));
  assert.ok(binaries.includes('go'));
  assert.ok(binaries.includes('java'));
  assert.ok(binaries.includes('javac'));
  assert.ok(binaries.includes('zig'));
  assert.ok(binaries.includes('cmake'));
  assert.ok(binaries.includes('ninja'));
  assert.ok(binaries.includes('php'));
  assert.ok(binaries.includes('rg'));
  assert.ok(binaries.includes('git'));
});

test('ToolchainProvisioner.getInstallRoot resolves valid directory', () => {
  const root = ToolchainProvisioner.getInstallRoot();
  assert.ok(root && typeof root === 'string');
  assert.ok(path.isAbsolute(root));
});

test('ToolchainProvisioner.updateProcessEnvPath correctly adds path to process.env.PATH', () => {
  const dummyDir = path.resolve('C:\\dummy_toolchain_test_dir');
  const originalPath = process.env.PATH || '';

  try {
    ToolchainProvisioner.updateProcessEnvPath(dummyDir);
    assert.ok(process.env.PATH?.startsWith(dummyDir));

    // Calling again does not duplicate
    const currentPath = process.env.PATH;
    ToolchainProvisioner.updateProcessEnvPath(dummyDir);
    assert.equal(process.env.PATH, currentPath);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('ToolchainProvisioner detects already installed toolchain and does not redownload', async () => {
  // Kiểm tra với nodejs (vốn đã được cài đặt vào Programs/nodejs)
  const nodeRecipe = TOOLCHAIN_RECIPES.nodejs;
  const result = await ToolchainProvisioner.provision(nodeRecipe);

  assert.equal(result.success, true);
  assert.equal(result.toolchain, 'nodejs');
  assert.equal(result.alreadyExisted, true);
  assert.ok(result.version && result.version.startsWith('v'));
});

test('probeMissingBinary marks supported missing binaries with canAutoProvision', () => {
  // Binary hoàn toàn không rõ nguồn gốc
  const unknownProbe = probeMissingBinary('__minus_nonexistent_cli__ --foo');
  assert.deepEqual(unknownProbe, { name: '__minus_nonexistent_cli__' });
  assert.equal(unknownProbe?.canAutoProvision, undefined);
});

test('run_command respects MINUS_AUTO_PROVISION=off fallback', async () => {
  const originalEnv = process.env.MINUS_AUTO_PROVISION;
  try {
    process.env.MINUS_AUTO_PROVISION = 'off';
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: '__minus_uninstalled_tool__ --version' },
      new Workspace(),
    );
    assert.equal(result.commandOutcome, 'blocked_preflight');
    assert.equal(result.preflightCode, 'DEV_BINARY_NOT_FOUND');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.MINUS_AUTO_PROVISION;
    } else {
      process.env.MINUS_AUTO_PROVISION = originalEnv;
    }
  }
});
