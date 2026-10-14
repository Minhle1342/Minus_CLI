import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from './registry.js';
import { ToolRunner } from './tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { matchToolName, clearPreToolUseCache } from './pre-tool-use.js';
import type { ToolDefinition } from './types.js';

describe('PreToolUse Execution Interceptor Hook Suite', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-pre-tool-use-test-'));
  const workspace = new Workspace(tmpDir);

  const testTool: ToolDefinition = {
    name: 'run_command',
    description: 'Execute shell commands',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    } as any,
    execute: async (args) => ({ success: true, executedCommand: args.command }),
  };

  const fileTool: ToolDefinition = {
    name: 'replace_file_content',
    description: 'Replace content in file',
    parameters: {
      type: 'object',
      properties: {
        TargetFile: { type: 'string' },
        ReplacementContent: { type: 'string' },
      },
      required: ['TargetFile', 'ReplacementContent'],
    } as any,
    execute: async (args) => ({ success: true, file: args.TargetFile }),
  };

  it('1. matchToolName matches exact, wildcards, Claude Code aliases, and pipe matchers', () => {
    // Exact
    assert.equal(matchToolName('run_command', 'run_command'), true);
    assert.equal(matchToolName('run_command', 'replace_file_content'), false);

    // Wildcard
    assert.equal(matchToolName('*', 'anything'), true);

    // Claude Code aliases
    assert.equal(matchToolName('Bash', 'run_command'), true);
    assert.equal(matchToolName('Edit', 'replace_file_content'), true);
    assert.equal(matchToolName('Edit', 'apply_patch'), true);
    assert.equal(matchToolName('Write', 'write_to_file'), true);
    assert.equal(matchToolName('Read', 'read_file'), true);

    // Pipe matcher
    assert.equal(matchToolName('Edit|Write', 'replace_file_content'), true);
    assert.equal(matchToolName('Edit|Write', 'write_to_file'), true);
    assert.equal(matchToolName('Edit|Write', 'run_command'), false);
  });

  it('2. Interceptor normalizes parameters before tool execution', async () => {
    const registry = new ToolRegistry();
    registry.register(testTool);

    const runner = new ToolRunner(registry, workspace);

    // Interceptor chuẩn hóa lệnh (ví dụ: tự động trim và chuẩn hóa format)
    runner.registerPreToolUseInterceptor(async ({ args }) => {
      const cmd = String(args.command || '').trim();
      return {
        modifiedArgs: {
          command: cmd.replace(/\\/g, '/'),
        },
      };
    }, 'run_command');

    const result = await runner.run('run_command', { command: '   git checkout -b feature\\test   ' });
    assert.equal(result.result.success, true);
    assert.equal(result.result.executedCommand, 'git checkout -b feature/test');
  });

  it('3. Interceptor blocks execution with exit code 2 / denial feedback without running the tool', async () => {
    let toolActuallyExecuted = false;
    const sensitiveTool: ToolDefinition = {
      name: 'run_command',
      description: 'Execute command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      } as any,
      execute: async () => {
        toolActuallyExecuted = true;
        return { success: true };
      },
    };

    const registry = new ToolRegistry();
    registry.register(sensitiveTool);
    const runner = new ToolRunner(registry, workspace);

    // Interceptor chặn các lệnh nguy hiểm (Claude Code Exit Code 2 / OpenCode denial)
    runner.registerPreToolUseInterceptor(async ({ args }) => {
      if (args.command.includes('git push --force')) {
        return {
          allow: false,
          errorCode: 'PRE_TOOL_USE_BLOCKED',
          message: 'Security policy violation: Force pushing is blocked by PreToolUse hook.',
          suggestion: 'Push without --force or create a feature branch.',
        };
      }
    }, 'Bash'); // Sử dụng alias 'Bash' tương thích Claude Code

    const result = await runner.run('run_command', { command: 'git push --force origin main' });

    assert.equal(toolActuallyExecuted, false, 'Tool must NOT be executed when blocked by hook');
    assert.equal(result.result.errorCode, 'PRE_TOOL_USE_BLOCKED');
    assert.ok(String(result.result.error).includes('Security policy violation: Force pushing is blocked'));
    assert.equal(result.result.suggestion, 'Push without --force or create a feature branch.');
  });

  it('4. Interceptor throwing an Error cleanly blocks tool execution', async () => {
    const registry = new ToolRegistry();
    registry.register(testTool);
    const runner = new ToolRunner(registry, workspace);

    runner.registerPreToolUseInterceptor(async () => {
      throw new Error('Fatal hook script error: preflight lint failed.');
    }, 'run_command');

    const result = await runner.run('run_command', { command: 'npm test' });
    assert.equal(result.result.errorCode, 'PRE_TOOL_USE_BLOCKED');
    assert.ok(String(result.result.error).includes('preflight lint failed'));
  });

  it('5. Declarative .minus/hooks.json PreToolUse rules block matching tools', async () => {
    clearPreToolUseCache();
    const hooksDir = path.join(tmpDir, '.minus');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            pattern: 'secret_key',
            action: 'deny',
            message: 'Blocked by repo hook: Writing secrets into source files is forbidden.',
          },
        ],
      }),
    );

    const registry = new ToolRegistry();
    registry.register(fileTool);
    const runner = new ToolRunner(registry, workspace);

    const result = await runner.run('replace_file_content', {
      TargetFile: path.join(tmpDir, 'config.ts'),
      ReplacementContent: 'const secret_key = "123456";',
    });

    assert.equal(result.result.errorCode, 'PRE_TOOL_USE_BLOCKED');
    assert.ok(String(result.result.error).includes('Writing secrets into source files is forbidden'));

    clearPreToolUseCache();
  });

  it('6. Interceptors propagate seamlessly to scoped runners', async () => {
    const registry = new ToolRegistry();
    registry.register(testTool);
    const parentRunner = new ToolRunner(registry, workspace);

    parentRunner.registerPreToolUseInterceptor(async ({ args }) => {
      return {
        modifiedArgs: { command: `${args.command} --from-scoped` },
      };
    }, 'run_command');

    const scoped = parentRunner.createScoped(registry);
    const res = await scoped.run('run_command', { command: 'build' });
    assert.equal(res.result.success, true);
    assert.equal(res.result.executedCommand, 'build --from-scoped');
  });
});
