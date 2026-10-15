import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaywrightTransport, type GeminiWebPage } from './gemini-web-playwright.js';

function fakePage(script: { generating: boolean[]; texts: string[] }): { page: GeminiWebPage; log: string[] } {
  const log: string[] = [];
  let polls = 0;
  const page: GeminiWebPage = {
    url: () => 'https://gemini.google.com/app',
    bringToFront: async () => { log.push('front'); },
    fillInput: async (text: string) => { log.push(`fill:${text.length}`); },
    clickSend: async () => { log.push('send'); },
    clickStop: async () => { log.push('stop'); },
    isGenerating: async () => script.generating[Math.min(polls, script.generating.length - 1)],
    responseText: async () => {
      const t = script.texts[Math.min(polls, script.texts.length - 1)];
      polls++;
      return t;
    },
  };
  return { page, log };
}

test('transport fills, sends, then streams deltas until stable', async () => {
  const { page, log } = fakePage({ generating: [true, true, false, false], texts: ['hi', 'hi there', 'hi there', 'hi there'] });
  const t = new PlaywrightTransport(async () => page, { pollMs: 10, stableMs: 20 });
  const chunks: string[] = [];
  for await (const c of t.send('hello')) chunks.push(c);
  assert.deepEqual(log[0], 'front');
  assert.ok(log[1].startsWith('fill:'));
  assert.equal(log[2], 'send');
  assert.equal(chunks.join(''), 'hi there');
});

test('transport cancel clicks stop on the live tab', async () => {
  const { page, log } = fakePage({ generating: [false, false], texts: ['r', 'r'] });
  const t = new PlaywrightTransport(async () => page, { pollMs: 10, stableMs: 20 });
  for await (const _ of t.send('hi')) { /* kết nối tab */ }
  log.length = 0;
  await t.cancel();
  assert.ok(log.includes('stop'));
});
