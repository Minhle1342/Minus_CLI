import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PromptAssembler, resolveSectionTier } from './prompt-assembler.js';
import {
  detectPromptContext,
  clearPromptContextCache,
  CORE_SYSTEM_PROMPT,
} from './prompt-sections.js';

test('PromptAssembler - Strict Static-First Prefix Alignment (T0 -> T1 -> T2 -> T3)', () => {
  const assembler = new PromptAssembler();

  // Đăng ký các section lộn xộn, T3 trước T0
  assembler.register({ id: 'dynamic-context', content: 'Turn 5 user query and observations', priority: 1200 }); // T3
  assembler.register({ id: 'session-playbook', content: 'Playbook: explore -> plan -> implement', priority: 500 }); // T2
  assembler.register({ id: 'tool-declarations', content: 'Tools: read_file, replace_text', priority: 100 }); // T1
  assembler.register({ id: 'system-invariant', content: 'Strict Safety Guardrails', priority: -1000 }); // T0

  const assembled = assembler.assembleForContext({});
  const lines = assembled.split('\n\n');

  // Kiểm tra thứ tự nghiêm ngặt Static-First: T0 -> T1 -> T2 -> T3
  assert.equal(lines[0], 'Strict Safety Guardrails', 'T0 (priority -1000) phải nằm ở vị trí đầu tiên');
  assert.equal(lines[1], 'Tools: read_file, replace_text', 'T1 (priority 100) phải đứng sau T0');
  assert.equal(lines[2], 'Playbook: explore -> plan -> implement', 'T2 (priority 500) phải đứng sau T1');
  assert.equal(lines[3], 'Turn 5 user query and observations', 'T3 (priority 1200) phải đứng ở đuôi');
});

test('PromptAssembler - Tier Resolution and Explicit Tier Overrides', () => {
  assert.equal(resolveSectionTier({ id: 'a', content: 'test', priority: -500 }), 'T0');
  assert.equal(resolveSectionTier({ id: 'b', content: 'test', priority: 0 }), 'T1');
  assert.equal(resolveSectionTier({ id: 'c', content: 'test', priority: 250 }), 'T1');
  assert.equal(resolveSectionTier({ id: 'd', content: 'test', priority: 500 }), 'T2');
  assert.equal(resolveSectionTier({ id: 'e', content: 'test', priority: 999 }), 'T2');
  assert.equal(resolveSectionTier({ id: 'f', content: 'test', priority: 1000 }), 'T3');
  assert.equal(resolveSectionTier({ id: 'g', content: 'test', tier: 'T0', priority: 9999 }), 'T0', 'Explicit tier ghi đè priority');
});

test('PromptAssembler - Canonical Text Normalization eliminates whitespace noise', () => {
  const assembler = new PromptAssembler();

  // Text với khoảng trắng dư ở cuối dòng và thụt dòng lạ
  const dirtyContent = 'Line 1 with trailing spaces     \r\nLine 2 with trailing tabs\t\t\r\n\r\nLine 3   ';
  assembler.register({ id: 'core', content: dirtyContent, priority: -1000 });

  const cleaned = assembler.assembleForContext({});
  assert(!cleaned.includes('\r'), 'Không được chứa ký tự Windows CRLF');
  assert(!cleaned.includes('spaces     \n'), 'Phải cắt bỏ trailing spaces');
  assert(!cleaned.includes('tabs\t\t\n'), 'Phải cắt bỏ trailing tabs');
  assert(cleaned.includes('Line 1 with trailing spaces\nLine 2 with trailing tabs'));
});

test('PromptAssembler - Static Prefix Invariance across dynamic step turns', () => {
  const assembler = new PromptAssembler();

  // Cấu hình các section cố định của Repository & Session
  assembler.register({ id: 'core', content: CORE_SYSTEM_PROMPT, priority: -1000 });
  assembler.register({ id: 'repo-rules', content: 'AGENTS.md guidelines and rules', priority: 50 });
  assembler.register({ id: 'session-dag', content: 'DAG Plan: Step 1 -> Step 2', priority: 500 });

  // Turn 1 (chưa có dynamic tail)
  const initial = assembler.assembleForContext({});
  assert(initial.length > 0);

  // Giả lập Turn 2: Thêm dynamic tail của Step 1 (T3 luôn nằm ở đuôi)
  const unregisterStep1 = assembler.register({
    id: 'step-1-context',
    content: 'User query: Fix bug in auth. Error output: 401 Unauthorized',
    priority: 1500, // T3
  });

  const step1 = assembler.assembleForContext({});

  // BẤT BIẾN KV-CACHE: thêm dynamic T3 section chỉ nối đuôi, tiền tố giữ nguyên!
  assert(step1.startsWith(initial), 'Stable prefix phải 100% bất biến khi thêm dynamic T3 section');
  assert(step1.includes('User query: Fix bug in auth'));

  // Giả lập Turn 3: Chuyển sang Step 2 với dynamic context hoàn toàn mới
  unregisterStep1();
  assembler.register({
    id: 'step-2-context',
    content: 'Observation: Found missing token header in auth.ts:42',
    priority: 1500, // T3
  });

  const step2 = assembler.assembleForContext({});

  assert(step2.startsWith(initial), 'Prefix vẫn giữ nguyên tuyệt đối ở Step 2');
  assert(step2.includes('auth.ts:42'));
  assert(!step2.includes('401 Unauthorized'), 'Tail cũ phải biến mất khi sang step mới');
});

test('detectPromptContext - SOTA Polyglot and Monorepo Workspace Fingerprinting', () => {
  clearPromptContextCache();

  // Test trên repo hiện tại
  const ctx = detectPromptContext(undefined, undefined, 'Kiểm tra dependencies trong package.json');

  assert.equal(ctx.isUnity, false, 'Nhận diện đúng non-Unity project');
  assert.ok(ctx.ecosystems?.includes('node'), 'Phát hiện Node ecosystem từ package.json');
  assert.equal(ctx.primaryLanguage, 'typescript', 'Phát hiện TypeScript từ tsconfig.json');

  // Test giả lập Monorepo trong thư mục tạm
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-agent-monorepo-test-'));
  try {
    // 1. Giả lập pnpm workspace monorepo
    fs.writeFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root' }));

    clearPromptContextCache();
    const pnpmCtx = detectPromptContext({ rootDir: tmpDir } as any, undefined, 'Check status');
    assert.equal(pnpmCtx.isMonorepo, true, 'Nhận diện pnpm monorepo');
    assert.equal(pnpmCtx.monorepoKind, 'pnpm');

    // 2. Giả lập Python + Rust polyglot repo
    fs.unlinkSync(path.join(tmpDir, 'pnpm-workspace.yaml'));
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "my-py-app"\n');
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "my-rust-crate"\nversion = "0.1.0"\n');

    clearPromptContextCache();
    const polyCtx = detectPromptContext({ rootDir: tmpDir } as any, undefined, 'Inspect code');
    assert.equal(polyCtx.isPython, true, 'Phát hiện Python');
    assert.equal(polyCtx.isRust, true, 'Phát hiện Rust');
    assert.ok(polyCtx.ecosystems?.includes('python'));
    assert.ok(polyCtx.ecosystems?.includes('rust'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearPromptContextCache();
  }
});
