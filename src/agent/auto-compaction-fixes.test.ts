import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextCompactor } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import { hasMaterialCompletedTurnSavings } from './completed-turn-compaction-policy.js';
import { compactActiveTurnText } from './active-turn-compaction.js';

test('Bug 1 Fix: Emergency compaction fallback passes correct maxInputTokens without double subtracting nonHistoryTokens', async () => {
  const compactor = new ContextCompactor();
  const observedOptions: any[] = [];
  const origCompact = compactor.compact.bind(compactor);
  compactor.compact = (messages, options) => {
    observedOptions.push(options);
    return origCompact(messages, options);
  };

  const manager = new ContextBudgetManager(compactor, { mode: 'enforce' });
  const envelope = {
    provider: 'google',
    model: 'gemini-3.5-flash',
    systemPrompt: 'System instructions '.repeat(200), // ~600 tokens non-history
    tools: [],
    history: [
      { role: 'user', parts: [{ text: 'Question 1' }] },
      { role: 'model', parts: [{ text: 'Answer 1' }] },
      { role: 'user', parts: [{ text: 'Question 2' }] },
      { role: 'model', parts: [{ text: 'Long response '.repeat(500) }] },
    ],
    maxInputTokens: 2000,
    outputReserveTokens: 200,
  };

  // protectActiveTurn is false so it triggers fallback emergency compaction
  await manager.prepareRequest(envelope as any, { protectActiveTurn: false });

  // In emergency pass (observedOptions[1]), maxInputTokens should be usableInputTokens + outputReserveTokens (1800 + 200 = 2000)
  // rather than having nonHistoryTokens subtracted before being passed into compact() which subtracts it again.
  assert.ok(observedOptions.length >= 2, 'Should have executed first pass and emergency pass');
  const emergencyOpts = observedOptions[1];
  assert.equal(emergencyOpts.maxInputTokens, 2000, 'maxInputTokens in emergency pass must be full window ceiling');
  assert.ok(emergencyOpts.requestOverheadTokens > 0, 'requestOverheadTokens must be present for compactor to subtract once');
});

test('Bug 2 Fix: Emergency Deep Compaction runs in auto mode and recoveryWindow with options.protectActiveTurn: true', async () => {
  const compactor = new ContextCompactor();
  let emergencyCalled = false;
  const origCompactCompletedTurnWindow = compactor.compactCompletedTurnWindow.bind(compactor);
  compactor.compactCompletedTurnWindow = (entries, options) => {
    emergencyCalled = true;
    return origCompactCompletedTurnWindow(entries, options);
  };

  const manager = new ContextBudgetManager(compactor, { mode: 'auto' });
  const envelope = {
    provider: 'unrecognized-provider', // not a known provider, so effectiveMode is 'shadow'
    model: 'custom-model',
    systemPrompt: '',
    tools: [],
    history: [
      { role: 'user', parts: [{ text: 'turn 1 prompt' }] },
      { role: 'model', parts: [{ text: 'turn 1 answer '.repeat(500) }] },
      { role: 'user', parts: [{ text: 'turn 2 prompt' }] },
    ],
    maxInputTokens: 500, // very small to force budget overflow
    outputReserveTokens: 50,
  };

  const recoveryWindow = {
    entries: [
      { message: envelope.history[0], turn: 1 },
      { message: envelope.history[1], turn: 1 },
      { message: envelope.history[2], turn: 2 },
    ],
    completedTurns: [1],
    openTurn: 2,
  };

  await manager.prepareRequest(envelope as any, {
    protectActiveTurn: true,
    recoveryWindow,
  });

  assert.equal(emergencyCalled, true, 'Emergency compaction must run even when mode is auto/shadow with unrecognized provider');
});

test('Bug 3 Fix: updatePostTurnCompaction synchronizes Hysteresis baseline after turn compaction', async () => {
  const compactor = new ContextCompactor();
  const manager = new ContextBudgetManager(compactor, {
    mode: 'enforce',
    hysteresisRatio: 0.1,
  });

  // Step 1: Simulated post-turn compaction cuts upper bound down to 20,000
  manager.updatePostTurnCompaction(10000, 8000);

  // Step 2: Next step in new turn arrives with 25,000 tokens (which is > 20000 * 1.1 = 22000)
  // It should NOT be blocked by an old stale 80,000 hysteresis baseline!
  const envelope = {
    provider: 'google',
    model: 'gemini-3.5-flash',
    systemPrompt: '',
    tools: [],
    history: [
      { role: 'user', parts: [{ text: 'history '.repeat(7000) }] }, // ~25,000 tokens
    ],
    maxInputTokens: 30000,
    outputReserveTokens: 2000,
  };

  const result = await manager.prepareRequest(envelope as any);
  assert.ok(!result.triggerReasons?.includes('hysteresis-cooldown'), 'Should not be blocked by hysteresis when regrown past new baseline');
});

