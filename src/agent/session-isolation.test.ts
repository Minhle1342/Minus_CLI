import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/session.js';
import { PlanManager } from './plan-manager.js';
import { GoalManager } from './goal-manager.js';
import { EffectLedger } from './effect-ledger.js';
import { SubagentManager } from './subagent-manager.js';
import { AgentRegistry } from './agent-registry.js';

const sid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

describe('per-session manager isolation', () => {
  it('effect prepare/commit land in the owning session log, not the bound one', () => {
    const ledger = new EffectLedger();
    const a = new Session(sid('a'));
    const b = new Session(sid('b'));
    ledger.bindSession(a);
    const effect = ledger.prepare('write_file', 'c1', true, a.id);
    ledger.bindSession(b); // switch tab giữa chừng
    ledger.commit(effect.id, 'success', 'tool-result-recorded', a.id);
    const aChanges = a.getEvents().filter((e) => e.type === 'effect/change');
    const bChanges = b.getEvents().filter((e) => e.type === 'effect/change');
    assert.equal(aChanges.length, 2); // prepared + committed đều vào log A
    assert.equal(bChanges.length, 0);
    assert.equal(a.getEffectStates().length, 1);
    assert.equal(a.getEffectStates()[0].status, 'committed');
    // Đường đọc cũ (không sessionId) vẫn theo active pointer.
    ledger.bindSession(a);
    assert.equal(ledger.list().length, 1);
  });

  it('plan tasks survive tab switches without rehydrate loss', () => {
    const plans = new PlanManager();
    const a = new Session(sid('a'));
    const b = new Session(sid('b'));
    plans.bindSession(a);
    plans.createPlan([{ title: 'Task A1' }]);
    assert.equal(plans.hasPlan(), true);
    plans.bindSession(b);
    assert.equal(plans.hasPlan(), false);
    assert.equal(plans.getTasks().length, 0);
    plans.bindSession(a);
    assert.equal(plans.getTasks().length, 1);
    assert.equal(plans.getTasks()[0].title, 'Task A1');
    plans.evictSession(a.id);
    assert.equal(plans.hasPlan(), false);
  });

  it('goal armed flag is per-session, not global', () => {
    const goals = new GoalManager();
    const a = new Session(sid('a'));
    const b = new Session(sid('b'));
    goals.bindSession(a);
    goals.create('Ship feature A');
    assert.equal(goals.isArmed(), true);
    goals.bindSession(b);
    assert.equal(goals.isArmed(), false);
    assert.equal(goals.getState(), undefined);
    goals.bindSession(a);
    assert.equal(goals.isArmed(), true);
    assert.equal(goals.getState()?.objective, 'Ship feature A');
    goals.evictSession(a.id);
    assert.equal(goals.getState(), undefined);
  });

  it('subagent delegation records land in the parent log, not the bound one', () => {
    const agents = new AgentRegistry();
    const neverSettles = () => new Promise<string>(() => {});
    const subs = new SubagentManager(agents, (() => ({ submit: neverSettles })) as never);
    const parentA = new Session(sid('parent-a'));
    const parentB = new Session(sid('parent-b'));
    subs.bindSession(parentA);
    const handle = subs.start('Do thing', { maxSteps: 1 });
    subs.bindSession(parentB); // switch tab trước khi subagent finish
    // Mô phỏng finish: recordState qua completion path với handle đã đăng ký.
    (subs as unknown as { recordState: (h: typeof handle) => void }).recordState({ ...handle, status: 'completed' });
    const aDelegations = parentA.getEvents().filter((e) => e.type === 'agent/delegation');
    const bDelegations = parentB.getEvents().filter((e) => e.type === 'agent/delegation');
    assert.equal(aDelegations.length, 2); // start-record + finish-record, đều vào log cha A
    assert.equal(bDelegations.length, 0);
  });
});
