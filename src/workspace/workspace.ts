import path from 'node:path';
import fs from 'node:fs';

/**
 * Workspace quản lý thư mục làm việc và thiết lập ranh giới an toàn cho Coding Agent.
 * 
 * Đảm bảo:
 * 1. Mọi thao tác đọc/ghi file luôn nằm trong workspaceRoot (chống path traversal & symlink escape).
 * 2. Cung cấp danh sách các thư mục cần bỏ qua (node_modules, .git, dist,...).
 * 3. Nhận diện các định dạng file nhị phân (binary) để tránh làm tràn context LLM.
 * 4. Bảo vệ các file cấu hình nhạy cảm (.env,...).
 */
export class Workspace {
  readonly rootDir: string;
  readonly realRootDir: string;

  // Danh sách các thư mục bỏ qua khi duyệt codebase
  readonly ignoredDirectories: readonly string[] = [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.gemini',
    '.codingagent',
    'temp',
    '.turbo',
    '.next',
  ];

  // Danh sách các phần mở rộng file nhị phân bỏ qua khi tìm kiếm text
  readonly binaryExtensions: readonly string[] = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.exe',
    '.bin',
    '.dll',
    '.so',
    '.dylib',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.mp3',
    '.mp4',
    '.avi',
    '.mov',
  ];

  // Danh sách các file nhạy cảm cần chặn ghi đè trực tiếp (mặc định rỗng hoặc tùy chỉnh khi cần)
  protectedFiles: string[];

  constructor(rootDir: string = process.cwd(), options?: { protectedFiles?: string[]; ignoredDirectories?: string[]; binaryExtensions?: string[] }) {
    this.rootDir = path.resolve(rootDir);
    try {
      this.realRootDir = fs.existsSync(this.rootDir) ? fs.realpathSync(this.rootDir) : this.rootDir;
    } catch {
      this.realRootDir = this.rootDir;
    }
    this.protectedFiles = options?.protectedFiles ? [...options.protectedFiles] : [];
    if (options?.ignoredDirectories) {
      this.ignoredDirectories = [...this.ignoredDirectories, ...options.ignoredDirectories];
    }
    if (options?.binaryExtensions) {
      this.binaryExtensions = [...this.binaryExtensions, ...options.binaryExtensions];
    }
  }

  /**
   * Kiểm tra và chuẩn hoá đường dẫn an toàn trong workspace.
   * Ném ra lỗi Security Exception nếu đường dẫn cố tình thoát ra ngoài workspace hoặc trỏ qua symlink ra ngoài.
   */
  resolveSafePath(targetPath: string): string {
    const resolved = path.resolve(this.rootDir, targetPath);
    const relative = path.relative(this.rootDir, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Security Exception: Access denied for path outside workspace: "${targetPath}"`);
    }

    // Kiểm tra symlink escape trên filesystem
    try {
      let currentCheck: string = resolved;
      while (!fs.existsSync(currentCheck)) {
        const parent = path.dirname(currentCheck);
        if (parent === currentCheck) break;
        currentCheck = parent;
      }
      if (fs.existsSync(currentCheck)) {
        const realTarget = fs.realpathSync(currentCheck);
        const realRelative = path.relative(this.realRootDir, realTarget);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          throw new Error(`Security Exception: Symlink target resolves outside workspace: "${targetPath}"`);
        }
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith('Security Exception:')) {
        throw err;
      }
    }

    return resolved;
  }

  /**
   * Chuyển đổi đường dẫn tuyệt đối thành đường dẫn tương đối so với workspaceRoot (dùng hiển thị cho LLM/CLI).
   */
  toRelativePath(absolutePath: string): string {
    return path.relative(this.rootDir, absolutePath).replace(/\\/g, '/');
  }

  /**
   * Kiểm tra xem một thư mục có nằm trong danh sách bỏ qua hay không.
   */
  isIgnoredDirectory(dirName: string): boolean {
    return this.ignoredDirectories.includes(dirName);
  }

  /**
   * Kiểm tra xem một file có phải là file nhị phân hay không.
   */
  isBinaryFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return this.binaryExtensions.includes(ext);
  }

  /**
   * Kiểm tra xem một file có thuộc danh sách bảo vệ (không cho ghi đè) hay không.
   */
  isProtectedFile(filePath: string): boolean {
    if (!this.protectedFiles || this.protectedFiles.length === 0) return false;
    const baseName = path.basename(filePath);
    return this.protectedFiles.includes(baseName);
  }

  setProtectedFiles(files: string[]): void {
    this.protectedFiles = [...files];
  }

  addProtectedFile(fileName: string): void {
    if (!this.protectedFiles.includes(fileName)) {
      this.protectedFiles.push(fileName);
    }
  }

  removeProtectedFile(fileName: string): void {
    this.protectedFiles = this.protectedFiles.filter((f) => f !== fileName);
  }
}
