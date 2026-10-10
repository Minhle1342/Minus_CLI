import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoopProgressGuard } from '../agent/loop-progress-guard.js';
import { ToolRegistry } from './registry.js';
import { ToolRunner } from './tool-runner.js';
import { Workspace } from '../workspace/workspace.js';

const sandboxBlock = {
  command: 'npm test',
  error: 'Docker isolation is unavailable; this command is not classified as read-only.',
  errorCode: 'ISOLATED_SANDBOX_REQUIRED',
  success: false,
  commandOutcome: 'blocked_preflight',
  processStarted: false,
  durationMs: 1,
};

describe('Deterministic failure dedup (ISOLATED_SANDBOX_REQUIRED & policy blocks)', () => {
  it('LoopProgressGuard guards identical deterministic blocks, ignores env failures', () => {
    const guard = new LoopProgressGuard();
    const observe = () => guard.observe({
      toolName: 'run_command',
      args: { command: 'npm test' },
      result: { ...sandboxBlock },
    });
    assert.equal(observe().shouldStop, false, 'first block passes through');
    const second = observe();
    assert.equal(second.repetitionCount, 2);
    assert.match(second.message || '', /ISOLATED_SANDBOX_REQUIRED/);
    assert.match(second.message || '', /execution_target/);
    assert.equal(observe().shouldStop, true, 'third identical block stops the turn');

    // Lỗi môi trường non-deterministic vẫn cho retry như cũ.
    const envGuard = new LoopProgressGuard();
    const envFail = { stderr: 'sh: dotnet: not found', exitCode: 127, errorCode: 'COMMAND_NOT_FOUND' };
    const env = (cmd: string) => envGuard.observe({ toolName: 'run_command', args: { command: cmd }, result: { ...envFail } });
    assert.equal(env('dotnet restore').shouldStop, false);
    assert.equal(env('dotnet build').message, undefined);
    assert.equal(env('dotnet test').shouldStop, false);
  });

  it('ToolRunner short-circuits identical deterministic repeats within a turn', async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: 'run_command',
      description: 'fake run_command returning a deterministic sandbox block',
      parameters: { type: 'object', properties: { command: { type: 'string' } } } as any,
      execute: async (args: any) => {
        executions++;
        return { ...sandboxBlock, command: args.command };
      },
    });
    const runner = new ToolRunner(registry, new Workspace(process.cwd()));
    const ctx = { turn: 7 } as any;

    const first = await runner.run('run_command', { command: 'npm test' }, ctx);
    assert.equal(first.result.errorCode, 'ISOLATED_SANDBOX_REQUIRED');
    assert.equal(first.result.deduped, undefined);
    assert.equal(executions, 1);

    const second = await runner.run('run_command', { command: 'npm test' }, ctx);
    assert.equal(second.result.errorCode, 'ISOLATED_SANDBOX_REQUIRED');
    assert.equal(second.result.deduped, true);
    assert.equal(second.durationMs, 0);
    assert.equal(executions, 1, 'repeat is served from cache without re-execution');

    // Turn mới → cache theo turn hết hiệu lực.
    const nextTurn = await runner.run('run_command', { command: 'npm test' }, { turn: 8 } as any);
    assert.equal(nextTurn.result.deduped, undefined);
    assert.equal(executions, 2);

    // Scoped runner chia sẻ cache với parent.
    const scoped = runner.createScoped(registry);
    const scopedRepeat = await scoped.run('run_command', { command: 'npm test' }, { turn: 8 } as any);
    assert.equal(scopedRepeat.result.deduped, true);

    // Reset xóa cache.
    runner.resetTurnBudget(8);
    const afterReset = await runner.run('run_command', { command: 'npm test' }, { turn: 8 } as any);
    assert.equal(afterReset.result.deduped, undefined);
  });

  it('ToolRunner does not dedup across different control modes', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'gated_tool',
      description: 'tool outside the allowlist',
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => ({ executed: true }),
    });
    const { hashAllowedToolSet } = await import('../control/this-turn-tool-gate.js');
    const runner = new ToolRunner(registry, new Workspace(process.cwd()));
    const allowed = ['other_tool'];
    const base = {
      decisionId: 'd-scope',
      allowedToolNames: allowed,
      allowedToolSetHash: hashAllowedToolSet(allowed),
      classificationPhase: 'implement',
      turn: 1,
    } as any;

    const blocked = await runner.run('gated_tool', {}, { ...base, controlMode: 'enforce' });
    assert.equal(blocked.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');

    // Shadow mode với cùng args nhưng scope khác → vẫn thực thi, không dedup.
    const shadow = await runner.run('gated_tool', {}, { ...base, controlMode: 'shadow' });
    assert.equal(shadow.result.executed, true);

    // Enforce lặp lại y hệt → deduped.
    const repeat = await runner.run('gated_tool', {}, { ...base, controlMode: 'enforce' });
    assert.equal(repeat.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
    assert.equal(repeat.result.deduped, true);
  });
});
