import path from 'node:path';
import fs from 'node:fs';
import { getNativeCore } from '../native/index.js';

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

  // Danh sách các thư mục bỏ qua khi duyệt codebase (Đa ngôn ngữ & đa Framework)
  readonly ignoredDirectories: readonly string[] = [
    // JS/TS & Web Frameworks
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.turbo',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.output',
    '.npm-cache',

    // Agent internals & Sandboxes
    '.gemini',
    '.codingagent',
    '.minus',
    '.gitnexus',
    '.eval-sandbox',
    '.opencodereview',

    // Version Control & VCS
    '.git',
    '.svn',
    '.hg',

    // Rust & Maven
    'target',

    // Python
    '__pycache__',
    '.venv',
    'venv',
    'env',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',

    // Java / Kotlin / Gradle
    '.gradle',
    '.m2',
    'out',

    // C# / .NET / Unity
    'bin',
    'obj',
    '.vs',
    'Library',
    'Packages',
    'Logs',
    'Builds',

    // PHP / Composer / Elixir / Swift / iOS / Flutter
    'vendor',
    '_build',
    'deps',
    '.dart_tool',
    '.flutter-plugins',
    '.flutter-plugins-dependencies',
    '.build',
    '.swiftpm',
    'DerivedData',
    'Pods',

    // C / C++ / CMake
    'cmake-build-debug',
    'cmake-build-release',
    '.cache',

    // IDEs & OS
    '.idea',
    '.vscode',
    '.DS_Store',
    'Thumbs.db',

    // Temporary
    'temp',
    'tmp',
  ];

  // Danh sách các phần mở rộng file nhị phân bỏ qua khi tìm kiếm text
  readonly binaryExtensions: readonly string[] = [
    // Images
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.webp',
    '.avif',
    '.bmp',
    '.tiff',
    // Documents / Archives
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.7z',
    '.rar',
    '.bz2',
    '.xz',
    '.jar',
    '.apk',
    '.aar',
    '.ipa',
    '.dmg',
    '.iso',
    // Executables / Native Libs / Bytecode
    '.exe',
    '.bin',
    '.dll',
    '.so',
    '.dylib',
    '.node',
    '.o',
    '.a',
    '.lib',
    '.obj',
    '.wasm',
    '.class',
    '.pyc',
    // Fonts
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.otf',
    // Audio / Video
    '.mp3',
    '.mp4',
    '.avi',
    '.mov',
    '.mkv',
    '.flac',
    '.wav',
    '.webm',
    // Databases / AI Model Weights
    '.sqlite',
    '.db',
    '.parquet',
    '.feather',
    '.onnx',
    '.pt',
    '.pth',
    '.safetensors',
    '.h5',
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
    const native = getNativeCore();
    if (native) {
      try {
        const res = native.rsResolveSafePath(this.rootDir, targetPath);
        if (!res.success && res.error) {
          throw new Error(res.error);
        }
        if (res.resolvedPath) {
          return path.resolve(res.resolvedPath);
        }
      } catch (err: any) {
        if (err.message && err.message.startsWith('Security Exception:')) {
          throw err;
        }
      }
    }

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
   * Kiểm tra xem một thư mục có nằm trong danh sách bỏ qua hay không (không phân biệt hoa thường).
   */
  isIgnoredDirectory(dirName: string): boolean {
    const base = path.basename(dirName).toLowerCase();
    return this.ignoredDirectories.some((ig) => ig.toLowerCase() === base);
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

  /**
   * Tìm kiếm các file tương đồng trong workspace khi xảy ra lỗi ENOENT / FILE_NOT_FOUND.
   * Quét đệ quy (độ sâu tối đa 3, bỏ qua ignoredDirectories) để tìm kiếm các tệp có tên tương tự hoặc cùng basename.
   */
  async findSimilarWorkspaceFiles(targetPath: string, maxResults = 5): Promise<string[]> {
    const rawTarget = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const baseName = path.basename(rawTarget).toLowerCase();
    const cleanBaseName = baseName.replace(/\.[^.]+$/, '');
    const ext = path.extname(rawTarget).toLowerCase();
    const candidates: Array<{ relPath: string; score: number }> = [];

    const scanDir = async (dir: string, depth = 0) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!this.isIgnoredDirectory(entry.name) && !entry.name.startsWith('.')) {
            await scanDir(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const entryRel = this.toRelativePath(path.join(dir, entry.name));
          const entryBase = entry.name.toLowerCase();
          const entryClean = entryBase.replace(/\.[^.]+$/, '');
          const entryExt = path.extname(entry.name).toLowerCase();

          // Khớp chính xác tên file (ví dụ: "index.html" -> "src/index.html")
          if (entryBase === baseName) {
            candidates.push({ relPath: entryRel, score: 100 });
          } else if (cleanBaseName && entryClean === cleanBaseName) {
            candidates.push({ relPath: entryRel, score: 80 });
          } else if (cleanBaseName && (entryClean.includes(cleanBaseName) || cleanBaseName.includes(entryClean))) {
            candidates.push({ relPath: entryRel, score: 50 });
          } else if (ext && entryExt === ext && depth <= 1) {
            candidates.push({ relPath: entryRel, score: 20 });
          }
        }
      }
    };

    await scanDir(this.rootDir);
    candidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    return candidates.slice(0, maxResults).map((c) => c.relPath);
  }
}
