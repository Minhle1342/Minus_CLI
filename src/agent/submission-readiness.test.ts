import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/session.js';
import { VerificationPolicy } from '../skills/verification-policy.js';
import { CompletionEvidenceGate } from './completion-evidence.js';
import { evaluateSubmission, SubmissionReadiness, withObservedSubmissionMetadata } from './submission-readiness.js';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';

const summary = 'The string conflicts with the declared number type.';
function context(session = new Session()) {
  return { session, turn: 1, userRequest: 'Explain the type error; read only.', workspaceRoot: process.cwd(),
    codeChangeRequired: false, verificationPolicy: new VerificationPolicy(), evidenceGate: new CompletionEvidenceGate(), evidenceEnabled: true };
}
function snapshot(session = new Session()) {
  return { session, turn: 1, userRequest: 'Explain the type error; read only.', workspaceRoot: process.cwd(), plan: null, activeAgents: 0 };
}
function observed(session: Session, name: string, args: any, result: any) {
  const id = `tool-${session.seq}`;
  session.append('tool/call', { turn: 1, toolName: name, toolCallId: id, args });
  session.append('tool/result', { turn: 1, toolName: name, toolCallId: id, result });
}

test('shared preflight rejects stubs and unsupported claims instead of arming ready state', () => {
  for (const answer of ['Done.', 'I ran npm test and all tests passed.']) {
    const check = evaluateSubmission({ summary: answer }, context());
    assert.equal(check.allowed, false);
    assert.equal(new SubmissionReadiness().arm(check.payload, snapshot(), check.allowed), false);
  }
  assert.equal(evaluateSubmission({ summary }, context()).allowed, true);
});

test('passing tests without the required mutation are not task completion', () => {
  const ctx = context();
  observed(ctx.session, 'run_command', { command: 'npm test' }, { success: true, exitCode: 0 });
  assert.equal(evaluateSubmission({ summary: 'Fixed the type error.' }, { ...ctx, codeChangeRequired: true }).allowed, false);
});

test('verification must follow latest actual edit; blocked, empty and scratch results are not sufficient', () => {
  for (const result of [{ success: false, exitCode: 1 }, { success: true, processStarted: false, exitCode: 0 }]) {
    const ctx = context();
    observed(ctx.session, 'write_file', { path: 'src/example.ts' }, { success: true });
    observed(ctx.session, 'run_command', { command: 'npm test' }, result);
    assert.equal(evaluateSubmission({ summary: 'Updated src/example.ts.' }, ctx).allowed, false);
  }
  const ctx = context();
  observed(ctx.session, 'write_file', { path: 'src/example.ts' }, { success: true });
  observed(ctx.session, 'run_command', { command: 'node scratch/check.js' }, { success: true, exitCode: 0 });
  assert.equal(evaluateSubmission({ summary: 'Updated src/example.ts.' }, ctx).allowed, false);
  observed(ctx.session, 'run_command', { command: 'npm test' }, { success: true, exitCode: 0 });
  assert.equal(evaluateSubmission({ summary: 'Updated src/example.ts.' }, ctx).allowed, true);
  observed(ctx.session, 'write_file', { path: 'src/example.ts' }, { success: true });
  assert.equal(evaluateSubmission({ summary: 'Updated src/example.ts.' }, ctx).allowed, false);
});

test('runtime fills omitted metadata only from the same turn, never changes explicit claims', () => {
  const ctx = context();
  observed(ctx.session, 'write_file', { path: 'src/example.ts' }, { success: true });
  observed(ctx.session, 'run_command', { command: 'npm run build' }, { success: true, exitCode: 0 });
  const payload = withObservedSubmissionMetadata({ summary }, ctx.session, 1);
  assert.deepEqual(payload.filesModified, ['src/example.ts']);
  assert.equal(payload.verificationEvidence, 'npm run build');
  assert.equal(payload.verificationMethod, 'direct_validation', 'do not call a build a test suite');
  assert.equal(payload.summary, summary);
  const explicit = withObservedSubmissionMetadata({ summary, verificationEvidence: 'invented command', verificationMethod: 'not_applicable' as const }, ctx.session, 1);
  assert.equal(explicit.verificationEvidence, 'invented command');
  assert.equal(explicit.verificationMethod, 'not_applicable');
  assert.equal(withObservedSubmissionMetadata({ summary }, ctx.session, 2).verificationEvidence, undefined);
});

