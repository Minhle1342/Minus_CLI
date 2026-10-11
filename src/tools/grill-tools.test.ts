import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrillService } from '../agent/grill-service.js';
import { createGrillTools } from './grill-tools.js';
import { GrillPlugin, SPEC_CLARIFICATION_SECTION_ID } from '../kernel/plugins/grill-plugin.js';
import { PromptAssembler } from '../llm/prompt-assembler.js';
import { ThisTurnToolGate } from '../control/this-turn-tool-gate.js';
import { ClassificationEngine } from '../control/classification-engine.js';

const exec = (service: GrillService, args: Record<string, any>, context?: Record<string, any>) =>
  createGrillTools(service)[0].execute(args, {} as any, context as any);

test('ask_user reports unavailable headless instead of hanging the turn', async () => {
  const result = await exec(new GrillService(), { question: 'Triển khai ở đâu?' }, { sessionId: 's1', turn: 1 });
  assert.equal(result.picked, null);
  assert.equal(result.unavailable, true);
});

test('ask_user returns the user pick', async () => {
  const service = new GrillService();
  let seen: any;
  service.setPromptHandler(async (question, ctx, sessionId) => {
    seen = { question, ctx, sessionId };
    return 'Docker';
  });
  const result = await exec(service, { question: 'Chạy ở đâu?', context: 'cần cách ly' }, { sessionId: 's1', turn: 1 });
  assert.equal(result.picked, 'Docker');
  assert.deepEqual(seen, { question: 'Chạy ở đâu?', ctx: { sessionId: 's1', recentTranscript: ['cần cách ly'] }, sessionId: 's1' });
});

test('ask_user caps questions per turn so the model cannot interrogate forever', async () => {
  const service = new GrillService();
  service.setPromptHandler(async () => 'x');
  const ctx = { sessionId: 's1', turn: 3 };
  assert.equal((await exec(service, { question: 'Q1' }, ctx)).picked, 'x');
  assert.equal((await exec(service, { question: 'Q2' }, ctx)).picked, 'x');
  const third = await exec(service, { question: 'Q3' }, ctx);
  assert.equal(third.picked, null);
  assert.equal(third.capped, true);
  // Turn mới reset quota.
  assert.equal((await exec(service, { question: 'Q4' }, { sessionId: 's1', turn: 4 })).picked, 'x');
});

test('ask_user rejects empty question', async () => {
  const result = await exec(new GrillService(), { question: '  ' }, {});
  assert.ok(result.error);
});

test('GrillPlugin registers tool and prompt section together', async () => {
  const assembler = new PromptAssembler();
  const names: string[] = [];
  const service = new GrillService();
  await GrillPlugin.apply({ registerTool: (t: any) => { names.push(t.name); }, systemPrompt: assembler, grill: service } as any);
  assert.ok(names.includes('ask_user'));
  assert.ok(assembler.list().includes(SPEC_CLARIFICATION_SECTION_ID));
  await GrillPlugin.dispose?.({ systemPrompt: assembler } as any);
  assert.ok(!assembler.list().includes(SPEC_CLARIFICATION_SECTION_ID));
});

test('ask_user passes the turn gate in explore without approval friction', () => {
  const gate = new ThisTurnToolGate();
  const classification = new ClassificationEngine().classify({ request: 'Add a login page' });
  const decision = gate.decide(classification, createGrillTools(new GrillService()));
  assert.ok(decision.allowedToolNames.includes('ask_user'));
  assert.ok(!decision.approvalToolNames.includes('ask_user'));
});
