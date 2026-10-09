import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RateLimitPacer } from './rate-limit-pacer.js';

describe('Satellite 3: Token Pacer & Rate Limiter', () => {
  it('Scenario 1: Token dưới ngưỡng (< 85% TPM) -> không delay (0ms)', () => {
    const pacer = new RateLimitPacer({
      defaultTpmLimit: 100_000,
      safetyThresholdRatio: 0.85, // threshold = 85,000
    });

    pacer.recordActualUsage(20_000);
    pacer.recordActualUsage(30_000);

    // Current used = 50,000. Next estimated = 10,000. Projected = 60,000 <= 85,000.
    const delay = pacer.calculateRequiredDelay(10_000, 'default');
    assert.strictEqual(delay, 0);
  });

  it('Scenario 2: Token vượt 85% TPM -> delay chính xác và trigger onPace callback', async () => {
    const now = Date.now();
    const pacer = new RateLimitPacer({
      defaultTpmLimit: 100_000,
      safetyThresholdRatio: 0.85, // threshold = 85,000
      windowMs: 60_000,
      minDelayMs: 200,
      maxDelayMs: 5_000,
    });

    // Request 1: 50,000 tokens at now - 58,000 ms (will expire in 2,000 ms)
    pacer.recordActualUsage(50_000, now - 58_000);
    // Request 2: 30,000 tokens at now - 10,000 ms
    pacer.recordActualUsage(30_000, now - 10_000);

    // Total = 80,000. Next estimated = 15,000. Projected = 95,000 > 85,000.
    // Excess = 10,000 tokens. Request 1 has 50,000 tokens, which covers excess.
    // Expiration of Request 1 is (now - 58_000) + 60_000 = now + 2,000 ms.
    const delay = pacer.calculateRequiredDelay(15_000, 'default', now);
    assert.ok(delay >= 1_900 && delay <= 2_100, `Expected delay around 2000ms, got ${delay}`);

    let pacedEvent: any = null;
    await pacer.throttleBeforeRequest('anthropic', 'claude-3-5-sonnet', 15_000, undefined, (ev) => {
      pacedEvent = ev;
    });

    // onPace was called
    assert.ok(pacedEvent !== null);
    assert.strictEqual(pacedEvent.provider, 'anthropic');
    assert.strictEqual(pacedEvent.estimatedTokens, 15_000);
  });

  it('Scenario 3: Records older than 60s are pruned', () => {
    const now = Date.now();
    const pacer = new RateLimitPacer({
      defaultTpmLimit: 100_000,
      windowMs: 60_000,
    });

    pacer.recordActualUsage(40_000, now - 65_000); // expired
    pacer.recordActualUsage(20_000, now - 30_000); // active

    const used = pacer.getTokensUsedInWindow(now);
    assert.strictEqual(used, 20_000);
  });
});
