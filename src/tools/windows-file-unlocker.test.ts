import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { deleteFileTool } from './delete-file.js';
import { Workspace } from '../workspace/workspace.js';
import { forceReleaseWindowsFileLock } from './windows-file-unlocker.js';

test('forceReleaseWindowsFileLock unlocks and deletes locked files on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows Restart Manager is only applicable on win32');
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-lock-test-'));
  const testFile = path.join(dir, 'locked.txt');
  await fs.writeFile(testFile, 'locked content');

  // Khởi chạy tiến trình nền độc lập chiếm giữ exclusive lock file
  const child = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$f = [System.IO.File]::Open('${testFile.replace(/\\/g, '\\\\')}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); Start-Sleep 30`,
  ], { stdio: 'ignore', windowsHide: true });

  // Đợi một khoảng ngắn để tiến trình nền mở handle
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    const ws = new Workspace(dir);

    // Xác nhận file đang bị khóa: xóa trực tiếp bằng fs.rm sẽ thất bại với EBUSY / EPERM
    let lockConfirmed = false;
    try {
      await fs.rm(testFile);
    } catch (err: any) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        lockConfirmed = true;
      }
    }
    assert.equal(lockConfirmed, true, 'File should be locked by child process initially');

    // Gọi tool delete_file: cơ chế Windows Restart Manager sẽ giải phóng lock và xóa file
    const result = await deleteFileTool.execute({ path: 'locked.txt' }, ws);
    assert.equal(result.success, true);
    assert.deepEqual(result.deleted, ['locked.txt']);

    // Xác nhận file đã biến mất hoàn toàn
    await assert.rejects(fs.stat(testFile));
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {}
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
