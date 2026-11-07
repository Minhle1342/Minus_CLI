import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectMemoryManager } from './project-memory.js';

test('a corrupt project memory file is quarantined before re-indexing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-memory-'));
  const file = path.join(dir, '.codingagent', 'project-memory.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"learnedInsights": [', 'utf8');

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await new ProjectMemoryManager(dir).init();

    const files = await fs.readdir(path.dirname(file));
    assert.ok(files.some((name) => name.includes('project-memory.json.corrupt-')), 'corrupt file must survive');
    assert.ok(warnings.some((line) => line.includes('unreadable')));

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(Array.isArray(saved.learnedInsights), 'a fresh memory file is written');
  } finally {
    console.warn = originalWarn;
  }
});

test('getProjectDigest detects empty workspace and outputs greenfield guidance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-greenfield-'));
  // Simulate CLI creating .codingagent folder
  await fs.mkdir(path.join(dir, '.codingagent'), { recursive: true });

  const memory = new ProjectMemoryManager(dir);
  assert.equal(memory.isWorkspaceEmpty(), true);

  const digest = memory.getProjectDigest();
  assert.match(digest, /\[PROJECT STATE: NEW \/ EMPTY WORKSPACE\]/);
  assert.match(digest, /No source files exist yet/);
  assert.doesNotMatch(digest, /AGENTS\.md/);

  // Once a source file exists, it is no longer an empty workspace
  await fs.writeFile(path.join(dir, 'package.json'), '{"name": "my-app"}');
  assert.equal(memory.isWorkspaceEmpty(), false);
});
