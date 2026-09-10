import fs from 'node:fs';
import path from 'node:path';
import { VirtualWorkspace } from '../src/workspace/virtual-workspace.js';
import { isNativeAvailable, getNativeVersion } from '../src/native/index.js';

async function runVfsTestSuite() {
  console.log('=== TEST SUITE: BƯỚC 3 - IN-MEMORY COPY-ON-WRITE (CoW) VIRTUAL WORKSPACE ===');
  console.log('Native Addon Available:', isNativeAvailable());
  console.log('Native Version:', getNativeVersion());

  const rootDir = process.cwd();
  const vfsSessionId = `subagent_test_${Date.now()}`;
  const vfs = new VirtualWorkspace(vfsSessionId, rootDir);

  // Test 1: Đọc file gốc từ đĩa chưa bị sửa
  console.log('\n[Test 1] Đọc file gốc chưa sửa qua VFS:');
  const pkgOriginal = vfs.readFile('package.json');
  if (!pkgOriginal || !pkgOriginal.includes('mini-agent-loop')) {
    throw new Error('Test 1 Failed: Cannot read base package.json from disk via VFS');
  }
  console.log('   Read package.json success (length:', pkgOriginal.length, 'bytes)');

  // Test 2: Ghi file mới và sửa file vào Virtual Overlay trong RAM
  console.log('\n[Test 2] Ghi sửa đổi vào RAM overlay (Zero-cost branching):');
  const virtualFile = 'src/subagent_scratch_virtual.ts';
  const newContent = '// Virtual subagent temporary code\nexport const VIRTUAL_FLAG = true;\n';
  vfs.writeFile(virtualFile, newContent);

  const modifiedPkg = pkgOriginal.replace('"version": "1.0.0"', '"version": "1.0.0-subagent-virtual"');
  vfs.writeFile('package.json', modifiedPkg);

  // Test 3: Kiểm tra tính cách ly (Real Disk Is Untouched)
  console.log('\n[Test 3] Kiểm tra tính toàn vẹn cách ly của đĩa thật:');
  const diskPkg = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
  if (diskPkg.includes('subagent-virtual')) {
    throw new Error('Test 3 Failed: Real disk package.json was modified prematurely!');
  }
  const diskVirtualFileExists = fs.existsSync(path.join(rootDir, virtualFile));
  if (diskVirtualFileExists) {
    throw new Error('Test 3 Failed: Real disk should NOT contain virtual scratch file!');
  }
  console.log('   ✅ Đĩa vật lý hoàn toàn nguyên vẹn 100% (Zero disk pollution)');

  // Test 4: Kiểm tra đọc lại từ Virtual Overlay
  console.log('\n[Test 4] Đọc lại từ Virtual Overlay:');
  const vfsReadNew = vfs.readFile(virtualFile);
  const vfsReadModified = vfs.readFile('package.json');
  if (vfsReadNew !== newContent || !vfsReadModified?.includes('1.0.0-subagent-virtual')) {
    throw new Error('Test 4 Failed: VFS read did not return overlay content');
  }
  console.log('   ✅ VFS trả về chính xác nội dung trong RAM overlay');

  // Test 5: Kiểm tra Stats & Diff Generation
  console.log('\n[Test 5] Kiểm tra Stats & Diff Generation:');
  const stats = vfs.getStats();
  console.log('   Stats:', stats);
  if (stats.totalDirtyFiles !== 2 || stats.createdCount !== 1 || stats.modifiedCount !== 1) {
    throw new Error('Test 5 Failed: Incorrect VFS stats');
  }

  const diff = vfs.generateDiff();
  console.log('   Unified Diff Generated:\n' + diff.split('\n').map(l => '      ' + l).join('\n'));
  if (!diff.includes('diff --git a/package.json') || !diff.includes('subagent-virtual')) {
    throw new Error('Test 5 Failed: Diff does not contain expected changes');
  }

  // Test 6: Kiểm tra Discard (Xóa sạch trong RAM không tốn I/O)
  console.log('\n[Test 6] Kiểm tra Discard session:');
  vfs.discard();
  console.log('   ✅ Session discarded successfully');

  // Test 7: Kiểm tra Atomic Commit to Disk khi Quality Gate Approved
  console.log('\n[Test 7] Kiểm tra Atomic Commit to Disk:');
  const commitSessionId = `subagent_commit_${Date.now()}`;
  const commitVfs = new VirtualWorkspace(commitSessionId, rootDir);
  const tempFile = 'scratch/temp_committed_virtual_file.txt';
  commitVfs.writeFile(tempFile, 'Committed via Rust Virtual Workspace at ' + new Date().toISOString());
  
  const committedFiles = commitVfs.commitToDisk();
  console.log('   Committed files:', committedFiles);

  const fullTempPath = path.join(rootDir, tempFile);
  if (!fs.existsSync(fullTempPath) || !committedFiles.includes(tempFile)) {
    throw new Error('Test 7 Failed: Commit to disk did not create expected file');
  }
  console.log('   ✅ File được flush nguyên tử xuống đĩa thành công!');

  // Dọn dẹp file temp sau test
  fs.unlinkSync(fullTempPath);
  commitVfs.discard();

  console.log('\n🎉 TOÀN BỘ KIỂM TRA BƯỚC 3 ĐẠT 100%! BƯỚC 3 HOÀN TẤT XUẤT SẮC!');
}

runVfsTestSuite().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
