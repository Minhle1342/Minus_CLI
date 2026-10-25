import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPhaseToolEffect } from './phase-tool-effects.js';
import { ThisTurnToolGate } from './this-turn-tool-gate.js';
import { ClassificationEngine } from './classification-engine.js';

const tool = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } }) as any;
const cwd = process.cwd();
const exploreDecision = new ClassificationEngine().classify({ request: 'read-only: hãy phân task cho sub agent', hasPlan: false });

test('orchestration tools stay usable before implementation, file mutators do not', () => {
  for (const name of ['delegate_task', 'delegate_agent', 'spawn_agent', 'message_agent', 'schedule_dag_parallel']) {
    assert.equal(checkPhaseToolEffect(tool(name), {}, 'explore', cwd).allowed, true, `${name} must be allowed in explore`);
    assert.equal(checkPhaseToolEffect(tool(name), {}, 'plan', cwd).allowed, true, `${name} must be allowed in plan`);
  }
  assert.equal(checkPhaseToolEffect(tool('write_file'), {}, 'explore', cwd).allowed, false);
  assert.equal(checkPhaseToolEffect(tool('read_file'), {}, 'explore', cwd).allowed, true);
});

test('classification marks explicit subagent requests with delegate capability', () => {
  const engine = new ClassificationEngine();
  for (const request of [
    'hãy phân task cho sub agent',
    'ủy thác việc này cho subagent',
    'cho 2 agent chạy song song',
    'giao việc cho sub-agent đi',
    'delegate this to a subagent',
    'điều phối các agent',
  ]) {
    const decision = engine.classify({ request });
    assert.equal(decision.requiredCapabilities.includes('delegate'), true, `${request} → delegate capability`);
    assert.equal(decision.reasonCodes.includes('EXPLICIT_DELEGATION_INTENT'), true, `${request} → reason code`);
    assert.notEqual(decision.risk, 'R0', `${request} → risk floor R1`);
  }
  const plain = engine.classify({ request: 'fix the failing parser test' });
  assert.equal(plain.requiredCapabilities.includes('delegate'), false);
  assert.equal(plain.reasonCodes.includes('EXPLICIT_DELEGATION_INTENT'), false);
});

test('phase gate authorizes delegation in explore even in enforce mode', () => {
  const gate = new ThisTurnToolGate();
  const tools = [
    tool('delegate_task'), tool('delegate_agent'), tool('spawn_agent'), tool('schedule_dag_parallel'),
    tool('read_file'), tool('write_file'),
  ];
  const decision = gate.decide(exploreDecision, tools);
  const authorized = new Set(decision.toolSurface.authorizedToolNames);
  for (const name of ['delegate_task', 'delegate_agent', 'spawn_agent', 'schedule_dag_parallel']) {
    assert.equal(authorized.has(name), true, `${name} must be authorized in explore`);
  }
  assert.equal(authorized.has('read_file'), true);
  assert.equal(authorized.has('write_file'), false);
});