test('tickets ignore prompt bookkeeping but invalidate on user scope, evidence, plan and agent changes', () => {
  const base = snapshot();
  base.session.addUserMessage(base.userRequest);
  const ticket = new SubmissionReadiness();
  assert.equal(ticket.arm({ summary }, base, true), true);
  base.session.addUserMessage('Submit the answer now.', 'system');
  base.session.append('control/decision', { turn: 1 });
  assert.ok(ticket.current(base));
  base.session.addUserMessage('Now edit the file instead.');
  assert.equal(ticket.current(base), undefined);
  ticket.arm({ summary }, base, true);
  observed(base.session, 'run_command', {}, { success: false });
  assert.equal(ticket.current(base), undefined);
  ticket.arm({ summary }, base, true);
  assert.equal(ticket.current({ ...base, plan: { tasks: ['new'] } }), undefined);
  ticket.arm({ summary }, base, true);
  assert.equal(ticket.current({ ...base, activeAgents: 1 }), undefined);
  assert.equal(ticket.arm({ summary }, { ...base, planBlocker: 'pending acceptance criterion' }, true), false);
  base.session.append('tool/call', { turn: 1, toolCallId: 'pending', toolName: 'run_command' });
  assert.equal(ticket.arm({ summary }, base, true), false);
});

test('an external change to a tracked artifact invalidates a ticket', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-artifact-'));
  try {
    await fs.writeFile(path.join(root, 'a.ts'), 'original');
    const base = { ...snapshot(), workspaceRoot: root };
    observed(base.session, 'write_file', { path: 'a.ts' }, { success: true });
    const ticket = new SubmissionReadiness();
    ticket.arm({ summary }, base, true);
    assert.ok(ticket.current(base));
    await fs.writeFile(path.join(root, 'a.ts'), 'external edit');
    assert.equal(ticket.current(base), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('queued user requests and unreadable artifacts fail closed', async () => {
  const base = snapshot();
  const ticket = new SubmissionReadiness();
  assert.equal(ticket.arm({ summary }, base, true), true);
  base.session.append('input/queued', { inputId: 'new-scope', inputText: 'Also fix the bug.', source: 'human' });
  assert.equal(ticket.current(base), undefined);
  assert.equal(ticket.arm({ summary }, base, true), false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-unreadable-'));
  try {
    const unreadable = { ...snapshot(), workspaceRoot: root };
    await fs.mkdir(path.join(root, 'a.ts'));
    observed(unreadable.session, 'write_file', { path: 'a.ts' }, { success: true });
    assert.equal(ticket.arm({ summary }, unreadable, true), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('valid draft restricts tool choice without changing the schema prefix or adding a model call', async () => {
  for (const toolControlMode of ['off', 'enforce'] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-loop-'));
    try {
      const schemas: any[] = [], requests: any[] = [];
      const llm = { async generate(_session: Session, tools: any[], request: any) {
        schemas.push(tools); requests.push(request);
        return schemas.length === 1 ? { text: summary, toolCalls: [] }
          : { toolCalls: [{ name: 'submit_solution', args: { summary } }] };
      } };
      const session = new Session(); session.addUserMessage('Explain the type error; read only.');
      const loop = new AgentLoop(llm, new ToolRegistry(), { workspace: new Workspace(root), maxSteps: 4, toolControlMode });
      assert.equal(await loop.run(session), summary);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].functionCallingMode, undefined);
      assert.equal(requests[1].functionCallingMode, 'ANY');
      assert.deepEqual(requests[1].allowedFunctionNames, ['submit_solution']);
      assert.deepEqual(schemas[1], schemas[0]);
      assert.equal(session.getEvents().filter(event => event.type === 'tool/result' && event.data.result?.success === false).length, 0);
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});

test('a rejected submission restores the ordinary tool surface rather than trapping the model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-recovery-'));
  try {
    const requests: any[] = [];
    const replies = [{ text: summary, toolCalls: [] }, { toolCalls: [{ name: 'submit_solution', args: { summary: 'Done.' } }] },
      { toolCalls: [{ name: 'submit_solution', args: { summary } }] }];
    const llm = { async generate(_session: Session, _tools: any[], request: any) { requests.push(request); return replies[requests.length - 1]; } };
    const session = new Session(); session.addUserMessage('Explain the type error; read only.');
    const loop = new AgentLoop(llm, new ToolRegistry(), { workspace: new Workspace(root), maxSteps: 4 });
    assert.equal(await loop.run(session), summary);
    assert.equal(requests[1].functionCallingMode, 'ANY');
    assert.equal(requests[2].functionCallingMode, undefined);
    assert.ok(requests[2].allowedFunctionNames.length > 1);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
