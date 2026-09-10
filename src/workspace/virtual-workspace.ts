import path from 'node:path';
import {
  nativeVfsCommitToDisk,
  nativeVfsCreateSession,
  nativeVfsDeleteFile,
  nativeVfsDestroySession,
  nativeVfsGenerateDiff,
  nativeVfsListModified,
  nativeVfsReadFile,
  nativeVfsWriteFile,
  type NativeVfsFileStatus,
} from '../native/index.js';

export interface VirtualFileDiff {
  path: string;
  status: 'created' | 'modified' | 'deleted';
  diffText: string;
}

export interface VirtualWorkspaceStats {
  sessionId: string;
  totalDirtyFiles: number;
  createdCount: number;
  modifiedCount: number;
  deletedCount: number;
  totalDirtyBytes: number;
}

/**
 * In-Memory Copy-on-Write (CoW) Virtual Workspace.
 * 
 * Cho phép các Subagents rẽ nhánh (branching) và thử nghiệm sửa code hoàn toàn trong RAM
 * với độ trễ O(1) < 1µs, loại bỏ 100% chi phí I/O ổ đĩa vật lý và xung đột file locks trên Windows NTFS.
 * 
 * Khi Quality Gate thông qua, các thay đổi dirty mới được commit nguyên tử xuống đĩa.
 * Nếu thất bại hoặc bị hủy bỏ, toàn bộ RAM overlay được giải phóng ngay lập tức (zero disk pollution).
 */
export class VirtualWorkspace {
  readonly sessionId: string;
  readonly rootDir: string;
  private isDisposed = false;

  constructor(sessionId: string, rootDir: string) {
    this.sessionId = sessionId;
    this.rootDir = path.resolve(rootDir);
    nativeVfsCreateSession(this.sessionId, this.rootDir);
  }

  /**
   * Đọc file từ Virtual Workspace:
   * Trả về nội dung sửa đổi trong RAM nếu có (dirty), ngược lại đọc từ đĩa gốc.
   */
  readFile(relPath: string): string | null {
    this.assertActive();
    return nativeVfsReadFile(this.sessionId, relPath);
  }

  /**
   * Ghi file vào RAM overlay với tốc độ O(1)
   */
  writeFile(relPath: string, content: string): boolean {
    this.assertActive();
    return nativeVfsWriteFile(this.sessionId, relPath, content);
  }

  /**
   * Đánh dấu xóa file trong Virtual Workspace
   */
  deleteFile(relPath: string): boolean {
    this.assertActive();
    return nativeVfsDeleteFile(this.sessionId, relPath);
  }

  /**
   * Liệt kê danh sách các file đang bị sửa đổi (dirty files)
   */
  listModified(): NativeVfsFileStatus[] {
    this.assertActive();
    return nativeVfsListModified(this.sessionId);
  }

  /**
   * Sinh unified diff từ toàn bộ các thay đổi trong RAM so với đĩa gốc
   */
  generateDiff(): string {
    this.assertActive();
    return nativeVfsGenerateDiff(this.sessionId);
  }

  /**
   * Lấy thống kê trạng thái thay đổi trong Virtual Workspace
   */
  getStats(): VirtualWorkspaceStats {
    const list = this.listModified();
    let created = 0;
    let modified = 0;
    let deleted = 0;
    let bytes = 0;

    for (const item of list) {
      if (item.status === 'created') created++;
      else if (item.status === 'deleted') deleted++;
      else modified++;
      bytes += item.sizeBytes;
    }

    return {
      sessionId: this.sessionId,
      totalDirtyFiles: list.length,
      createdCount: created,
      modifiedCount: modified,
      deletedCount: deleted,
      totalDirtyBytes: bytes,
    };
  }

  /**
   * Ghi nhận toàn bộ thay đổi hợp lệ từ RAM xuống đĩa vật lý (Atomic Flush)
   * Chỉ gọi khi Verification Quality Gate đã xác nhận pass.
   */
  commitToDisk(): string[] {
    this.assertActive();
    return nativeVfsCommitToDisk(this.sessionId);
  }

  /**
   * Hủy bỏ phiên Virtual Workspace, giải phóng RAM và loại bỏ toàn bộ thay đổi nháp
   */
  discard(): void {
    if (!this.isDisposed) {
      nativeVfsDestroySession(this.sessionId);
      this.isDisposed = true;
    }
  }

  private assertActive(): void {
    if (this.isDisposed) {
      throw new Error(`VirtualWorkspace session "${this.sessionId}" has been disposed.`);
    }
  }
}
