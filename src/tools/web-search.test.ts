import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMojeekHtml } from './web-search.js';

test('parseMojeekHtml extracts title, url and snippet from Mojeek HTML results', () => {
  const html = `
    <html><body>
      <article class="result webp result-standard webp-result">
        <h2><a href="https://example.com/page" class="title">Example Page</a></h2>
        <p class="snippet">This is a snippet about example page content.</p>
      </article>
      <article class="result webp result-standard webp-result">
        <h2><a href="https://example2.com/page" class="title">Second Page</a></h2>
        <p class="snippet">Second snippet text here.</p>
      </article>
    </body></html>`;
  const results = parseMojeekHtml(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Example Page');
  assert.equal(results[0].url, 'https://example.com/page');
  assert.equal(results[0].snippet, 'This is a snippet about example page content.');
  assert.equal(results[1].title, 'Second Page');
  assert.equal(results[1].url, 'https://example2.com/page');
});

test('parseMojeekHtml returns empty array when no results', () => {
  const results = parseMojeekHtml('<html><body>No results found.</body></html>');
  assert.deepEqual(results, []);
});

test('parseMojeekHtml skips results missing title or url', () => {
  const html = `
    <html><body>
      <article class="result webp result-standard webp-result">
        <h2><a class="title">No URL</a></h2>
        <p class="snippet">Snippet without URL</p>
      </article>
      <article class="result webp result-standard webp-result">
        <p class="snippet">Snippet without title/link</p>
      </article>
    </body></html>`;
  const results = parseMojeekHtml(html);
  assert.deepEqual(results, []);
});
