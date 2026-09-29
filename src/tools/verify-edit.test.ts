import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import { verifyEditTool } from './verify-edit.js';
import { ToolRegistry } from './registry.js';

let ws: Workspace;
let target: string;

before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-edit-'));
  ws = new Workspace(dir);
  target = 'sample.ts';
  await fs.writeFile(
    path.join(dir, target),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function add(a: string, b: string): string {\n  return a + b;\n}\n',
    'utf-8',
  );
});

describe('verify_edit dry-run', () => {
  it('verifies a unique anchor with diff preview and no disk write', async () => {
    const beforeContent = await fs.readFile(path.join((ws as any).rootDir ?? ws.rootDir, target), 'utf-8');
    const res: any = await verifyEditTool.execute(
      { path: target, oldText: 'return a + b;\n}\n\nexport function add(a: string', newText: 'return a + b; // checked\n}\n\nexport function add(a: string' },
      ws,
    );
    assert.equal(res.success, true);
    assert.equal(res.verified, true);
    assert.equal(res.matchCount, 1);
    assert.ok(res.dryRunDiff && res.dryRunDiff.includes('checked'));
    assert.ok(typeof res.fileHash === 'string' && res.fileHash.length > 0);
    const afterContent = await fs.readFile(path.join(ws.rootDir, target), 'utf-8');
    assert.equal(afterContent, beforeContent);
  });

  it('reports verified:false for stale text with suggestions', async () => {
    const res: any = await verifyEditTool.execute({ path: target, oldText: 'return a - b; // never existed' }, ws);
    assert.equal(res.success, true);
    assert.equal(res.verified, false);
    assert.equal(res.matchCount, 0);
    assert.ok(Array.isArray(res.suggestions) && res.suggestions.length > 0);
  });

  it('reports ambiguity for repeated anchors', async () => {
    const res: any = await verifyEditTool.execute({ path: target, oldText: 'return a + b;' }, ws);
    assert.equal(res.success, true);
    assert.equal(res.verified, false);
    assert.equal(res.matchCount, 2);
  });

  it('flags expectedFileHash mismatch without failing the check', async () => {
    const res: any = await verifyEditTool.execute(
      { path: target, oldText: 'return a + b;\n}\n\nexport function add(a: string', expectedFileHash: 'sha256:deadbeef' },
      ws,
    );
    assert.equal(res.success, true);
    assert.equal(res.fileHashMatches, false);
    assert.ok(res.suggestions.some((s: string) => /changed|re-read/i.test(s)));
  });

  it('verifies a valid patch in dry-run without writing', async () => {
    const patch = `--- a/${target}\n+++ b/${target}\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a + b;\n+  return a + b + 0;\n }\n`;
    const res: any = await verifyEditTool.execute({ patch }, ws);
    assert.equal(res.success, true);
    assert.equal(res.verified, true);
    assert.equal(res.hunksApplied, res.totalHunks);
  });

  it('rejects a patch with broken context', async () => {
    const patch = `--- a/${target}\n+++ b/${target}\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a * b + zzz_nope;\n+  return 0;\n }\n`;
    const res: any = await verifyEditTool.execute({ patch }, ws);
    assert.equal(res.success, true);
    assert.equal(res.verified, false);
  });

  it('requires exactly one of oldText/patch', async () => {
    const both: any = await verifyEditTool.execute({ path: target, oldText: 'x', patch: 'y' }, ws);
    assert.equal(both.errorCode, 'INVALID_ARGS');
    const neither: any = await verifyEditTool.execute({ path: target }, ws);
    assert.equal(neither.errorCode, 'INVALID_ARGS');
  });

  it('is registered with filesystem_verification category', () => {
    const reg = new ToolRegistry();
    assert.ok(reg.get('verify_edit'));
    const stubs = reg.getToolCatalogStubs().filter((s) => s.name === 'verify_edit');
    assert.equal(stubs.length, 1);
    assert.equal(stubs[0].category, 'filesystem_verification');
  });
});
