import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PREFIX_CHURN_HISTORY,
  MAX_TRACKED_PREFIX_SESSIONS,
  PromptPrefixMonitor,
  hashPromptPrefixTools,
} from './prompt-prefix-monitor.js';

const tools = [
  { name: 'read_file', parameters: { type: 'object' } },
  { name: 'replace_text', parameters: { type: 'object' } },
];

test('first observation is a baseline, identical follow-up is not churn', () => {
  const monitor = new PromptPrefixMonitor();
  const first = monitor.observe({ sessionId: 's1', turn: 1, step: 1, systemPrompt: 'prompt', tools });
  assert.equal(first.changed, false);
  assert.deepEqual(first.reasons, []);
  assert.equal(first.toolCount, 2);

  const second = monitor.observe({ sessionId: 's1', turn: 1, step: 2, systemPrompt: 'prompt', tools });
  assert.equal(second.changed, false);
  assert.equal(second.systemChanged, false);
  assert.equal(second.toolsChanged, false);
  assert.equal(monitor.getStats().changes, 0);
  assert.equal(monitor.getStats().observations, 2);
});

test('system prompt change is attributed without blaming the tool set', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({ sessionId: 's1', turn: 1, step: 1, systemPrompt: 'prompt v1', tools });
  const report = monitor.observe({ sessionId: 's1', turn: 1, step: 2, systemPrompt: 'prompt v2', tools });

  assert.equal(report.changed, true);
  assert.equal(report.systemChanged, true);
  assert.equal(report.toolsChanged, false);
  assert.deepEqual(report.reasons, ['system-prompt']);
  assert.equal(monitor.getStats().systemChanges, 1);
  assert.equal(monitor.getStats().toolsChanges, 0);
});

test('tool set change is attributed to tools, and key order alone is not a change', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({ sessionId: 's1', turn: 1, step: 1, systemPrompt: 'prompt', tools });
  const report = monitor.observe({ sessionId: 's1', turn: 1, step: 2, systemPrompt: 'prompt', tools: [...tools].reverse() });
  assert.equal(report.changed, false, 'reordering the identical schema must not churn');

  const added = monitor.observe({
    sessionId: 's1', turn: 1, step: 3, systemPrompt: 'prompt',
    tools: [...tools, { name: 'run_command', parameters: { type: 'object' } }],
  });
  assert.equal(added.changed, true);
  assert.equal(added.toolsChanged, true);
  assert.equal(added.systemChanged, false);
  assert.deepEqual(added.reasons, ['tool-set']);
  assert.equal(added.toolCount, 3);

  const reorderedKeys = hashPromptPrefixTools([{ b: 2, a: 1 }]);
  assert.equal(reorderedKeys, hashPromptPrefixTools([{ a: 1, b: 2 }]));
});

test('new turn, phase shift and compaction are reported as causes', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({ sessionId: 's1', turn: 1, step: 1, systemPrompt: 'prompt', tools, phase: 'explore' });
  const turnReport = monitor.observe({ sessionId: 's1', turn: 2, step: 1, systemPrompt: 'prompt', tools, phase: 'explore' });
  assert.equal(turnReport.changed, true);
  assert.equal(turnReport.turnChanged, true);
  assert.deepEqual(turnReport.reasons, ['new-turn']);
  assert.equal(turnReport.previousTurn, 1);

  const phaseReport = monitor.observe({ sessionId: 's1', turn: 2, step: 2, systemPrompt: 'prompt v2', tools, phase: 'implement', compacted: true });
  assert.equal(phaseReport.changed, true);
  assert.ok(phaseReport.reasons.includes('phase'));
  assert.ok(phaseReport.reasons.includes('compaction'));
});

test('sessions are tracked independently and bounded', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({ sessionId: 'a', turn: 1, step: 1, systemPrompt: 'A', tools });
  const otherSession = monitor.observe({ sessionId: 'b', turn: 1, step: 1, systemPrompt: 'B', tools });
  assert.equal(otherSession.changed, false, 'a different session must not inherit another session baseline');

  for (let index = 0; index < MAX_TRACKED_PREFIX_SESSIONS + 10; index++) {
    monitor.observe({ sessionId: `s${index}`, turn: 1, step: 1, systemPrompt: 'prompt', tools });
  }
  assert.equal(monitor.getStats().trackedSessions, MAX_TRACKED_PREFIX_SESSIONS);
});

