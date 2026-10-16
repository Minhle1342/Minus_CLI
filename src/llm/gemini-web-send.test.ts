import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickSendRobust, type ClickScope } from './gemini-web-playwright.js';

function fakeScope(failClicks: number, log: string[]): ClickScope {
  let n = 0;
  return {
    click: async (_sel: string) => {
      n++;
      if (n <= failClicks) throw new Error('no such element');
      log.push(`click-ok`);
    },
    pressEnter: async () => { log.push('enter'); },
  };
}

test('clickSendRobust uses second selector when first misses', async () => {
  const log: string[] = [];
  await clickSendRobust(fakeScope(1, log), ['a', 'b']);
  assert.deepEqual(log, ['click-ok']);
});

test('clickSendRobust falls back to Enter when all selectors miss', async () => {
  const log: string[] = [];
  await clickSendRobust(fakeScope(9, log), ['a', 'b']);
  assert.deepEqual(log, ['enter']);
});

test('clickSendRobust throws when clicks and Enter both fail', async () => {
  const scope: ClickScope = { click: async () => { throw new Error('x'); }, pressEnter: async () => { throw new Error('y'); } };
  await assert.rejects(() => clickSendRobust(scope, ['a']), /y/);
});
