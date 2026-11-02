import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHookRegistry, type AgentHookContext, type AgentHookEvent, type AgentHookHandlers, type AgentHookResult } from './agent-hooks.js';
import { Session } from '../session/session.js';

// Guard for the event surface: AgentHookHandlers is derived from AgentHookEvent,
// so the two can never drift apart (an event with no registerable key).
type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const eventSurfaceIsSingleSource: AssertEqual<keyof AgentHookHandlers, AgentHookEvent> = true;
void eventSurfaceIsSingleSource;

function context(overrides: Partial<AgentHookContext> = {}): AgentHookContext {
  return {
    session: new Session('agent-hooks-test'),
    turn: 1,
    step: 1,
    maxSteps: 5,
    isGoalMode: false,
    metadata: {},
    ...overrides,
  };
}

function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  return run().finally(() => { console.warn = original; }).then(() => warnings);
}

test('run dispatches a veto event by priority, then registration order', async () => {
  const registry = new AgentHookRegistry();
  const seen: string[] = [];
  registry.register('default-first', { 'agent/pre-step': () => { seen.push('default-first'); } });
  registry.register('late-but-high', { 'agent/pre-step': () => { seen.push('late-but-high'); } }, -10);
  registry.register('default-second', { 'agent/pre-step': () => { seen.push('default-second'); } });

  assert.deepEqual(await registry.run('agent/pre-step', context()), { allow: true });
  assert.deepEqual(seen, ['late-but-high', 'default-first', 'default-second']);
});

test('run short-circuits on rejection and names the hook in the default reason', async () => {
  const registry = new AgentHookRegistry();
  let observerCalls = 0;
  registry.register('blocker', { 'agent/pre-step': () => false }, -10);
  registry.register('observer', { 'agent/pre-step': () => { observerCalls += 1; } });

  const decision = await registry.run('agent/pre-step', context());
  assert.equal(decision.allow, false);
  assert.match(decision.reason ?? '', /"blocker"/);
  assert.equal(observerCalls, 0, 'the first rejection ends the veto pass');

  registry.register('reasoned', { 'agent/request': () => ({ allow: false, reason: 'approval-required' }) }, -20);
  assert.deepEqual(await registry.run('agent/request', context()), { allow: false, reason: 'approval-required' });
});

test('a crashing handler on a veto event is isolated and fails closed without ending the pass', async () => {
  const registry = new AgentHookRegistry();
  let laterCalls = 0;
  registry.register('crashy', { 'agent/pre-step': () => { throw new Error('plugin exploded'); } }, -10);
  registry.register('later', { 'agent/pre-step': () => { laterCalls += 1; } });

  const warnings = await captureWarnings(async () => {
    const decision = await registry.run('agent/pre-step', context());
    assert.equal(laterCalls, 1, 'one plugin crash must not mute the remaining hooks');
    assert.equal(decision.allow, false, 'a hook that could not answer has not approved the step');
    assert.match(decision.reason ?? '', /"crashy"/);
    assert.match(decision.reason ?? '', /plugin exploded/);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Agent hook "crashy" failed on agent\/pre-step: plugin exploded/);
});

test('notify reaches every handler and ignores decisions', async () => {
  const registry = new AgentHookRegistry();
  const seen: string[] = [];
  registry.register('denier', { 'agent/after-step': () => { seen.push('denier'); return false; } }, -10);
  registry.register('observer', { 'agent/after-step': () => { seen.push('observer'); } });
  registry.register('turn-observer', { 'agent/turn-stopping': () => { seen.push('turn-observer'); } });

  await registry.notify('agent/after-step', context({ reason: 'final-answer' }));
  assert.deepEqual(seen, ['denier', 'observer'], 'an observation is never a veto');

  await registry.notify('agent/turn-stopping', context({ reason: 'completed' }));
  assert.deepEqual(seen, ['denier', 'observer', 'turn-observer']);
});

test('notify swallows a handler crash so turn teardown always completes', async () => {
  const registry = new AgentHookRegistry();
  let secondCalls = 0;
  registry.register('crashy', { 'agent/turn-stopping': () => { throw new Error('boom'); } });
  registry.register('second', { 'agent/turn-stopping': () => { secondCalls += 1; } });

  const warnings = await captureWarnings(async () => {
    await registry.notify('agent/turn-stopping', context({ reason: 'completed' }));
  });
  assert.equal(secondCalls, 1);
  assert.match(warnings[0], /Agent hook "crashy" failed on agent\/turn-stopping: boom/);
});

test('register validates the id, and the returned closure unregisters', async () => {
  const registry = new AgentHookRegistry();
  assert.throws(() => registry.register('   ', {}), /must not be empty/);

  const dispose = registry.register('scoped', { 'agent/pre-step': () => {} });
  assert.throws(() => registry.register('scoped', {}), /already registered/);
  assert.deepEqual(registry.list(), ['scoped']);

  dispose();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.unregister('scoped'), false);
  assert.deepEqual(await registry.run('agent/pre-step', context()), { allow: true });
});

test('a hook that unregisters itself mid-run does not skip the hooks after it', async () => {
  const registry = new AgentHookRegistry();
  const seen: string[] = [];
  registry.register('self', {
    'agent/pre-step': () => {
      seen.push('self');
      registry.unregister('self');
    },
  });
  registry.register('after-self', { 'agent/pre-step': () => { seen.push('after-self'); } });

  await registry.run('agent/pre-step', context());
  assert.deepEqual(seen, ['self', 'after-self']);
  assert.deepEqual(registry.list(), ['after-self']);

  seen.length = 0;
  await registry.run('agent/pre-step', context());
  assert.deepEqual(seen, ['after-self']);
});

test('non-object and boolean results normalize to allow', async () => {
  const registry = new AgentHookRegistry();
  for (const value of [undefined, null, true, 'ok', 0, {}] as const) {
    const id = `shape-${String(value)}`;
    registry.register(id, { 'agent/request': () => value as unknown as AgentHookResult });
    assert.deepEqual(await registry.run('agent/request', context()), { allow: true }, `value ${String(value)}`);
    registry.unregister(id);
  }
});
