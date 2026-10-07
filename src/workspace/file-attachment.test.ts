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

test('attachment expansion defaults to ON unless explicitly disabled', () => {
  assert.equal(PromptAttachmentProcessor.isAttachmentExpansionEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(PromptAttachmentProcessor.isAttachmentExpansionEnabled({ MINUS_ATTACH_EXPAND: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(PromptAttachmentProcessor.isAttachmentExpansionEnabled({ MINUS_ATTACH_EXPAND: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(PromptAttachmentProcessor.isAttachmentExpansionEnabled({ MINUS_ATTACH_EXPAND: 'on' } as NodeJS.ProcessEnv), true);
});

test('expands 2-hop neighborhood around @-attached anchors with scope directive', async () => {
  await withWorkspace(async (workspace, root) => {
    await writeFile(path.join(root, 'alpha.ts'), `import { beta } from './beta.js';\nexport const alpha = 1;\n`);
    await writeFile(path.join(root, 'beta.ts'), `import { gamma } from './gamma.js';\nexport const beta = 2;\n`);
    await writeFile(path.join(root, 'gamma.ts'), `export const gamma = 3;\n`);
    await writeFile(path.join(root, 'delta.ts'), `import { alpha } from './alpha.js';\nexport const delta = 4;\n`);
    await writeFile(path.join(root, 'zeta.ts'), `export const zeta = 99;\n`);

    const result = await PromptAttachmentProcessor.resolveAndAttach('Fix bug in @alpha.ts', workspace);

    assert.equal(result.hasAttachments, true);
    assert.equal(result.expansionEnabled, true);
    assert.deepEqual(result.anchorPaths, ['alpha.ts']);

    const byPath = new Map((result.relatedFiles || []).map((item) => [item.path, item]));
    assert.equal(byPath.get('beta.ts')?.hop, 1, 'direct import is hop-1');
    assert.equal(byPath.get('beta.ts')?.reason, 'import');
    assert.equal(byPath.get('delta.ts')?.hop, 1, 'importer is hop-1');
    assert.equal(byPath.get('delta.ts')?.reason, 'imported-by');
    assert.equal(byPath.get('gamma.ts')?.hop, 2, 'import of hop-1 is hop-2');
    assert.equal(byPath.has('zeta.ts'), false, 'unrelated file must not enter the neighborhood');
    assert.ok(![...byPath.values()].some((item) => (item.reason as string) === 'same-dir'), 'same-dir siblings must not enter the neighborhood');

    assert.match(result.expandedPrompt, /\[Attachment Neighborhood - 2-hop Investigation Scope\]/);
    assert.match(result.expandedPrompt, /ATTACHMENT ANCHOR RULE/);
  });
});

test('directory attachment ranks top files as hop-1 anchors', async () => {
  const { mkdir } = await import('node:fs/promises');

  await withWorkspace(async (workspace, root) => {
    const libDir = path.join(root, 'lib');
    await mkdir(libDir, { recursive: true });
    await writeFile(path.join(libDir, 'small.ts'), `export const small = 1;\n`);
    await writeFile(path.join(libDir, 'mid.ts'), `export const mid = 'x'.repeat(100);\n`);
    await writeFile(path.join(libDir, 'big.ts'), `export const big = '${'y'.repeat(70 * 1024)}';\n`);
    await writeFile(path.join(libDir, 'notes.md'), '# notes\n');

    const result = await PromptAttachmentProcessor.resolveAndAttach('Review @lib', workspace);

    assert.equal(result.hasAttachments, true);
    assert.equal(result.anchorPaths, undefined);
    const ranked = (result.relatedFiles || []).filter((item) => item.reason === 'dir-top-ranked').map((item) => item.path);
    assert.ok(ranked.includes('lib/small.ts'), `expected small.ts in [${ranked.join(', ')}]`);
    assert.ok(ranked.includes('lib/mid.ts'), `expected mid.ts in [${ranked.join(', ')}]`);
    assert.ok(!ranked.includes('lib/big.ts'), 'oversized file must be excluded from dir top-ranked');
    assert.ok(!ranked.includes('lib/notes.md'), 'non-code file must be excluded from dir top-ranked');
    assert.match(result.expandedPrompt, /\[Attachment Neighborhood/);
  });
});

test('MINUS_ATTACH_EXPAND=off disables neighborhood expansion', async () => {
  await withWorkspace(async (workspace, root) => {
    await writeFile(path.join(root, 'solo.ts'), `export const solo = 1;\n`);
    const previous = process.env.MINUS_ATTACH_EXPAND;
    process.env.MINUS_ATTACH_EXPAND = 'off';
    try {
      const result = await PromptAttachmentProcessor.resolveAndAttach('Check @solo.ts', workspace);
      assert.equal(result.hasAttachments, true);
      assert.equal(result.expansionEnabled, false);
      assert.equal(result.relatedFiles, undefined);
      assert.ok(!result.expandedPrompt.includes('[Attachment Neighborhood'));
      assert.deepEqual(result.anchorPaths, ['solo.ts']);
    } finally {
      if (previous === undefined) delete process.env.MINUS_ATTACH_EXPAND;
      else process.env.MINUS_ATTACH_EXPAND = previous;
    }
  });
});

test('dedups unchanged re-attached files against recent context', async () => {
  await withWorkspace(async (workspace, root) => {
    await writeFile(path.join(root, 'note.ts'), `export const note = 1;\n`);
    const first = await PromptAttachmentProcessor.resolveAndAttach('Review @note.ts', workspace);
    assert.match(first.expandedPrompt, /\[Attached File: note\.ts \(\d+ lines • [\d.]+ KB • sha:[0-9a-f]{8}\)\]/);

    const second = await PromptAttachmentProcessor.resolveAndAttach('Review again @note.ts', workspace, {
      recentContextTexts: [first.expandedPrompt],
    });
    assert.match(second.expandedPrompt, /unchanged since earlier context/);
    assert.ok(!second.expandedPrompt.includes('export const note'), 'full content must not repeat');
    // Anchor header stays compatible with agent-loop detectAttachmentAnchors.
    const anchors: string[] = [];
    const re = /\[Attached (?:Binary )?File: (.+?) \(\d+(?:\.\d+)? (?:lines|KB)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(second.expandedPrompt)) !== null) anchors.push(m[1].trim());
    assert.deepEqual(anchors, ['note.ts']);
    assert.deepEqual(second.anchorPaths, ['note.ts']);
  });
});

test('re-attaches fully when the file changed since recent context', async () => {
  await withWorkspace(async (workspace, root) => {
    await writeFile(path.join(root, 'note.ts'), `export const note = 1;\n`);
    const first = await PromptAttachmentProcessor.resolveAndAttach('Review @note.ts', workspace);
    await writeFile(path.join(root, 'note.ts'), `export const note = 2;\nexport const extra = 3;\n`);
    const second = await PromptAttachmentProcessor.resolveAndAttach('Review again @note.ts', workspace, {
      recentContextTexts: [first.expandedPrompt],
    });
    assert.ok(!second.expandedPrompt.includes('unchanged since earlier context'));
    assert.ok(second.expandedPrompt.includes('export const extra'));
  });
});

test('downgrades full files to AST slice instead of skipping at the token cap', async () => {
  await withWorkspace(async (workspace, root) => {
    // 5 files x ~7.4KB: under the 64KB source gate but over the ~12k token cap
    // unless the last file downgrades to a slice (each is under auto-slice thresholds).
    const names = Array.from({ length: 5 }, (_, i) => `big-${i}.ts`);
    await Promise.all(names.map((file, i) =>
      writeFile(path.join(root, file), `// file ${i}\n` + `export const v${i} = '${'y'.repeat(50)}';\n`.repeat(100)),
    ));
    const result = await PromptAttachmentProcessor.resolveAndAttach(names.map((n) => `@${n}`).join(' '), workspace);
    assert.equal(result.attachments.length, 5);
    assert.ok(
      result.attachments.some((a) => (a.preview || '').includes('cap-downgrade')),
      `expected a cap-downgraded slice, got previews: ${result.attachments.map((a) => a.preview).join(' | ')}`,
    );
  });
});

test('caches importer scans across repeated attachments', async () => {
  await withWorkspace(async (workspace, root) => {
    await writeFile(path.join(root, 'alpha.ts'), `import { beta } from './beta.js';\nexport const alpha = 1;\n`);
    await writeFile(path.join(root, 'beta.ts'), `export const beta = 2;\n`);
    const first = await PromptAttachmentProcessor.resolveAndAttach('Fix bug in @alpha.ts', workspace);
    const second = await PromptAttachmentProcessor.resolveAndAttach('Fix bug in @alpha.ts', workspace);
    assert.deepEqual(second.relatedFiles, first.relatedFiles);
    assert.deepEqual(second.anchorPaths, first.anchorPaths);
  });
});

