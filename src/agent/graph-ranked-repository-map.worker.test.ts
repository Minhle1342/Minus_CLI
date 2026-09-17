import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace } from '../workspace/workspace.js';
import { GraphRankedRepositoryMap } from './graph-ranked-repository-map.js';

test('large repository graphs rank in the compiled worker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-graph-worker-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    for (let index = 0; index < 64; index++) {
      const dependency = index > 0 ? `import { item${index - 1} } from './item${index - 1}.js';\n` : '';
      await fs.writeFile(
        path.join(root, 'src', `item${index}.ts`),
        `${dependency}export const item${index} = ${index === 0 ? '0' : `item${index - 1} + 1`};\n`,
        'utf8',
      );
    }
    const map = new GraphRankedRepositoryMap(new Workspace(root));
    const result = await map.build('item63 dependency impact', { maxFiles: 12, maxTokens: 512 });
    assert.equal(result.indexedFiles, 64);
    assert.ok(result.graphEdges >= 63);
    assert.ok(result.entries.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
