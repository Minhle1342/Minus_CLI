import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitSolutionTool, registerSubmitSolutionTool } from './submit-solution.js';
import { ToolRegistry } from './registry.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';

test('submit_solution: schema exposes summary as required and verificationEvidence as optional', () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  assert.equal(tool.name, 'submit_solution');
  assert.equal(tool.parameters?.type, 'OBJECT');
  assert.ok(tool.parameters?.properties?.summary, 'summary property should exist');
  assert.ok(tool.parameters?.properties?.verificationEvidence, 'verificationEvidence property should exist');

  // Verify verificationEvidence is optional (commit 789183f)
  assert.deepEqual(tool.parameters?.required, ['summary']);
  assert.equal(tool.parameters?.required?.includes('verificationEvidence'), false);
});

test('submit_solution: executes successfully when verificationEvidence is omitted (defaults safely)', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const result = await tool.execute({
    summary: 'Updated command-preflight-guard.ts type definitions and validated with unit test suite.',
    filesModified: ['src/tools/command-preflight-guard.ts'],
  }, workspace);

  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.equal(result.verificationEvidence, 'Verified via inspection and direct validation');
  assert.deepEqual(result.filesModified, ['src/tools/command-preflight-guard.ts']);
  assert.equal(result.nextAction, 'final_answer');
});

test('submit_solution: executes successfully when verificationEvidence is provided', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const result = await tool.execute({
    summary: 'Implemented feature fix and ran verification.',
    verificationEvidence: 'npm test -- --filter=preflight passed with exit code 0',
    filesModified: ['src/tools/command-preflight-guard.ts'],
    rootCause: 'Missing workspaceRoot property in options type',
  }, workspace);

  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.equal(result.verificationEvidence, 'npm test -- --filter=preflight passed with exit code 0');
  assert.equal(result.rootCause, 'Missing workspaceRoot property in options type');
});

test('submit_solution: rejects empty summary', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({ summary: '   ' }, workspace);
  assert.equal(res.success, false);
  assert.equal(res.submitted, false);
  assert.equal(res.errorCode, 'EMPTY_SUMMARY');
});

test('submit_solution: Tool-Use Guardian rejects pseudo-claims without concrete findings', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Đã cung cấp câu trả lời chi tiết và đầy đủ cho người dùng.',
  }, workspace);

  assert.equal(res.success, false);
  assert.equal(res.submitted, false);
  assert.equal(res.errorCode, 'INVALID_SUMMARY_CONTENT');
});

test('submit_solution: rejects English evasive pseudo-claims lacking concrete findings', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'I will provide a full and detailed explanation shortly.',
  }, workspace);

  assert.equal(res.success, false);
  assert.equal(res.submitted, false);
  assert.equal(res.errorCode, 'INVALID_SUMMARY_CONTENT');
});

test('submit_solution: accepts valid technical explanation with substantive entity even with explanatory phrases', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Đã giải thích chi tiết nguyên nhân gây memory leak trong HeapProfiler và cấu hình lại pool.',
    filesModified: ['src/profiler/HeapProfiler.ts'],
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
  assert.ok(res.groundingScore && res.groundingScore >= 85);
});

test('submit_solution: accepts summary with expanded action verbs without markdown formatting', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Upgraded axios dependency to v1.7 and configured timeout settings in client.',
    filesModified: ['package.json'],
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: accepts concise investigation_only summary when rootCause is provided', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Tiến trình nền bị tràn bộ nhớ khi đọc file dữ liệu lớn.',
    resolutionType: 'investigation_only',
    rootCause: 'Out of memory in background worker process',
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: registers cleanly into ToolRegistry', () => {
  const registry = new ToolRegistry();
  const workspace = new Workspace();
  registerSubmitSolutionTool(registry, workspace);

  assert.ok(registry.has('submit_solution'));
  const tool = registry.get('submit_solution');
  assert.equal(tool?.name, 'submit_solution');
});

test('submit_solution: allows 3+ documentation files even with sensitive path words without demanding automated tests', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Cập nhật tài liệu hướng dẫn xác thực, quy trình thanh toán và xử lý sự cố đăng nhập.',
    filesModified: [
      'docs/auth-guide.md',
      'docs/payment-workflow.md',
      'docs/login-troubleshooting.md',
    ],
    verificationMethod: 'direct_validation',
    verificationEvidence: 'Đã đọc lại toàn bộ nội dung markdown và kiểm tra tính nhất quán.',
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
  assert.equal(res.verificationMethod, 'direct_validation');
});

