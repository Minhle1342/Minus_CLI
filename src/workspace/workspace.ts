import path from 'node:path';

/**
 * Workspace quản lý thư mục làm việc và thiết lập ranh giới an toàn cho Coding Agent.
 * 
 * Đảm bảo:
 * 1. Mọi thao tác đọc/ghi file luôn nằm trong workspaceRoot (chống path traversal).
 * 2. Cung cấp danh sách các thư mục cần bỏ qua (node_modules, .git, dist,...).
 * 3. Nhận diện các định dạng file nhị phân (binary) để tránh làm tràn context LLM.
 */
export class Workspace {
  readonly rootDir: string;

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

  // Danh sách các file nhạy cảm cần chặn ghi đè trực tiếp
  readonly protectedFiles: readonly string[] = [
    '.env',
    '.env.local',
    '.env.production',
  ];

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Kiểm tra và chuẩn hoá đường dẫn an toàn trong workspace.
   * Ném ra lỗi Security Exception nếu đường dẫn cố tình thoát ra ngoài workspace.
   */
  resolveSafePath(targetPath: string): string {
    const resolved = path.resolve(this.rootDir, targetPath);
    const relative = path.relative(this.rootDir, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Security Exception: Access denied for path outside workspace: "${targetPath}"`);
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
    const baseName = path.basename(filePath);
    return this.protectedFiles.includes(baseName);
  }
}
