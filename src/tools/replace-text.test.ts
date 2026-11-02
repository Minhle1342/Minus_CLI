import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { replaceTextTool } from './replace-text.js';
import { Workspace } from '../workspace/workspace.js';

async function withWorkspace<T>(files: Record<string, string>, run: (workspace: Workspace, dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-replace-text-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    return await run(new Workspace(dir), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('replace_text strips read_file line-number prefixes from oldText and newText', async () => {
  await withWorkspace({
    'demo.ts': 'function demo() {\n  const value = 1;\n  return value;\n}\n',
  }, async (workspace, dir) => {
    const result = await replaceTextTool.execute({
      path: 'demo.ts',
      oldText: '1: function demo() {\n2:   const value = 1;\n3:   return value;\n4: }',
      newText: '1: function demo() {\n2:   const value = 1;\n3:   return value * 2;\n4: }',
    }, workspace);

    assert.equal(result.success, true, 'line-numbered oldText copied from read_file must still match');
    assert.equal(result.matchStrategy, 'normalized_line_numbers');
    assert.equal(result.lineNumbersStripped, true);
    assert.equal(await fs.readFile(path.join(dir, 'demo.ts'), 'utf8'), 'function demo() {\n  const value = 1;\n  return value * 2;\n}\n');
  });
});

test('replace_text strips a single line-numbered anchor and preserves indentation', async () => {
  await withWorkspace({
    'demo.ts': 'function demo() {\n  const value = 1;\n  return value;\n}\n',
  }, async (workspace, dir) => {
    const result = await replaceTextTool.execute({
      path: 'demo.ts',
      oldText: '2:   const value = 1;',
      newText: '2:   const value = 9;',
    }, workspace);

    assert.equal(result.success, true);
    assert.equal(result.matchStrategy, 'normalized_line_numbers');
    assert.equal(await fs.readFile(path.join(dir, 'demo.ts'), 'utf8'), 'function demo() {\n  const value = 9;\n  return value;\n}\n');
  });
});

test('replace_text does not strip misaligned numbering and reports the cause', async () => {
  await withWorkspace({
    'demo.ts': 'const a = 1;\nconst b = 2;\n',
  }, async (workspace) => {
    const result = await replaceTextTool.execute({
      path: 'demo.ts',
      oldText: '9: const a = 1;',
      newText: 'const a = 3;',
    }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(result.cause, 'LINE_NUMBER_PREFIX', 'misaligned prefixes must be surfaced, not silently applied');
    assert.equal(result.suggestedOldText, 'const a = 1;', 'suggested snippet must be raw content without the prefix');
  });
});

test('replace_text returns a suggestedOldText snippet that can be retried in the same turn', async () => {
  await withWorkspace({
    'math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  }, async (workspace, dir) => {
    const failed = await replaceTextTool.execute({
      path: 'math.ts',
      oldText: '  return a - b;',
      newText: '  return a * b;',
    }, workspace);

    assert.equal(failed.success, false);
    assert.equal(failed.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(typeof failed.cause, 'string');
    assert.equal(failed.suggestedOldText, '  return a + b;');
    assert.equal(typeof failed.contentHash, 'string');
    assert.ok(failed.suggestedStartLine >= 1 && failed.suggestedEndLine >= failed.suggestedStartLine);

    const retried = await replaceTextTool.execute({
      path: 'math.ts',
      oldText: failed.suggestedOldText,
      newText: '  return a * b;',
      expectedFileHash: failed.contentHash,
    }, workspace);

    assert.equal(retried.success, true, 'the suggested snippet plus contentHash must succeed without a re-read');
    assert.equal(await fs.readFile(path.join(dir, 'math.ts'), 'utf8'), 'export function add(a: number, b: number): number {\n  return a * b;\n}\n');
  });
});

test('replace_text reports blank-line drift as the failure cause', async () => {
  await withWorkspace({
    'constants.ts': 'const a = 1;\nconst b = 2;\n',
  }, async (workspace) => {
    const result = await replaceTextTool.execute({
      path: 'constants.ts',
      oldText: 'const a = 1;\n\nconst b = 2;',
      newText: 'const a = 1;\nconst b = 3;',
    }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(result.cause, 'BLANK_LINE_DRIFT');
  });
});

test('replace_text reports copied truncation markers as the failure cause', async () => {
  await withWorkspace({
    'constants.ts': 'const a = 1;\nconst b = 2;\n',
  }, async (workspace) => {
    const result = await replaceTextTool.execute({
      path: 'constants.ts',
      oldText: 'const a = 1;\n... [truncated 500 chars]',
      newText: 'const a = 3;',
    }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(result.cause, 'TRUNCATION_MARKER');
  });
});

test('replace_text still normalizes LF/CRLF and preserves the file EOL', async () => {
  await withWorkspace({
    'win.ts': 'function render() {\r\n  return "old";\r\n}\r\n',
  }, async (workspace, dir) => {
    const result = await replaceTextTool.execute({
      path: 'win.ts',
      oldText: 'function render() {\n  return "old";\n}',
      newText: 'function render() {\n  return "new";\n}',
    }, workspace);

    assert.equal(result.success, true);
    assert.equal(result.matchStrategy, 'normalized_eol');
    assert.equal(await fs.readFile(path.join(dir, 'win.ts'), 'utf8'), 'function render() {\r\n  return "new";\r\n}\r\n');
  });
});

test('replace_text still normalizes Unicode NFC/NFD differences', async () => {
  await withWorkspace({
    'unicode.ts': 'const note = "Ch\u1EC9 trả về JSON";\n',
  }, async (workspace, dir) => {
    const result = await replaceTextTool.execute({
      path: 'unicode.ts',
      oldText: 'const note = "Chi\u0309 trả về JSON";\n',
      newText: 'const note = "Đã cập nhật";\n',
    }, workspace);

    assert.equal(result.success, true);
    assert.equal(result.matchStrategy, 'normalized_unicode');
    assert.equal(await fs.readFile(path.join(dir, 'unicode.ts'), 'utf8'), 'const note = "Đã cập nhật";\n');
  });
});

test('replace_text still normalizes base indentation', async () => {
  await withWorkspace({
    'indent.ts': 'function demo() {\n    if (ready) {\n      return 1;\n    }\n}\n',
  }, async (workspace, dir) => {
    const result = await replaceTextTool.execute({
      path: 'indent.ts',
      oldText: 'if (ready) {\n  return 1;\n}',
      newText: 'if (ready) {\n  return 2;\n}',
    }, workspace);

    assert.equal(result.success, true);
    assert.equal(result.matchStrategy, 'normalized_indentation');
    assert.equal(await fs.readFile(path.join(dir, 'indent.ts'), 'utf8'), 'function demo() {\n    if (ready) {\n      return 2;\n    }\n}\n');
  });
});

test('suggestedOldText and suggestedRead cover a long anchor without re-reading', async () => {
  const anchorLines = Array.from({ length: 40 }, (_, i) => `  const value${i} = ${i};`);
  const drifted = anchorLines.map((line, i) => (i === 20 ? '  const value20 = 999;' : line)).join('\n');
  await withWorkspace({
    'long.ts': `function demo() {\n${anchorLines.join('\n')}\n}\n`,
  }, async (workspace) => {
    const result = await replaceTextTool.execute({
      path: 'long.ts',
      oldText: drifted,
      newText: '  return 0;',
    }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(result.suggestedOldText.split('\n').length, 40, 'suggested snippet must cover the full 40-line anchor');
    assert.ok(
      result.suggestedEndLine - result.suggestedStartLine + 1 >= 40,
      'suggestedRead must cover the full anchor extent',
    );
  });
});

test('replace_text never returns a partial suggestedOldText for anchors over the edit limit', async () => {
  const anchorLines = Array.from({ length: 60 }, (_, i) => `  const value${i} = ${i};`);
  const drifted = anchorLines.map((line, i) => (i === 30 ? '  const value30 = 999;' : line)).join('\n');
  await withWorkspace({
    'huge.ts': `function demo() {\n${anchorLines.join('\n')}\n}\n`,
  }, async (workspace) => {
    const result = await replaceTextTool.execute({
      path: 'huge.ts',
      oldText: drifted,
      newText: '  return 0;',
    }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'TEXT_NOT_FOUND');
    assert.equal(result.suggestedOldText, undefined, 'a partial snippet must not be offered as oldText');
    assert.ok(
      result.suggestedRead.endLine - result.suggestedRead.startLine + 1 >= 60,
      'suggestedRead must still cover the full over-limit anchor',
    );
    assert.match(result.suggestion, /read_file/);
    assert.doesNotMatch(result.suggestion, /no re-read is needed/);
  });
});

test('replace_text exact mode still rejects LF/CRLF mismatch', async () => {
  await withWorkspace({
    'win.ts': 'function render() {\r\n  return "old";\r\n}\r\n',
  }, async (workspace) => {
    const result = await replaceTextTool.execute({
      path: 'win.ts',
      oldText: 'function render() {\n  return "old";\n}',
      newText: 'unused',
      matchMode: 'exact',
    }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'TEXT_NOT_FOUND');
  });
});