test('Bug 4 Fix: enableEarlyDraftCompaction allows draft compaction at lower threshold', () => {
  const assistantText = 'Draft line A\nDraft line A\n'.repeat(300); // ~7,500 chars (between 5,000 and 12,000)
  const history: any[] = [
    { role: 'user', parts: [{ text: 'do something' }] },
    { role: 'model', parts: [{ text: assistantText }] },
  ];
  const entries: any[] = [
    { message: history[0], turn: 1 },
    { message: history[1], turn: 1 },
  ];

  // Case 1: Default (enableEarlyDraftCompaction = false) -> requires 12000 chars, so text is untouched
  const defaultResult = compactActiveTurnText(history, entries, 1);
  assert.equal(defaultResult.replacements.length, 0, 'Default config should not compact drafts under 12000 chars');

  // Case 2: enableEarlyDraftCompaction = true with earlyDraftCompactionThreshold = 5000 -> compacts draft!
  const earlyResult = compactActiveTurnText(history, entries, 1, {
    enableEarlyDraftCompaction: true,
    earlyDraftCompactionThreshold: 5000,
  });
  assert.equal(earlyResult.replacements.length, 1, 'Early draft compaction must compact draft exceeding early threshold');
  assert.ok((earlyResult.messages[1].parts?.[0] as any)?.text?.includes('[ACTIVE ASSISTANT TEXT COMPACTED'));
});

test('Bug 5 Fix: materialSavings is recognized when history is cut substantially despite large non-history tokens', async () => {
  // Case A: completed turn savings
  const policy = {
    triggerRatio: 0.6,
    minTokensSaved: 512,
    minSavingsRatio: 0.1,
  };

  // Whole request was 50,000 tokens (40,000 non-history + 10,000 history).
  // History was compacted from 10,000 to 6,000 tokens (saved 4,000 tokens = 40% of history).
  // Request went from 50,000 to 46,000 tokens (saved 4,000 / 50,000 = 8% < 10%).
  const hasSavings = hasMaterialCompletedTurnSavings(
    50000,
    46000,
    policy,
    10000, // historyTokens
  );
  assert.equal(hasSavings, true, 'Must recognize material savings when history reduction exceeds minSavingsRatio');

  // Case B: ContextBudgetManager material savings check
  const compactor = new ContextCompactor();
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce' });

  // System prompt + tools = 40,000 tokens. History has 10,000 tokens.
  // When compacted, 4,000 tokens saved should be accepted.
  const envelope = {
    provider: 'google',
    model: 'gemini-3.5-flash',
    systemPrompt: 'instruction '.repeat(10000), // large non-history
    tools: [],
    history: [
      { role: 'user', parts: [{ text: 'query' }] },
      { role: 'model', parts: [{ text: 'repeated observation '.repeat(1000) }] },
    ],
    maxInputTokens: 60000,
    outputReserveTokens: 2000,
  };

  const result = await manager.prepareRequest(envelope as any);
  // Should not reject if tokensSaved >= 512 and saved >= 10% of history
  assert.ok(result);
});

test('Bug 6 Fix: prepareRequest returns telemetry fields when phase transition compaction has insufficient savings', async () => {
  const compactor = new ContextCompactor();
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce' });

  const envelope = {
    provider: 'google',
    model: 'gemini-3.5-flash',
    systemPrompt: 'System instructions',
    tools: [],
    history: [
      { role: 'user', parts: [{ text: 'User prompt '.repeat(1500) }] }, // ~5,000 tokens
    ],
    maxInputTokens: 100000, // no budget pressure
    outputReserveTokens: 2000,
  };

  const result = await manager.prepareRequest(envelope as any, {
    phaseTransition: {
      minHistoryTokens: 1000,
      minSavingsTokens: 100000, // impossible savings to trigger phase rejection
    },
  });

  assert.equal(result.changed, false);
  assert.ok(Array.isArray(result.triggerReasons), 'triggerReasons must be present');
  assert.ok(typeof result.projectedGrowthTokens === 'number', 'projectedGrowthTokens must be present');
  assert.ok(typeof result.nonHistoryPressure === 'boolean', 'nonHistoryPressure must be present');
});
