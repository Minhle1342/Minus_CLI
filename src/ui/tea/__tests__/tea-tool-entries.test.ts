import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update } from '../models/root-model.js';
import { lineRangeSuffix, toolResultEntry, mergedToolEntry, toolCallEntry } from '../models/tool-entry.js';

test('explore tools merge tool call + result into ONE entry; others keep both', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['read_file', { path: 'src/a.ts' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['read_file', { content: 'export const answer = 42;' }, 5, { path: 'src/a.ts' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['submit_solution', { summary: 'Một câu trả lời dài' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['submit_solution', {
    success: true, submitted: true, summary: 'Một câu trả lời dài', timestamp: '2026-10-07T17:01:44.697Z',
    message: 'Internal final answer instruction', _untrusted_context: { level: 5 },
  }, 8, { summary: 'Một câu trả lời dài' }] }, model);

  // read_file (explore + thành công) gộp: entry call '›' bị THAY THẾ thành merged 1 dòng — tổng 3 entries.
  assert.equal(model.viewport.entries.length, 3);
  assert.match(model.viewport.entries[0].text, /✔ read_file \[OK\] · src\/a\.ts · export const answer = 42/);
  assert.doesNotMatch(model.viewport.entries[0].text, /^›/);
  assert.match(model.viewport.entries[0].text, /export const answer = 42/);
  assert.equal(model.viewport.entries[1].text, '● submit_solution');
  assert.match(model.viewport.entries[2].text, /Câu trả lời đã được gửi/);
  assert.doesNotMatch(model.viewport.entries[2].text, /_untrusted_context|timestamp|Internal final answer instruction/);
});

test('mergedToolEntry chỉ gộp read-only thành công; lỗi trả undefined (giữ 2-entry)', () => {
  // Thành công read-only: 1 dòng chứa target + brief
  assert.equal(
    mergedToolEntry('read_file', { path: 'a.ts', startLine: 10, endLine: 20 }, { content: 'const x = 1;' }),
    '✔ read_file [OK] a.ts (startLine: 10, endLine: 20)',
  );
  assert.equal(
    mergedToolEntry('list_files', { dirPath: 'src' }, { files: ['a.ts'] }),
    '✔ list_files [OK] · src · a.ts',
  );  // Mutation tool → không gộp
  assert.equal(mergedToolEntry('write_file', { path: 'a.ts' }, { ok: true }), undefined);
  // Read-only FAIL → không gộp (caller fallback 2-entry: call + full FAIL block)
  assert.equal(mergedToolEntry('read_file', { path: 'a.ts' }, { error: 'ENOENT', errorCode: 'ENOENT' }), undefined);
  // Denied → không gộp
  assert.equal(mergedToolEntry('run_command', { command: 'x' }, { denied: true }), undefined);
});

test('read-only results show normalized line range instead of content excerpt', () => {
  // Explicit args win over everything else.
  assert.equal(
    toolResultEntry('read_file', { content: 'const x = 1;' }, 0, { path: 'a.ts', startLine: 10, endLine: 20 }).replace(/\x1b\[[0-9;]*m/g, ''),
    '✔ read_file [OK] (startLine: 10, endLine: 20)',
  );
  // offset/limit aliases normalize to the same two params, never shown raw.
  assert.equal(
    toolResultEntry('read_file', { content: 'const x = 1;' }, 0, { path: 'a.ts', offset: 200, limit: 11 }).replace(/\x1b\[[0-9;]*m/g, ''),
    '✔ read_file [OK] (startLine: 200, endLine: 210)',
  );
  assert.doesNotMatch(
    toolResultEntry('read_file', { content: 'const x = 1;' }, 0, { path: 'a.ts', offset: 200, limit: 11 }),
    /offset|limit/,
  );
  // No args (e.g. hydrated history): fall back to the effective range echoed in the result.
  assert.equal(
    toolResultEntry('read_file', { content: 'const x = 1;', startLine: 1, endLine: 120 }).replace(/\x1b\[[0-9;]*m/g, ''),
    '✔ read_file [OK] (startLine: 1, endLine: 120)',
  );
  // Tools without line bounds keep the content excerpt.
  assert.equal(
    toolResultEntry('list_files', { files: ['a.ts'] }, 0, { dirPath: 'src' }).replace(/\x1b\[[0-9;]*m/g, ''),
    '✔ list_files [OK] · a.ts',
  );
  // Failures keep full diagnostics, never collapsed to a range.
  const failed = toolResultEntry('read_file', { errorCode: 'ENOENT', error: 'missing' }, 0, { path: 'a.ts', startLine: 1, endLine: 5 });
  assert.match(failed, /\[FAIL\]/);
  assert.match(failed, /missing/);
});

test('lineRangeSuffix resolves explicit args, aliases, result echo, and partial bounds', () => {
  assert.equal(lineRangeSuffix({ startLine: 10, endLine: 20 }, {}), ' (startLine: 10, endLine: 20)');
  assert.equal(lineRangeSuffix({ offset: 5, limit: 10 }, {}), ' (startLine: 5, endLine: 14)');
  assert.equal(lineRangeSuffix({ startLine: '7', endLine: '9' }, {}), ' (startLine: 7, endLine: 9)');
  assert.equal(lineRangeSuffix({}, { startLine: 1, endLine: 120 }), ' (startLine: 1, endLine: 120)');
  assert.equal(lineRangeSuffix({ startLine: 3 }, {}), ' (startLine: 3)');
  assert.equal(lineRangeSuffix(undefined, { endLine: 9 }), ' (endLine: 9)');
  assert.equal(lineRangeSuffix({ path: 'a.ts' }, { content: 'x' }), undefined);
  assert.equal(lineRangeSuffix(undefined, {}), undefined);
});

test('live read with line range renders ONE merged entry (call entry replaced)', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['read_file', { path: 'src/a.ts', startLine: 10, endLine: 20 }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['read_file', {
    path: 'src/a.ts', content: 'const x = 1;', startLine: 10, endLine: 20,
  }, 5, { path: 'src/a.ts', startLine: 10, endLine: 20 }] }, model);
  assert.equal(model.viewport.entries.length, 1);
  assert.equal(model.viewport.entries[0].text, '✔ read_file [OK] src/a.ts (startLine: 10, endLine: 20)');
});

test('tool failures retain diagnostic output', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['run_command', {
    success: false, error: 'TS2307 missing module', stderr: 'compiler output', exitCode: 1,
  }, 12, {}] }, model);
  assert.match(model.viewport.entries[0].text, /✖ run_command/);
  assert.match(model.viewport.entries[0].text, /TS2307 missing module/);
  assert.match(model.viewport.entries[0].text, /compiler output/);
});

test('tool result headings are toned by status (OK=green, FAIL=red, DENIED=yellow)', () => {
  const ok = toolResultEntry('run_command', { success: true, command: 'npm run build', exitCode: 0 }, 5, { command: 'npm run build' });
  assert.ok(ok.includes('\x1b['), 'OK result heading must be painted green');
  const failed = toolResultEntry('run_command', { success: false, error: 'boom', exitCode: 1 }, 5, { command: 'npm run build' });
  assert.ok(failed.includes('\x1b['), 'FAIL result heading must be painted red');
  assert.ok(failed.includes('✖ run_command [FAIL]'));
});

test('background tool call heading is muted gray and background result keeps status tone', () => {
  const bgCall = toolCallEntry('run_command', { command: 'npm run build', WaitMsBeforeAsync: 5000 });
  assert.ok(bgCall.includes('\x1b['), 'background call heading must be painted muted');
  const bgOk = toolResultEntry('run_command', { isBackgroundTask: true, success: true, command: 'npm run build', exitCode: 0 }, 5, { command: 'npm run build', WaitMsBeforeAsync: 5000 });
  assert.ok(bgOk.includes('✔ run_command [OK]'));
  const bgFail = toolResultEntry('run_command', { isBackgroundTask: true, success: false, error: 'boom', exitCode: 1 }, 5, { command: 'npm run build', WaitMsBeforeAsync: 5000 });
  assert.ok(bgFail.includes('✖ run_command [FAIL]'));
  assert.ok(bgFail.includes('boom'));
});