test('churn history is bounded and reset clears everything', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({ sessionId: 's1', turn: 1, step: 1, systemPrompt: 'v0', tools });
  for (let index = 1; index <= MAX_PREFIX_CHURN_HISTORY + 12; index++) {
    monitor.observe({ sessionId: 's1', turn: 1, step: index + 1, systemPrompt: `v${index}`, tools });
  }
  const recent = monitor.getRecentReports(100);
  assert.equal(recent.length, MAX_PREFIX_CHURN_HISTORY);
  assert.equal(recent[recent.length - 1].reasons.includes('system-prompt'), true);

  monitor.reset();
  assert.deepEqual(monitor.getStats(), {
    observations: 0, changes: 0, systemChanges: 0, toolsChanges: 0, turnChanges: 0, trackedSessions: 0,
  });
  assert.deepEqual(monitor.getRecentReports(), []);
});

test('T3-only change keeps the stable prefix and is not churn', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({
    sessionId: 's1', turn: 1, step: 1, systemPrompt: 'sys tail A', tools,
    stablePrefixHash: 'stable-1',
    sections: [
      { id: 'core', tier: 'T0', contentHash: 'core-a' },
      { id: 'tail', tier: 'T3', contentHash: 'tail-1' },
    ],
  });
  const report = monitor.observe({
    sessionId: 's1', turn: 1, step: 2, systemPrompt: 'sys tail B', tools,
    stablePrefixHash: 'stable-1',
    sections: [
      { id: 'core', tier: 'T0', contentHash: 'core-a' },
      { id: 'tail', tier: 'T3', contentHash: 'tail-2' },
    ],
  });

  assert.equal(report.systemChanged, true);
  assert.equal(report.stablePrefixChanged, false);
  assert.equal(report.changed, false, 'T3 churn must not invalidate the provider cache');
  assert.deepEqual(report.changedSections, []);
  assert.deepEqual(report.changedTiers, []);
});

test('stable prefix change outside a boundary is flagged with the exact sections', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({
    sessionId: 's1', turn: 1, step: 1, systemPrompt: 'sys', tools, phase: 'implement',
    stablePrefixHash: 'stable-1',
    sections: [{ id: 'repo-rules', tier: 'T1', contentHash: 'old' }],
  });
  const report = monitor.observe({
    sessionId: 's1', turn: 1, step: 2, systemPrompt: 'sys', tools, phase: 'implement',
    stablePrefixHash: 'stable-2',
    sections: [{ id: 'repo-rules', tier: 'T1', contentHash: 'new' }],
  });

  assert.equal(report.changed, true);
  assert.equal(report.stablePrefixChanged, true);
  assert.equal(report.unexpectedStableChurn, true);
  assert.deepEqual(report.changedSections, ['repo-rules']);
  assert.deepEqual(report.changedTiers, ['T1']);
  assert.ok(report.reasons.includes('stable-prefix'));
});

test('stable prefix change at a phase boundary is expected', () => {
  const monitor = new PromptPrefixMonitor();
  monitor.observe({
    sessionId: 's1', turn: 1, step: 1, systemPrompt: 'sys', tools, phase: 'explore',
    stablePrefixHash: 'stable-1', sections: [{ id: 'a', tier: 'T1', contentHash: 'x' }],
  });
  const report = monitor.observe({
    sessionId: 's1', turn: 1, step: 2, systemPrompt: 'sys', tools, phase: 'implement',
    stablePrefixHash: 'stable-2', sections: [{ id: 'a', tier: 'T1', contentHash: 'y' }],
  });

  assert.equal(report.stablePrefixChanged, true);
  assert.equal(report.unexpectedStableChurn, false);
  assert.ok(report.reasons.includes('phase'));
});

test('strict assertion mode throws on unexpected stable churn', () => {
  const previous = process.env.MINUS_ASSERT_STABLE_PREFIX;
  process.env.MINUS_ASSERT_STABLE_PREFIX = '1';
  try {
    const monitor = new PromptPrefixMonitor();
    monitor.observe({
      sessionId: 's1', turn: 1, step: 1, systemPrompt: 'sys', tools,
      stablePrefixHash: 'stable-1', sections: [{ id: 'a', tier: 'T1', contentHash: 'x' }],
    });
    assert.throws(
      () => monitor.observe({
        sessionId: 's1', turn: 1, step: 2, systemPrompt: 'sys', tools,
        stablePrefixHash: 'stable-2', sections: [{ id: 'a', tier: 'T1', contentHash: 'y' }],
      }),
      /Stable prompt prefix changed outside an allowed boundary/,
    );
  } finally {
    if (previous === undefined) delete process.env.MINUS_ASSERT_STABLE_PREFIX;
    else process.env.MINUS_ASSERT_STABLE_PREFIX = previous;
  }
});
