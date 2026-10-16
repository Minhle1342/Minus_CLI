import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaywrightTransport, PROTOCOL_BOOTSTRAP, type GeminiWebPage } from './gemini-web-playwright.js';

function fakePage(script: { generating: boolean[]; texts: string[] }, log: string[]): GeminiWebPage {
  let polls = 0;
  return {
    url: () => 'https://gemini.google.com/app',
    bringToFront: async () => {},
    fillInput: async (text: string) => { log.push(text); },
    clickSend: async () => { log.push('send'); },
    clickStop: async () => {},
    isGenerating: async () => script.generating[Math.min(polls, script.generating.length - 1)],
    responseText: async () => {
      const t = script.texts[Math.min(polls, script.texts.length - 1)];
      polls++;
      return t;
    },
  };
}

test('first send bootstraps protocol, second send does not', async () => {
  const log: string[] = [];
  const t = new PlaywrightTransport(async () => fakePage({
    generating: [false, false, false, false],
    texts: ['ok', 'ok', '```toolcall-json\n{"name":"read_file","args":{}}\n```', '```toolcall-json\n{"name":"read_file","args":{}}\n```'],
  }, log), { pollMs: 10, stableMs: 20 });
  assert.ok(PROTOCOL_BOOTSTRAP.includes('toolcall-json'));
  for await (const _ of t.send('payload-1')) {}
  for await (const _ of t.send('payload-2')) {}
  const fills = log.filter((l) => l !== 'send');
  assert.equal(fills.length, 3);
  assert.ok(fills[0].startsWith('You are an autonomous coding agent'));
  assert.equal(fills[1], 'payload-1');
  assert.equal(fills[2], 'payload-2');
});

test('empty model response fails fast instead of silent empty', async () => {
  const log: string[] = [];
  const t = new PlaywrightTransport(async () => fakePage({ generating: [false, false], texts: ['', ''] }, log), { pollMs: 10, stableMs: 20 });
  await assert.rejects(async () => { for await (const _ of t.send('x')) {} }, /empty response/i);
});

test('stuck generating state times out instead of hanging forever', async () => {
  const page: GeminiWebPage = {
    url: () => 'https://gemini.google.com/app',
    bringToFront: async () => {},
    fillInput: async () => {},
    clickSend: async () => {},
    clickStop: async () => {},
    isGenerating: async () => true,
    responseText: async () => 'READY',
  };
  const t = new PlaywrightTransport(async () => page, { pollMs: 10, stableMs: 20, roundTimeoutMs: 150 });
  await assert.rejects(async () => { for await (const _ of t.send('x')) {} }, /timed out/i);
});

test('next round ignores previous round tail instead of lagging one turn', async () => {
  const LONG = 'L'.repeat(50);
  const SHORT = 'S'.repeat(10);
  const ACK = 'A'.repeat(20);
  const texts = [...Array(10).fill(ACK), ...Array(20).fill(LONG), ...Array(20).fill(SHORT)];
  let polls = 0;
  const page: GeminiWebPage = {
    url: () => 'https://gemini.google.com/app',
    bringToFront: async () => {},
    fillInput: async () => {},
    clickSend: async () => {},
    clickStop: async () => {},
    isGenerating: async () => false,
    responseText: async () => texts[Math.min(polls++, texts.length - 1)],
  };
  const t = new PlaywrightTransport(async () => page, { pollMs: 10, stableMs: 20 });
  let first = '';
  for await (const c of t.send('one')) first += c;
  let second = '';
  for await (const c of t.send('two')) second += c;
  assert.ok(first.includes('L'), `first round wrong, got: ${first.slice(0, 20)}`);
  assert.ok(second.includes('S'), `second round lagged one turn, got: ${second.slice(0, 20)}`);
  assert.doesNotMatch(second, /L/);
});
