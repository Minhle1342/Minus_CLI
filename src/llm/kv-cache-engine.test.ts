import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PromptAssembler, resolveSectionTier } from './prompt-assembler.js';
import {
  detectPromptContext,
  clearPromptContextCache,
  DEFAULT_PROMPT_SECTIONS,
  CORE_SYSTEM_PROMPT,
} from './prompt-sections.js';

test('PromptAssembler - Strict Static-First Prefix Alignment (T0 -> T1 -> T2 -> T3)', () => {
  const assembler = new PromptAssembler();

  // Đăng ký các section lộn xộn, T3 trước T0
  assembler.register({ id: 'dynamic-context', content: 'Turn 5 user query and observations', priority: 1200 }); // T3
  assembler.register({ id: 'session-playbook', content: 'Playbook: explore -> plan -> implement', priority: 500 }); // T2
  assembler.register({ id: 'tool-declarations', content: 'Tools: read_file, replace_text', priority: 100 }); // T1
  assembler.register({ id: 'system-invariant', content: 'Strict Safety Guardrails', priority: -1000 }); // T0

  const assembled = assembler.assemble();
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

  const cleaned = assembler.assemble();
  assert(!cleaned.includes('\r'), 'Không được chứa ký tự Windows CRLF');
  assert(!cleaned.includes('spaces     \n'), 'Phải cắt bỏ trailing spaces');
  assert(!cleaned.includes('tabs\t\t\n'), 'Phải cắt bỏ trailing tabs');
  assert(cleaned.includes('Line 1 with trailing spaces\nLine 2 with trailing tabs'));
});

test('PromptAssembler - assembleTiered & Prefix Invariance across dynamic step turns', () => {
  const assembler = new PromptAssembler();

  // Cấu hình các section cố định của Repository & Session
  assembler.register({ id: 'core', content: CORE_SYSTEM_PROMPT, priority: -1000 });
  assembler.register({ id: 'repo-rules', content: 'AGENTS.md guidelines and rules', priority: 50 });
  assembler.register({ id: 'session-dag', content: 'DAG Plan: Step 1 -> Step 2', priority: 500 });

  // Lấy stable prefix signature tại turn 1 (chưa có dynamic tail)
  const initialSig = assembler.getStablePrefixSignature();
  const initialTiered = assembler.assembleTiered();

  assert(initialTiered.stablePrefix.length > 0);
  assert.equal(initialTiered.t3DynamicTail, '');

  // Giả lập Turn 2: Thêm dynamic tail của Step 1
  const unregisterStep1 = assembler.register({
    id: 'step-1-context',
    content: 'User query: Fix bug in auth. Error output: 401 Unauthorized',
    priority: 1500, // T3
  });

  const step1Sig = assembler.getStablePrefixSignature();
  const step1Tiered = assembler.assembleTiered();

  // BẤT BIẾN KV-CACHE: Stable prefix signature KHÔNG ĐỔI dù có thêm dynamic tail!
  assert.equal(step1Sig, initialSig, 'Prefix signature phải 100% bất biến khi thêm dynamic T3 section');
  assert.equal(step1Tiered.stablePrefix, initialTiered.stablePrefix, 'Nội dung stable prefix phải giữ nguyên tuyệt đối');
  assert(step1Tiered.t3DynamicTail.includes('User query: Fix bug in auth'));

  // Giả lập Turn 3: Chuyển sang Step 2 với dynamic context hoàn toàn mới
  unregisterStep1();
  assembler.register({
    id: 'step-2-context',
    content: 'Observation: Found missing token header in auth.ts:42',
    priority: 1500, // T3
  });

  const step2Sig = assembler.getStablePrefixSignature();
  const step2Tiered = assembler.assembleTiered();

  assert.equal(step2Sig, initialSig, 'Prefix signature vẫn giữ nguyên tuyệt đối ở Step 2');
  assert.equal(step2Tiered.stablePrefix, initialTiered.stablePrefix);
  assert(step2Tiered.t3DynamicTail.includes('auth.ts:42'));
});

test('PromptAssembler - createCacheEnvelope generates deterministic cache key', () => {
  const assembler = new PromptAssembler();
  for (const s of DEFAULT_PROMPT_SECTIONS) {
    assembler.register(s);
  }

  const envelope = assembler.createCacheEnvelope({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    toolSchemaVersion: 'schema-v1',
  });

  assert.equal(envelope.version, 2);
  assert(envelope.cacheKey.startsWith('pc2_'), 'Cache key phải có tiền tố pc2_');
  assert(envelope.tiers.length >= 2, 'Phải có ít nhất T0 và T1');
  assert(envelope.metadata.provider === 'gemini');
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
