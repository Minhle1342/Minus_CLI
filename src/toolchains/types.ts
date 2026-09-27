/**
 * Định nghĩa kiểu dữ liệu cho hệ thống Auto Toolchain Provisioning của Minus_CLI.
 */

export interface ToolchainRecipe {
  /** Định danh duy nhất của toolchain, ví dụ: 'nodejs', 'uv', 'go', 'ripgrep' */
  id: string;
  /** Tên hiển thị người dùng, ví dụ: 'Node.js LTS' */
  displayName: string;
  /** Danh sách tên lệnh thực thi đại diện, ví dụ: ['node', 'npm', 'npx'] */
  binaries: string[];
  /** Trang chủ hoặc tài liệu chính thức */
  homepage: string;
  /** Đường dẫn tải về theo nền tảng hệ điều hành */
  downloadUrls: {
    win32?: string;
    linux?: string;
    darwin?: string;
  };
  /** Tên thư mục cài đặt con bên dưới thư mục Programs (ví dụ: 'nodejs', 'uv', 'go') */
  targetDirName: string;
  /** Thư mục con chứa binary bên trong thư mục giải nén (nếu có, ví dụ 'bin') */
  binSubDir?: string;
  /** Các thư mục con bổ sung cần được đưa vào PATH (ví dụ 'Scripts' cho Python trên Windows) */
  additionalBinSubDirs?: string[];
  /** Tên tệp binary chính để kiểm tra tính hợp lệ sau khi giải nén */
  verifyBinary: string;
  /** Tham số chạy thử để kiểm tra phiên bản (mặc định: ['--version']) */
  verifyArgs?: string[];
  /** Hook tùy chọn chạy sau khi giải nén thành công (ví dụ tạo shim/alias) */
  postInstall?: (targetDir: string, binDir: string) => Promise<void> | void;
}

export interface ProvisionResult {
  success: boolean;
  toolchain: string;
  binary: string;
  binPath?: string;
  binDir?: string;
  alreadyExisted?: boolean;
  version?: string;
  durationMs: number;
  error?: string;
  userPathUpdated?: boolean;
}

export interface ProvisionOptions {
  force?: boolean;
  updateUserPath?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