test('submit_solution: allows 3+ files for text_or_asset_edit resolutionType', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Cập nhật nội dung hiển thị tiếng Việt và hình ảnh banner trên các trang giao diện.',
    resolutionType: 'text_or_asset_edit',
    filesModified: [
      'assets/banner.svg',
      'locales/vi.json',
      'locales/en.json',
    ],
    verificationMethod: 'diff_visual_inspection',
    verificationEvidence: 'Kiểm tra trực quan bằng diff các chuỗi i18n và asset.',
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: allows 3+ files for configuration_change resolutionType', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Điều chỉnh cấu hình triển khai Docker và cấu hình biến môi trường mẫu.',
    resolutionType: 'configuration_change',
    filesModified: [
      'docker-compose.yml',
      'Dockerfile',
      '.env.example',
    ],
    verificationMethod: 'direct_validation',
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: allows 3+ code files when userRequest explicitly exempts tests', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Refactor cấu trúc interface và điều chỉnh các type definitions trong hệ thống.',
    filesModified: [
      'src/models/user.ts',
      'src/models/account.ts',
      'src/models/session.ts',
    ],
    verificationMethod: 'direct_validation',
  }, workspace, {
    userRequest: 'Vui lòng cập nhật các interface trong 3 file trên, không cần chạy test.',
  } as any);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: rejects 3+ executable code files with weak verification method when not exempt', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Sửa logic xử lý dữ liệu và thuật toán tính toán trong 3 file mã nguồn.',
    resolutionType: 'code_fix',
    filesModified: [
      'src/models/user.ts',
      'src/models/account.ts',
      'src/models/session.ts',
    ],
    verificationMethod: 'direct_validation',
  }, workspace);

  assert.equal(res.success, false);
  assert.equal(res.submitted, false);
  assert.equal(res.errorCode, 'VERIFICATION_TIER_MISMATCH');
  assert.ok(res.error?.includes('VERIFICATION_TIER_MISMATCH') || res.error?.includes('HIGH threshold'));
});

test('submit_solution: accepts 3+ executable code files when verificationMethod is automated_test_pass', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Sửa logic xử lý dữ liệu và thuật toán tính toán trong 3 file mã nguồn kèm test pass.',
    resolutionType: 'code_fix',
    filesModified: [
      'src/models/user.ts',
      'src/models/account.ts',
      'src/models/session.ts',
    ],
    verificationMethod: 'automated_test_pass',
    verificationEvidence: 'npm test -- --filter=models passed 12/12 tests exit code 0',
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: accepts 3+ executable code files when verificationMethod is static_diagnostics_clean', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const res = await tool.execute({
    summary: 'Cập nhật type signature và xử lý type inference cho 3 module chính.',
    resolutionType: 'code_refactor',
    filesModified: [
      'src/models/user.ts',
      'src/models/account.ts',
      'src/models/session.ts',
    ],
    verificationMethod: 'static_diagnostics_clean',
    verificationEvidence: 'get_diagnostics reported 0 errors across workspace',
  }, workspace);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

test('submit_solution: accepts 3+ code files when session has a passing scratch reproduction script (post-fix repro pass)', async () => {
  const workspace = new Workspace();
  const tool = createSubmitSolutionTool(workspace);

  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('tool/call', {
    turn: 1,
    toolCallId: 'm1',
    toolName: 'replace_file_content',
    args: { targetFile: 'src/models/user.ts' },
  });
  session.append('tool/result', {
    turn: 1,
    toolCallId: 'm1',
    toolName: 'replace_file_content',
    result: { success: true, filesModified: ['src/models/user.ts'] },
  });

  // Chạy scratch repro script sau mutation và thành công (exitCode 0)
  session.append('tool/call', {
    turn: 1,
    toolCallId: 'r1',
    toolName: 'run_command',
    args: { command: 'node scratch/repro_bug.js' },
  });
  session.append('tool/result', {
    turn: 1,
    toolCallId: 'r1',
    toolName: 'run_command',
    result: { success: true, exitCode: 0, commandOutcome: 'succeeded' },
  });

  const res = await tool.execute({
    summary: 'Khắc phục sự cố trong hệ thống người dùng và xác thực qua script kiểm chứng.',
    resolutionType: 'code_fix',
    filesModified: [
      'src/models/user.ts',
      'src/models/account.ts',
      'src/models/session.ts',
    ],
    verificationMethod: 'direct_validation',
    verificationEvidence: 'Scratch repro script executed successfully with exit code 0',
  }, workspace, { session, turn: 1 } as any);

  assert.equal(res.success, true);
  assert.equal(res.submitted, true);
});

