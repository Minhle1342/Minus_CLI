import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNetworkIntent, hasWebIntent } from './network-intent.js';

test('detects pasted URL as network intent', () => {
  assert.equal(hasNetworkIntent('xem giúp https://github.com/foo/bar/issues/12'), true);
  assert.equal(hasNetworkIntent('đọc link http://example.com/docs'), true);
  assert.equal(hasNetworkIntent('mở www.google.com giúp'), true);
});

test('prose alone is not a network signal', () => {
  // Guessing "this sounds like a web search" was removed; only a URL is a fact.
  assert.equal(hasNetworkIntent('tìm trên mạng giúp tôi'), false);
  assert.equal(hasNetworkIntent('search web về SearXNG'), false);
  assert.equal(hasNetworkIntent('tra cứu tài liệu mới nhất'), false);
});

test('keeps pure code tasks local', () => {
  assert.equal(hasNetworkIntent('fix the failing parser unit test'), false);
});

test('detects an explicit web request without a URL', () => {
  for (const prompt of [
    'search the web for the latest Node.js release',
    'browse online docs for this SDK',
    'tra cứu trên mạng tài liệu mới nhất',
  ]) assert.equal(hasWebIntent(prompt), true, prompt);
  assert.equal(hasWebIntent('fix the failing parser unit test'), false);
});
