import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ToolchainRecipe, ProvisionResult, ProvisionOptions } from './types.js';
import { findRecipeForBinary, TOOLCHAIN_RECIPES } from './toolchain-recipes.js';
import { nativeExtractArchive } from '../native/index.js';

const execFileAsync = promisify(execFile);

/** Native archive path on unless explicitly disabled; TS fallback otherwise. */
function isNativeArchiveEnabled(): boolean {
  const flag = String(process.env.MINUS_NATIVE_ARCHIVE || '').toLowerCase();
  return flag !== '0' && flag !== 'off' && flag !== 'false' && flag !== 'no';
}

/**
 * ToolchainProvisioner: Tự động tải, giải nén, và cấu hình các công nghệ lập trình (toolchains/runtimes)
 * trong không gian người dùng (User space), không đòi hỏi quyền Admin/UAC.
 */
export class ToolchainProvisioner {
  /**
   * Thư mục gốc chứa các toolchain được quản lý
   */
  static getInstallRoot(): string {
    if (process.env.MINUS_TOOLCHAINS_DIR) {
      return path.resolve(process.env.MINUS_TOOLCHAINS_DIR);
    }
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'Programs');
    }
    return path.join(os.homedir(), '.minus', 'toolchains');
  }

  /**
   * Tìm đường dẫn thư mục bin của một recipe đã cài đặt (nếu tồn tại)
   */
  static getInstalledBinDir(recipe: ToolchainRecipe): string {
    const installRoot = this.getInstallRoot();
    const targetDir = path.join(installRoot, recipe.targetDirName);
    return recipe.binSubDir ? path.join(targetDir, recipe.binSubDir) : targetDir;
  }

  /**
   * Lấy danh sách tất cả các thư mục binary cần đưa vào PATH (bao gồm main bin và additional subdirs)
   */
  static getInstalledBinDirs(recipe: ToolchainRecipe): string[] {
    const mainBinDir = this.getInstalledBinDir(recipe);
    const result = [mainBinDir];
    if (recipe.additionalBinSubDirs && recipe.additionalBinSubDirs.length > 0) {
      const targetDir = path.join(this.getInstallRoot(), recipe.targetDirName);
      for (const sub of recipe.additionalBinSubDirs) {
        result.push(path.join(targetDir, sub));
      }
    }
    return result;
  }

  /**
   * Kiểm tra xem binary của recipe đã có sẵn trên đĩa và có thể thực thi được hay không
   */
  static async isRecipeInstalled(recipe: ToolchainRecipe): Promise<string | undefined> {
    const binDir = this.getInstalledBinDir(recipe);
    const exePath = path.join(binDir, recipe.verifyBinary);

    try {
      await fsp.access(exePath, fs.constants.X_OK | fs.constants.R_OK);
      return exePath;
    } catch {
      // Trên Windows, fs.constants.X_OK có thể không bắt buộc, kiểm tra F_OK
      try {
        await fsp.access(exePath, fs.constants.F_OK);
        return exePath;
      } catch {
        return undefined;
      }
    }
  }

  /**
   * Cập nhật process.env.PATH tức thì trong bộ nhớ để lệnh hiện tại có thể gọi được ngay
   */
  static updateProcessEnvPath(binDir: string): void {
    const currentPath = process.env.PATH || '';
    const delimiter = path.delimiter;
    const paths = currentPath.split(delimiter).map((p) => path.normalize(p.trim())).filter(Boolean);
    const normalizedTarget = path.normalize(binDir.trim());

    if (!paths.includes(normalizedTarget)) {
      process.env.PATH = `${normalizedTarget}${delimiter}${currentPath}`;
    }
  }

  /**
   * Cập nhật biến môi trường User PATH vĩnh viễn trên Windows
   */
  static async updateUserEnvPath(binDir: string): Promise<boolean> {
    if (process.platform !== 'win32') return false;

    try {
      const psScript = `
        $target = "${binDir.replace(/\\/g, '\\\\')}";
        $current = [Environment]::GetEnvironmentVariable("Path", "User");
        if ($current -notlike "*$target*") {
          $newPath = "$target;" + $current;
          [Environment]::SetEnvironmentVariable("Path", $newPath, "User");
        }
      `;
      await execFileAsync('powershell', ['-NoProfile', '-Command', psScript]);
      return true;
    } catch (err: any) {
      console.warn(`[ToolchainProvisioner] Không thể cập nhật User PATH: ${err.message}`);
      return false;
    }
  }

  /**
   * Tải tệp tin qua HTTPS stream
   */
  private static async downloadFile(url: string, destPath: string, options?: ProvisionOptions): Promise<void> {
    options?.onProgress?.(`Đang tải từ ${url}...`);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: options?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Tải tệp tin thất bại HTTP ${res.status}: ${res.statusText} (${url})`);
    }

    const parentDir = path.dirname(destPath);
    await fsp.mkdir(parentDir, { recursive: true });

    const fileStream = fs.createWriteStream(destPath);
    const bodyStream = Readable.fromWeb(res.body as any);
    await pipeline(bodyStream, fileStream);
  }

  /**
   * Giải nén archive vào thư mục đích
   */
  private static async extractArchive(archivePath: string, targetDir: string, options?: ProvisionOptions): Promise<void> {
    options?.onProgress?.(`Đang giải nén vào ${targetDir}...`);
    const tempExtract = path.join(os.tmpdir(), `minus_extract_${Date.now()}`);
    await fsp.mkdir(tempExtract, { recursive: true });

    try {
      // Fast path: single-pass native extract (no temp copy, no tar/unzip spawn).
      if (isNativeArchiveEnabled()) {
        const nativeRes = nativeExtractArchive(archivePath, tempExtract, true);
        if (nativeRes && nativeRes.filesExtracted > 0) {
          options?.onProgress?.(`Đã giải nén ${nativeRes.filesExtracted} file bằng Rust native.`);
        } else if (nativeRes) {
          throw new Error(`Native extract wrote 0 files from ${archivePath}.`);
        } else {
          await this.extractArchiveShell(archivePath, tempExtract);
        }
      } else {
        await this.extractArchiveShell(archivePath, tempExtract);
      }
      // Kiểm tra nếu giải nén ra 1 thư mục lồng duy nhất (ví dụ node-v22.14.0-win-x64/...)
      const entries = await fsp.readdir(tempExtract, { withFileTypes: true });
      let sourceDir = tempExtract;
      if (entries.length === 1 && entries[0].isDirectory()) {
        sourceDir = path.join(tempExtract, entries[0].name);
      }

      await fsp.mkdir(targetDir, { recursive: true });
      await this.copyDirectory(sourceDir, targetDir);
    } finally {
      await fsp.rm(tempExtract, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Fallback TS: giải nén bằng tiến trình ngoài (tar.exe / Expand-Archive / tar / unzip).
   * Dùng khi native vắng mặt, bị tắt qua MINUS_NATIVE_ARCHIVE=0, hoặc native lỗi.
   */
  private static async extractArchiveShell(archivePath: string, tempExtract: string): Promise<void> {
    if (process.platform === 'win32') {
      let extractedWithTar = false;
      const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      if (fs.existsSync(tarExe)) {
        try {
          await execFileAsync(tarExe, ['-xf', archivePath, '-C', tempExtract]);
          extractedWithTar = true;
        } catch {
          extractedWithTar = false;
        }
      }

      if (!extractedWithTar) {
        // Fallback sang PowerShell Expand-Archive
        const psCommand = `Expand-Archive -Path "${archivePath.replace(/"/g, '`"')}" -DestinationPath "${tempExtract.replace(/"/g, '`"')}" -Force`;
        await execFileAsync('powershell', ['-NoProfile', '-Command', psCommand]);
      }
    } else {
      // Linux / macOS
      if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
        await execFileAsync('tar', ['-xzf', archivePath, '-C', tempExtract]);
      } else if (archivePath.endsWith('.zip')) {
        await execFileAsync('unzip', ['-q', archivePath, '-d', tempExtract]);
      }
    }
  }

  /**
   * Sao chép toàn bộ thư mục đệ quy
   */
  private static async copyDirectory(src: string, dest: string): Promise<void> {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fsp.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Chạy xác minh binary sau khi cài đặt
   */
  private static async verifyInstallation(exePath: string, args: string[] = ['--version']): Promise<string> {
    const { stdout, stderr } = await execFileAsync(exePath, args, { timeout: 10000 });
    return (stdout || stderr || '').trim();
  }

  /**
   * Thực hiện tải và cài đặt một Toolchain theo Recipe
   */
  static async provision(recipeOrBinary: string | ToolchainRecipe, options?: ProvisionOptions): Promise<ProvisionResult> {
    const startTime = Date.now();
    const recipe: ToolchainRecipe | undefined = typeof recipeOrBinary === 'string'
      ? (TOOLCHAIN_RECIPES[recipeOrBinary] || findRecipeForBinary(recipeOrBinary))
      : recipeOrBinary;

    if (!recipe) {
      return {
        success: false,
        toolchain: typeof recipeOrBinary === 'string' ? recipeOrBinary : 'unknown',
        binary: typeof recipeOrBinary === 'string' ? recipeOrBinary : 'unknown',
        durationMs: Date.now() - startTime,
        error: `Không tìm thấy công thức cài đặt cho "${typeof recipeOrBinary === 'string' ? recipeOrBinary : 'unknown'}".`,
      };
    }

    const binDir = this.getInstalledBinDir(recipe);
    const targetDir = path.join(this.getInstallRoot(), recipe.targetDirName);
    const exePath = path.join(binDir, recipe.verifyBinary);

    // 1. Kiểm tra nếu đã được cài đặt từ trước (trừ khi có cờ force)
    if (!options?.force) {
      const existingExe = await this.isRecipeInstalled(recipe);
      if (existingExe) {
        for (const dir of this.getInstalledBinDirs(recipe)) {
          this.updateProcessEnvPath(dir);
        }
        let version: string | undefined;
        try {
          version = await this.verifyInstallation(existingExe, recipe.verifyArgs);
        } catch {}

        return {
          success: true,
          toolchain: recipe.id,
          binary: recipe.verifyBinary,
          binPath: existingExe,
          binDir,
          alreadyExisted: true,
          version,
          durationMs: Date.now() - startTime,
          userPathUpdated: false,
        };
      }
    }

    // 2. Xác định URL tải về theo hệ điều hành
    const platform = process.platform as 'win32' | 'linux' | 'darwin';
    const downloadUrl = recipe.downloadUrls[platform];
    if (!downloadUrl) {
      return {
        success: false,
        toolchain: recipe.id,
        binary: recipe.verifyBinary,
        durationMs: Date.now() - startTime,
        error: `Toolchain "${recipe.displayName}" chưa hỗ trợ nền tảng "${platform}".`,
      };
    }

    const archiveExt = downloadUrl.endsWith('.tar.gz') ? '.tar.gz' : path.extname(downloadUrl) || '.zip';
    const tempArchive = path.join(os.tmpdir(), `minus_dl_${recipe.id}_${Date.now()}${archiveExt}`);

    try {
      // 3. Tải archive
      await this.downloadFile(downloadUrl, tempArchive, options);

      // 4. Giải nén vào thư mục cài đặt
      await this.extractArchive(tempArchive, targetDir, options);

      // 4b. Thực thi postInstall hook nếu được định nghĩa
      if (recipe.postInstall) {
        try {
          await recipe.postInstall(targetDir, binDir);
        } catch (err: any) {
          console.warn(`[ToolchainProvisioner] Cảnh báo postInstall "${recipe.id}": ${err.message}`);
        }
      }

      // 5. Cập nhật process.env.PATH tức thì
      const allBinDirs = this.getInstalledBinDirs(recipe);
      for (const dir of allBinDirs) {
        this.updateProcessEnvPath(dir);
      }

      // 6. Cập nhật User PATH trên Windows (mặc định bật)
      let userPathUpdated = false;
      if (options?.updateUserPath !== false && process.platform === 'win32') {
        for (const dir of allBinDirs) {
          const ok = await this.updateUserEnvPath(dir);
          if (ok) userPathUpdated = true;
        }
      }

      // 7. Xác minh cài đặt
      let version: string | undefined;
      try {
        version = await this.verifyInstallation(exePath, recipe.verifyArgs);
      } catch (err: any) {
        console.warn(`[ToolchainProvisioner] Cảnh báo xác minh "${recipe.id}": ${err.message}`);
      }

      options?.onProgress?.(`Đã cấu hình thành công ${recipe.displayName} (${version || 'ready'}).`);

      return {
        success: true,
        toolchain: recipe.id,
        binary: recipe.verifyBinary,
        binPath: exePath,
        binDir,
        alreadyExisted: false,
        version,
        durationMs: Date.now() - startTime,
        userPathUpdated,
      };
    } catch (err: any) {
      return {
        success: false,
        toolchain: recipe.id,
        binary: recipe.verifyBinary,
        durationMs: Date.now() - startTime,
        error: `Lỗi trong quá trình cài đặt ${recipe.displayName}: ${err.message}`,
      };
    } finally {
      await fsp.rm(tempArchive, { force: true }).catch(() => {});
    }
  }

  /**
   * Phương thức tiện ích: Đảm bảo một binary có sẵn trên hệ thống.
   * Nếu có recipe và chưa cài, tự động tải và kích hoạt vào PATH.
   */
  static async ensureToolchain(binaryName: string, options?: ProvisionOptions): Promise<ProvisionResult | null> {
    const recipe = findRecipeForBinary(binaryName);
    if (!recipe) return null;

    return this.provision(recipe, options);
  }
}
