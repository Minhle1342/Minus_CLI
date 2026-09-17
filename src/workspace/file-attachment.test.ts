import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PromptAttachmentProcessor } from './file-attachment.js';
import { Workspace } from './workspace.js';

async function withWorkspace(run: (workspace: Workspace, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'minus-attachments-'));
  try {
    await run(new Workspace(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('caps the number of prompt attachments before expanding the prompt', async () => {
  await withWorkspace(async (workspace, root) => {
    const paths = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`);
    await Promise.all(paths.map((file) => writeFile(path.join(root, file), 'small attachment')));

    const result = await PromptAttachmentProcessor.resolveAndAttach(paths.map((file) => `@${file}`).join(' '), workspace);

    assert.equal(result.attachments.length, 8);
    assert.deepEqual(result.skippedAttachments, [{ path: 'file-8.txt', reason: 'attachment_limit' }]);
    assert.match(result.expandedPrompt, /Attachment limits/);
  });
});

test('caps source bytes and rendered context tokens before provider submission', async () => {
  await withWorkspace(async (workspace, root) => {
    await Promise.all(['source-a.png', 'source-b.png', 'source-c.png'].map((file) => writeFile(path.join(root, file), 'x'.repeat(30 * 1024))));
    const sourceResult = await PromptAttachmentProcessor.resolveAndAttach('@source-a.png @source-b.png @source-c.png', workspace);
    assert.equal(sourceResult.attachments.length, 2);
    assert.equal(sourceResult.skippedAttachments?.[0]?.reason, 'source_byte_limit');

    const tokenPaths = Array.from({ length: 7 }, (_, index) => `token-${index}.txt`);
    await Promise.all(tokenPaths.map((file) => writeFile(path.join(root, file), 'x'.repeat(9 * 1024))));
    const tokenResult = await PromptAttachmentProcessor.resolveAndAttach(tokenPaths.map((file) => `@${file}`).join(' '), workspace);
    assert.equal(tokenResult.skippedAttachments?.some((item) => item.reason === 'context_token_limit'), true);
  });
});
