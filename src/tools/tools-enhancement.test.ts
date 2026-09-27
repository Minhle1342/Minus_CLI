import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import { listFilesTool } from './list-files.js';
import { TypeScriptService } from './typescript-service.js';
import { replaceTextTool } from './replace-text.js';
import { calculateComprehensiveBlastRadius } from './mutation-blast-radius.js';
import { replaceFileContentTool } from './replace-file-content.js';
import { multiReplaceFileContentTool } from './multi-replace-file-content.js';
import { createSearchCodebaseFastTool } from './search-code-tool.js';

describe('Tools Enhancement Suite (fast-glob, json5, diff, ts-morph)', () => {
  const workspace = new Workspace(process.cwd());

  it('1. list_files supports glob pattern via fast-glob', async () => {
    const res = await listFilesTool.execute({ path: '.', pattern: 'src/tools/*.ts' }, workspace);
    assert.equal(res.pattern, 'src/tools/*.ts');
    assert.ok(Array.isArray(res.entries));
    assert.ok(res.entries.length > 10, 'Should find TypeScript tools');
    assert.ok(res.entries.some((e: any) => e.name.includes('list-files.ts')));
  });

  it('2. typescript-service loads tsconfig.json with comments and trailing commas via json5', () => {
    const tsService = new TypeScriptService(workspace);
    const options = (tsService as any).compilerOptions;
    assert.ok(options, 'Compiler options should be loaded');
    assert.ok(options.target !== undefined, 'Target should be set');
  });

  it('3. replace_text generates unifiedDiff on successful text replacement', async () => {
    const scratchDir = path.resolve(process.cwd(), '.codingagent', 'scratch');
    await fs.mkdir(scratchDir, { recursive: true });
    const tempFile = path.resolve(scratchDir, `test-patch-${Date.now()}.txt`);
    const relFile = path.relative(process.cwd(), tempFile).replace(/\\/g, '/');

    try {
      await fs.writeFile(tempFile, 'line A\nline B\nline C\n', 'utf-8');
      const res = await replaceTextTool.execute({
        path: relFile,
        oldText: 'line B',
        newText: 'line B updated',
      }, workspace);

      assert.equal(res.success, true);
      assert.ok(typeof res.unifiedDiff === 'string', 'Should return unifiedDiff');
      assert.match(res.unifiedDiff, /---/);
      assert.match(res.unifiedDiff, /\+\+\+/);
      assert.match(res.unifiedDiff, /-line B/);
      assert.match(res.unifiedDiff, /\+line B updated/);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  it('4. calculateComprehensiveBlastRadius enriches callers using ts-morph', () => {
    const blast = calculateComprehensiveBlastRadius({
      workspace,
      filePath: 'src/tools/list-files.ts',
      symbol: 'listFilesTool',
    });

    assert.ok(blast.risk, 'Risk level should be determined');
    assert.ok(blast.score > 0, 'Risk score should be positive');
    assert.ok(Array.isArray(blast.callers), 'Callers should be an array');
    assert.ok(blast.callers.length > 0, 'Should discover callers with ts-morph');
  });

  it('5. replace_file_content generates unifiedDiff on success', async () => {
    const scratchDir = path.resolve(process.cwd(), '.codingagent', 'scratch');
    await fs.mkdir(scratchDir, { recursive: true });
    const tempFile = path.resolve(scratchDir, `test-rfc-${Date.now()}.txt`);
    const relFile = path.relative(process.cwd(), tempFile).replace(/\\/g, '/');

    try {
      await fs.writeFile(tempFile, 'alpha\nbeta\ngamma\n', 'utf-8');
      const res = await replaceFileContentTool.execute({
        TargetFile: relFile,
        Instruction: 'test rfc',
        Description: 'test rfc',
        StartLine: 1,
        EndLine: 3,
        TargetContent: 'beta',
        ReplacementContent: 'beta modified',
        AllowMultiple: false,
      }, workspace);

      assert.equal(res.success, true);
      assert.ok(typeof res.unifiedDiff === 'string', 'Should return unifiedDiff');
      assert.match(res.unifiedDiff, /-beta/);
      assert.match(res.unifiedDiff, /\+beta modified/);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  it('6. multi_replace_file_content generates unifiedDiff on success', async () => {
    const scratchDir = path.resolve(process.cwd(), '.codingagent', 'scratch');
    await fs.mkdir(scratchDir, { recursive: true });
    const tempFile = path.resolve(scratchDir, `test-mrfc-${Date.now()}.txt`);
    const relFile = path.relative(process.cwd(), tempFile).replace(/\\/g, '/');

    try {
      await fs.writeFile(tempFile, '1\n2\n3\n4\n', 'utf-8');
      const res = await multiReplaceFileContentTool.execute({
        TargetFile: relFile,
        Instruction: 'test mrfc',
        Description: 'test mrfc',
        ReplacementChunks: [
          { StartLine: 1, EndLine: 2, TargetContent: '1', ReplacementContent: '10', AllowMultiple: false },
          { StartLine: 3, EndLine: 4, TargetContent: '4', ReplacementContent: '40', AllowMultiple: false },
        ],
      }, workspace);

      assert.equal(res.success, true);
      assert.ok(typeof res.unifiedDiff === 'string', 'Should return unifiedDiff');
      assert.match(res.unifiedDiff, /-1/);
      assert.match(res.unifiedDiff, /\+10/);
      assert.match(res.unifiedDiff, /-4/);
      assert.match(res.unifiedDiff, /\+40/);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  it('7. search_codebase_fast filters results using filePattern', async () => {
    const tool = createSearchCodebaseFastTool();
    const res = await tool.execute({
      query: 'ToolDefinition',
      limit: 5,
      filePattern: 'src/tools/types.ts',
    }, workspace);

    assert.ok(Array.isArray(res.hits));
    assert.equal(res.hits.length, 1);
    assert.equal(res.hits[0].path, 'src/tools/types.ts');
  });
});
