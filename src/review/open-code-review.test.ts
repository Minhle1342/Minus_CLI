import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentKernel } from '../kernel/kernel.js';
import { SuperpowersPlugin } from '../kernel/plugins/superpowers-plugin.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import {
  OcrReviewService,
  type OcrProcessRunner,
} from './open-code-review.js';

interface RunnerFixture {
  service: OcrReviewService;
  root: string;
  calls: Array<{ command: string; args: string[] }>;
  cleanup: () => Promise<void>;
}

async function createFixture(
  payload: Record<string, unknown> | string,
  options: { exitCode?: number; stderr?: string } = {},
): Promise<RunnerFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-ocr-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.opencodereview'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'example.ts'), 'export const value = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, '.opencodereview', 'rule.json'), '{"rules":[]}\n', 'utf8');
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: OcrProcessRunner = async (spec) => {
    calls.push({ command: spec.command, args: [...spec.args] });
    if (spec.command === 'git') {
      return {
        exitCode: 0,
        stdout: 'diff --git a/src/example.ts b/src/example.ts\n+export const value = 1;\n',
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    if (spec.args.at(-1) === 'version') {
      return {
        exitCode: 0,
        stdout: 'open-code-review v1.12.5\n',
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    if (spec.args.includes('llm') && spec.args.includes('test')) {
      return {
        exitCode: 0,
        stdout: 'LLM connectivity OK\n',
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    return {
      exitCode: options.exitCode ?? 0,
      stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
      stderr: options.stderr || '',
      timedOut: false,
      aborted: false,
    };
  };
  return {
    service: new OcrReviewService(root, { runner }),
    root,
    calls,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function reviewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'success',
    comments: [],
    warnings: [],
    summary: { files_reviewed: 1, total_tokens: 1200, elapsed: '2s' },
    llm: { provider: 'test', model: 'test-model' },
    thinking: 'must never be persisted',
    ...overrides,
  };
}

test('completion gate blocks high findings and persists only the sanitized contract', async (t) => {
  const fixture = await createFixture(reviewPayload({
    comments: [{
      path: 'src/example.ts',
      start_line: 1,
      end_line: 1,
      category: 'security',
      severity: 'high',
      content: 'Untrusted input can reach process execution.',
      thinking: 'private chain of thought',
    }],
  }));
  t.after(fixture.cleanup);
  fixture.service.updateConfig({ enabled: true });

  const decision = await fixture.service.evaluateCompletion({
    session: new Session(),
    filesModified: ['src/example.ts'],
    background: 'Review the implementation.',
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'review-blocked');
  assert.equal(decision.blockingFindings.length, 1);
  const artifact = await fs.readFile(path.join(fixture.root, decision.run!.artifactRef!), 'utf8');
  assert.equal(artifact.includes('must never be persisted'), false);
  assert.equal(artifact.includes('private chain of thought'), false);
});

test('medium findings are advisory and identical input reuses the cached review', async (t) => {
  const fixture = await createFixture(reviewPayload({
    comments: [{
      path: 'src/example.ts',
      start_line: 1,
      end_line: 1,
      category: 'maintainability',
      severity: 'medium',
      content: 'Extract this expression if it grows further.',
    }],
  }));
  t.after(fixture.cleanup);
  fixture.service.updateConfig({ enabled: true });
  const session = new Session();

  const first = await fixture.service.evaluateCompletion({ session, filesModified: ['src/example.ts'] });
  const second = await fixture.service.evaluateCompletion({ session, filesModified: ['src/example.ts'] });

  assert.equal(first.allow, true);
  assert.equal(first.advisoryFindings.length, 1);
  assert.equal(second.run?.runId, first.run?.runId);
  const reviewCalls = fixture.calls.filter((call) => call.command !== 'git');
  assert.equal(reviewCalls.length, 1);
});

test('warnings, malformed output, and execution errors fail closed', async (t) => {
  const warningFixture = await createFixture(reviewPayload({
    status: 'completed_with_warnings',
    warnings: ['one file was not reviewed'],
  }));
  t.after(warningFixture.cleanup);
  warningFixture.service.updateConfig({ enabled: true });
  const warningDecision = await warningFixture.service.evaluateCompletion({
    session: new Session(),
    filesModified: ['src/example.ts'],
  });
  assert.equal(warningDecision.allow, false);
  assert.equal(warningDecision.reason, 'review-inconclusive');

  const malformedFixture = await createFixture('{not-json');
  t.after(malformedFixture.cleanup);
  malformedFixture.service.updateConfig({ enabled: true });
  const malformedDecision = await malformedFixture.service.evaluateCompletion({
    session: new Session(),
    filesModified: ['src/example.ts'],
  });
  assert.equal(malformedDecision.allow, false);
  assert.equal(malformedDecision.run?.errorCode, 'OCR_INVALID_OUTPUT');

  const errorFixture = await createFixture('', { exitCode: 1, stderr: 'provider unavailable' });
  t.after(errorFixture.cleanup);
  errorFixture.service.updateConfig({ enabled: true });
  const errorDecision = await errorFixture.service.evaluateCompletion({
    session: new Session(),
    filesModified: ['src/example.ts'],
  });
  assert.equal(errorDecision.allow, false);
  assert.equal(errorDecision.run?.errorCode, 'OCR_EXECUTION_FAILED');
});

test('only a session-scoped human waiver releases a matching blocking finding', async (t) => {
  const fixture = await createFixture(reviewPayload({
    comments: [{
      path: 'src/example.ts',
      category: 'bug',
      severity: 'critical',
      content: 'This branch can corrupt persisted state.',
    }],
  }));
  t.after(fixture.cleanup);
  fixture.service.updateConfig({ enabled: true });
  const session = new Session();
  const blocked = await fixture.service.evaluateCompletion({ session, filesModified: ['src/example.ts'] });

  fixture.service.waive(session, blocked.blockingFindings[0].id, 'Accepted temporarily by the human operator.');
  const released = await fixture.service.evaluateCompletion({ session, filesModified: ['src/example.ts'] });

  assert.equal(released.allow, true);
  assert.equal(released.blockingFindings.length, 0);
});

test('disabled and non-code changes bypass OCR; doctor and arguments remain structured', async (t) => {
  const fixture = await createFixture(reviewPayload());
  t.after(fixture.cleanup);
  const disabled = await fixture.service.evaluateCompletion({
    session: new Session(),
    filesModified: ['src/example.ts'],
  });
  assert.equal(disabled.reason, 'disabled');
  assert.equal(fixture.calls.length, 0);

  fixture.service.updateConfig({ enabled: true });
  const docsOnly = await fixture.service.evaluateCompletion({
    session: new Session(),
    filesModified: ['README.md'],
  });
  assert.equal(docsOnly.reason, 'not-applicable');
  assert.equal(fixture.calls.length, 0);

  const doctor = await fixture.service.doctor({ testLlm: true });
  assert.equal(doctor.ok, true);
  await fixture.service.run({
    mode: 'workspace',
    paths: ['src/example.ts'],
    background: 'quoted value; echo should-not-run',
    force: true,
  });
  const ocrCall = fixture.calls.find((call) => call.args.includes('--background'))!;
  const backgroundIndex = ocrCall.args.indexOf('--background');
  assert.equal(ocrCall.args[backgroundIndex + 1], 'quoted value; echo should-not-run');
  const ruleIndex = ocrCall.args.indexOf('--rule');
  assert.equal(ocrCall.args[ruleIndex + 1], path.join(fixture.root, '.opencodereview', 'rule.json'));
});

test('SuperpowersPlugin registers the OCR service and review tools in the kernel', async (t) => {
  const fixture = await createFixture(reviewPayload());
  t.after(fixture.cleanup);
  const kernel = new AgentKernel(new Workspace(fixture.root));
  await kernel.use(new SuperpowersPlugin());
  t.after(() => kernel.unuse('superpowers'));

  assert.ok((kernel.ctx as any).ocrReview instanceof OcrReviewService);
  assert.ok(kernel.ctx.tools.get('run_code_review'));
  assert.ok(kernel.ctx.tools.get('get_code_review_status'));
});
