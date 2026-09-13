import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { resolvePatchFormatSpec, resolvePhaseDynamicGuidance } from '../llm/prompt-sections.js';
import { ToolSynergyAdvisor } from './tool-synergy-advisor.js';

test('Prompt Engineering Mũi nhọn 1: getProjectDigest với Task-Conditioned Relevance Scoring', () => {
  const memory = new ProjectMemoryManager('d:/AgentLearn/CodingAgent');
  (memory as any).memoryData = {
    projectName: 'DemoProject',
    projectType: 'TypeScript/Node.js',
    packageManager: 'npm',
    scripts: {
      lint: 'eslint src/',
      build: 'tsc -b',
      test: 'vitest run',
      start: 'node dist/index.js',
      format: 'prettier --write .',
      docs: 'typedoc src/',
    },
    keyDirectories: { src: 'Source files', test: 'Test files' },
    dependenciesSummary: [],
    codingConventions: [
      'Tuân thủ ESLint và Prettier',
      'Viết unit test cho tất cả utility functions',
      'Không dùng any trong production code',
    ],
    learnedInsights: [],
    lastIndexed: new Date().toISOString(),
    isMonorepo: true,
    monorepoWorkspaces: [
      { name: 'web-client', relativePath: 'packages/client', scripts: { dev: 'vite', build: 'vite build' } },
      { name: 'backend-api', relativePath: 'packages/server', scripts: { dev: 'ts-node-dev src/server.ts', test: 'vitest' } },
    ],
  };

  // Test 1a: Không truyền tham số -> giữ nguyên thứ tự alphabet mặc định
  const defaultDigest = memory.getProjectDigest();
  assert.match(defaultDigest, /\[PROJECT KNOWLEDGE BASE - WARM START MEMORY\]/);
  assert.match(defaultDigest, /"build": tsc -b, "docs": typedoc src\//);

  // Test 1b: Truyền query liên quan đến test -> script 'test' được đẩy lên đầu
  const testDigest = memory.getProjectDigest({ query: 'chạy kiểm thử unit test cho dự án' });
  const testFirstPart = testDigest.split('\n').find((l) => l.startsWith('- Lệnh khả dụng:'));
  assert.ok(testFirstPart, 'Phải có dòng Lệnh khả dụng');
  assert.ok(testFirstPart.includes('"test": vitest run'), 'Script test phải có trong danh sách');
  assert.ok(testFirstPart.indexOf('"test":') < testFirstPart.indexOf('"build":'), 'Script test phải xếp trước build khi query hỏi về test');

  // Test 1c: Truyền activeFiles của backend workspace -> workspace backend-api được ưu tiên
  const backendDigest = memory.getProjectDigest({
    query: 'sửa route authentication',
    activeFiles: ['packages/server/src/auth.ts'],
  });
  assert.ok(backendDigest.includes('packages/server'), 'Monorepo workspace packages/server phải xuất hiện');
  const serverIndex = backendDigest.indexOf('packages/server');
  const clientIndex = backendDigest.indexOf('packages/client');
  assert.ok(serverIndex < clientIndex, 'Workspace packages/server phải được ưu tiên trước packages/client');
});

test('Prompt Engineering Mũi nhọn 2: resolvePatchFormatSpec Dynamic Few-Shot Selection', () => {
  // Test 2a: Python target file
  const pySpec = resolvePatchFormatSpec('app/services/calculator.py');
  assert.match(pySpec, /def compute\(a: int, b: int\) -> int:/);
  assert.match(pySpec, /--- a\/app\/calculator\.py/);

  // Test 2b: Go target file
  const goSpec = resolvePatchFormatSpec('internal/pkg/calculator.go');
  assert.match(goSpec, /func Compute\(a, b int\) int \{/);
  assert.match(goSpec, /--- a\/pkg\/calc\.go/);

  // Test 2c: Rust target file
  const rsSpec = resolvePatchFormatSpec('src/math/calculator.rs');
  assert.match(rsSpec, /pub fn compute\(a: i32, b: i32\) -> i32 \{/);
  assert.match(rsSpec, /--- a\/src\/calc\.rs/);

  // Test 2d: JSON target file
  const jsonSpec = resolvePatchFormatSpec('package.json');
  assert.match(jsonSpec, /"version": "1\.0\.0"/);
  assert.match(jsonSpec, /"debug":/);

  // Test 2e: TypeScript hoặc undefined -> Fallback mặc định
  const defaultSpec = resolvePatchFormatSpec();
  assert.match(defaultSpec, /const a = 1;/);
  const tsSpec = resolvePatchFormatSpec('src/index.ts');
  assert.match(tsSpec, /const a = 1;/);

  // Test 2f: Tích hợp trong resolvePhaseDynamicGuidance
  const phaseGuidancePy = resolvePhaseDynamicGuidance('implement', {
    targetFile: 'src/analytics.py',
    includePatchSpec: true,
  });
  assert.match(phaseGuidancePy, /def compute\(a: int, b: int\) -> int:/);
});

test('Prompt Engineering Mũi nhọn 3: ToolSynergyAdvisor Call-Graph Aware Guidance', () => {
  const advisor = new ToolSynergyAdvisor();

  // Test 3a: Code mutation với Call Graph Context (Caller expectations)
  const mutationAdvice = advisor.advise({
    lastToolName: 'replace_file_content',
    lastToolResult: { success: true },
    callGraphContext: {
      symbol: 'authenticateSession',
      callers: ['authMiddleware', 'oauthCallbackHandler'],
      callees: ['verifyTokenJwt'],
    },
  });
  assert.equal(mutationAdvice.playbook, 'C_MUTATION');
  assert.match(mutationAdvice.guidance, /\[Graph Intelligence\]: Symbol "authenticateSession" is invoked by: \[authMiddleware, oauthCallbackHandler\]/);
  assert.match(mutationAdvice.guidance, /Verify caller expectations before finishing mutation/);

  // Test 3b: Root Cause Debugging với Call Graph Context (Graph Trace defect locus)
  const debuggingAdvice = advisor.advise({
    hasErrors: true,
    callGraphContext: {
      symbol: 'processPayment',
      callers: ['checkoutController'],
      callees: ['stripeGateway', 'auditLogger'],
    },
  });
  assert.equal(debuggingAdvice.playbook, 'B_DEBUGGING');
  assert.match(debuggingAdvice.guidance, /\[Graph Trace\]: Defect locus "processPayment" invoked by \[checkoutController\] calls \[stripeGateway, auditLogger\]/);

  // Test 3c: apply_patch lỗi với Python target file -> sử dụng dynamic few-shot patch spec
  const patchErrorAdvice = advisor.advise({
    lastToolName: 'apply_patch',
    lastToolResult: { error: 'Hunk #1 failed at offset 20' },
    lastTargetFile: 'server/app.py',
  });
  assert.equal(patchErrorAdvice.playbook, 'C_MUTATION');
  assert.match(patchErrorAdvice.guidance, /def compute\(a: int, b: int\) -> int:/);
});
