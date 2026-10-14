import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkillTools } from './skill-tools.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { Workspace } from '../workspace/workspace.js';

function makeSkillDir(ids: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  for (const id of ids) {
    const sub = path.join(dir, id);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'SKILL.md'), `---\nid: ${id}\nname: ${id}\ndescription: Skill ${id} for test\n---\n# ${id}\nBody\n`);
  }
  return dir;
}

test('skill-tools: loads workspace-external dir, rejects outside and missing paths', async () => {
  const workspace = new Workspace(process.cwd());
  const dir = makeSkillDir(['tmp-skill-a']);
  try {
    const registry = new SkillRegistry();
    const tools = createSkillTools(registry);
    const load = tools.find((t) => t.name === 'load_workspace_skills')!;
    const res = await load.execute({ path: dir }, workspace);
    assert.equal(res.success, true);
    assert.deepEqual(res.added, ['tmp-skill-a']);
    const list = tools.find((t) => t.name === 'list_skills')!;
    assert.equal((await list.execute({}, workspace)).count, 1);

    const again = await load.execute({ path: dir }, workspace);
    assert.equal(again.success, true);
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.diagnostics, []);

    assert.equal((await load.execute({ path: '../outside' }, workspace)).errorCode, 'PATH_OUT_OF_BOUNDS');
    assert.equal((await load.execute({ path: '.no-such-dir-xyz' }, workspace)).errorCode, 'INVALID_ARGS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skill-tools: refuses filesystem root and caps list output', async () => {
  const workspace = new Workspace(process.cwd());
  const registry = new SkillRegistry();
  const tools = createSkillTools(registry);
  const load = tools.find((t) => t.name === 'load_workspace_skills')!;
  const root = path.parse(process.cwd()).root;
  assert.equal((await load.execute({ path: root }, workspace)).errorCode, 'INVALID_ARGS');

  const dir = makeSkillDir(Array.from({ length: 55 }, (_, i) => `cap-${i}`));
  try {
    const res = await load.execute({ path: dir }, workspace);
    assert.equal(res.loaded <= 50, true);
    const list = tools.find((t) => t.name === 'list_skills')!;
    const out = await list.execute({}, workspace);
    assert.equal(out.skills.length <= 50, true);
    assert.equal(out.truncated, out.count > 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
