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

test('indexes deep nested structures (depth 8+) and excludes cross-language ignored dirs', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { FileMentionEngine } = await import('./file-attachment.js');

  await withWorkspace(async (workspace, root) => {
    // Tạo cấu trúc sâu cấp 8 (Java / Next.js style)
    const deepDir = path.join(root, 'src', 'main', 'java', 'com', 'example', 'service', 'impl');
    await mkdir(deepDir, { recursive: true });
    await writeFile(path.join(deepDir, 'DeepService.java'), 'public class DeepService {}');

    // Tạo các thư mục rác / build cache của các ngôn ngữ khác
    const rustTarget = path.join(root, 'target', 'debug');
    const pythonCache = path.join(root, '__pycache__');
    const pythonVenv = path.join(root, '.venv', 'lib');
    const phpVendor = path.join(root, 'vendor', 'composer');
    const dotnetBin = path.join(root, 'bin', 'Debug');

    await mkdir(rustTarget, { recursive: true });
    await mkdir(pythonCache, { recursive: true });
    await mkdir(pythonVenv, { recursive: true });
    await mkdir(phpVendor, { recursive: true });
    await mkdir(dotnetBin, { recursive: true });

    await writeFile(path.join(rustTarget, 'generated.rs'), '// junk');
    await writeFile(path.join(pythonCache, 'app.cpython-310.pyc'), 'junk');
    await writeFile(path.join(pythonVenv, 'dep.py'), '# dep');
    await writeFile(path.join(phpVendor, 'autoload.php'), '<?php');
    await writeFile(path.join(dotnetBin, 'app.dll'), 'binary');

    const entries = FileMentionEngine.listWorkspaceEntries(workspace);

    // 1. Phải bắt được file sâu cấp 8
    assert.equal(entries.some((e) => e.relativePath.includes('DeepService.java')), true, 'Phải bắt được file sâu cấp 8');

    // 2. Không được bắt các thư mục bị ignore của các ngôn ngữ khác
    assert.equal(entries.some((e) => e.relativePath.startsWith('target')), false, 'Bỏ qua target/ của Rust/Maven');
    assert.equal(entries.some((e) => e.relativePath.startsWith('__pycache__')), false, 'Bỏ qua __pycache__/ của Python');
    assert.equal(entries.some((e) => e.relativePath.startsWith('.venv')), false, 'Bỏ qua .venv/ của Python');
    assert.equal(entries.some((e) => e.relativePath.startsWith('vendor')), false, 'Bỏ qua vendor/ của PHP');
    assert.equal(entries.some((e) => e.relativePath.startsWith('bin')), false, 'Bỏ qua bin/ của C#');
  });
});

test('handles Unicode, Next.js route symbols, quotes, and lossless completion', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { FileMentionEngine } = await import('./file-attachment.js');

  await withWorkspace(async (workspace, root) => {
    const nextjsDir = path.join(root, 'src', 'app', '(auth)', '[id]');
    await mkdir(nextjsDir, { recursive: true });
    await writeFile(path.join(nextjsDir, 'page.tsx'), 'export default function Page() {}');

    const vietnameseDir = path.join(root, 'tài_liệu');
    await mkdir(vietnameseDir, { recursive: true });
    await writeFile(path.join(vietnameseDir, 'báo_cáo.md'), '# Báo cáo');

    const spacedDir = path.join(root, 'my docs');
    await mkdir(spacedDir, { recursive: true });
    await writeFile(path.join(spacedDir, 'user guide.md'), '# User Guide');

    // 1. Trích xuất đường dẫn có dấu ngoặc Next.js
    const paths1 = PromptAttachmentProcessor.extractMentionedPaths('Xem @src/app/(auth)/[id]/page.tsx và phân tích');
    assert.deepEqual(paths1, ['src/app/(auth)/[id]/page.tsx']);

    // 2. Trích xuất đường dẫn tiếng Việt
    const paths2 = PromptAttachmentProcessor.extractMentionedPaths('Đọc @tài_liệu/báo_cáo.md nhé');
    assert.deepEqual(paths2, ['tài_liệu/báo_cáo.md']);

    // 3. Trích xuất đường dẫn trong dấu ngoặc kép
    const paths3 = PromptAttachmentProcessor.extractMentionedPaths('Xem @"my docs/user guide.md"');
    assert.deepEqual(paths3, ['my docs/user guide.md']);

    // 4. Kiểm tra lossless Tab completion (không nuốt text sau mention)
    const [completions] = FileMentionEngine.completeMention('Kiểm tra @báo_cáo và gửi email', workspace, 17);
    assert.equal(completions.length > 0, true);
    assert.equal(completions[0], 'Kiểm tra @tài_liệu/báo_cáo.md và gửi email');
  });
});

