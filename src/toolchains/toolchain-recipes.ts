import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolchainRecipe } from './types.js';

export const TOOLCHAIN_RECIPES: Record<string, ToolchainRecipe> = {
  nodejs: {
    id: 'nodejs',
    displayName: 'Node.js LTS (v22.14.0)',
    binaries: ['node', 'npm', 'npx'],
    homepage: 'https://nodejs.org',
    downloadUrls: {
      win32: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip',
      linux: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz',
      darwin: 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-x64.tar.gz',
    },
    targetDirName: 'nodejs',
    verifyBinary: process.platform === 'win32' ? 'node.exe' : 'node',
    verifyArgs: ['-v'],
  },
  uv: {
    id: 'uv',
    displayName: 'Astral uv (Fast Python Package & Toolchain Manager)',
    binaries: ['uv', 'uvx'],
    homepage: 'https://github.com/astral-sh/uv',
    downloadUrls: {
      win32: 'https://github.com/astral-sh/uv/releases/download/0.6.5/uv-x86_64-pc-windows-msvc.zip',
      linux: 'https://github.com/astral-sh/uv/releases/download/0.6.5/uv-x86_64-unknown-linux-gnu.tar.gz',
      darwin: 'https://github.com/astral-sh/uv/releases/download/0.6.5/uv-aarch64-apple-darwin.tar.gz',
    },
    targetDirName: 'uv',
    verifyBinary: process.platform === 'win32' ? 'uv.exe' : 'uv',
    verifyArgs: ['--version'],
  },
  python: {
    id: 'python',
    displayName: 'Python Standalone CPython Environment (v3.12.14)',
    binaries: ['python', 'python3', 'pip', 'pip3', 'py'],
    homepage: 'https://www.python.org',
    downloadUrls: {
      win32: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.12.14+20260924-x86_64-pc-windows-msvc-install_only.tar.gz',
      linux: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.12.14+20260924-x86_64-unknown-linux-gnu-install_only.tar.gz',
      darwin: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.12.14+20260924-aarch64-apple-darwin-install_only.tar.gz',
    },
    targetDirName: 'python',
    binSubDir: process.platform === 'win32' ? undefined : 'bin',
    additionalBinSubDirs: process.platform === 'win32' ? ['Scripts'] : [],
    verifyBinary: process.platform === 'win32' ? 'python.exe' : 'python3',
    verifyArgs: ['--version'],
    postInstall: async (_targetDir, binDir) => {
      if (process.platform === 'win32') {
        const python3Cmd = path.join(binDir, 'python3.cmd');
        if (!fs.existsSync(python3Cmd)) {
          await fsp.writeFile(python3Cmd, '@"%~dp0\\python.exe" %*\r\n', 'utf-8');
        }
        const pyCmd = path.join(binDir, 'py.cmd');
        if (!fs.existsSync(pyCmd)) {
          await fsp.writeFile(pyCmd, '@"%~dp0\\python.exe" %*\r\n', 'utf-8');
        }
      }
    },
  },
  bun: {
    id: 'bun',
    displayName: 'Bun All-in-One JavaScript & TypeScript Runtime (v1.2.4)',
    binaries: ['bun', 'bunx'],
    homepage: 'https://bun.sh',
    downloadUrls: {
      win32: 'https://github.com/oven-sh/bun/releases/download/bun-v1.2.4/bun-windows-x64.zip',
      linux: 'https://github.com/oven-sh/bun/releases/download/bun-v1.2.4/bun-linux-x64.zip',
      darwin: 'https://github.com/oven-sh/bun/releases/download/bun-v1.2.4/bun-darwin-aarch64.zip',
    },
    targetDirName: 'bun',
    verifyBinary: process.platform === 'win32' ? 'bun.exe' : 'bun',
    verifyArgs: ['--version'],
    postInstall: async (_targetDir, binDir) => {
      if (process.platform === 'win32') {
        const bunxCmd = path.join(binDir, 'bunx.cmd');
        if (!fs.existsSync(bunxCmd)) {
          await fsp.writeFile(bunxCmd, '@"%~dp0\\bun.exe" x %*\r\n', 'utf-8');
        }
      } else {
        const bunxLink = path.join(binDir, 'bunx');
        if (!fs.existsSync(bunxLink)) {
          try {
            await fsp.symlink(path.join(binDir, 'bun'), bunxLink);
          } catch {}
        }
      }
    },
  },
  deno: {
    id: 'deno',
    displayName: 'Deno Modern TypeScript & JavaScript Runtime (v2.2.3)',
    binaries: ['deno'],
    homepage: 'https://deno.com',
    downloadUrls: {
      win32: 'https://github.com/denoland/deno/releases/download/v2.2.3/deno-x86_64-pc-windows-msvc.zip',
      linux: 'https://github.com/denoland/deno/releases/download/v2.2.3/deno-x86_64-unknown-linux-gnu.zip',
      darwin: 'https://github.com/denoland/deno/releases/download/v2.2.3/deno-aarch64-apple-darwin.zip',
    },
    targetDirName: 'deno',
    verifyBinary: process.platform === 'win32' ? 'deno.exe' : 'deno',
    verifyArgs: ['--version'],
  },
  go: {
    id: 'go',
    displayName: 'Go Toolchain (v1.24.1)',
    binaries: ['go', 'gofmt'],
    homepage: 'https://go.dev',
    downloadUrls: {
      win32: 'https://go.dev/dl/go1.24.1.windows-amd64.zip',
      linux: 'https://go.dev/dl/go1.24.1.linux-amd64.tar.gz',
      darwin: 'https://go.dev/dl/go1.24.1.darwin-amd64.tar.gz',
    },
    targetDirName: 'go',
    binSubDir: 'bin',
    verifyBinary: process.platform === 'win32' ? 'go.exe' : 'go',
    verifyArgs: ['version'],
  },
  java: {
    id: 'java',
    displayName: 'Eclipse Temurin OpenJDK (v21 LTS)',
    binaries: ['java', 'javac', 'jar', 'javap', 'jshell'],
    homepage: 'https://adoptium.net',
    downloadUrls: {
      win32: 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse',
      linux: 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse',
      darwin: 'https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse',
    },
    targetDirName: 'java',
    binSubDir: 'bin',
    verifyBinary: process.platform === 'win32' ? 'java.exe' : 'java',
    verifyArgs: ['-version'],
  },
  zig: {
    id: 'zig',
    displayName: 'Zig Toolchain & C/C++ Compiler (v0.14.0)',
    binaries: ['zig'],
    homepage: 'https://ziglang.org',
    downloadUrls: {
      win32: 'https://ziglang.org/download/0.14.0/zig-windows-x86_64-0.14.0.zip',
      linux: 'https://ziglang.org/download/0.14.0/zig-linux-x86_64-0.14.0.tar.xz',
      darwin: 'https://ziglang.org/download/0.14.0/zig-macos-aarch64-0.14.0.tar.xz',
    },
    targetDirName: 'zig',
    verifyBinary: process.platform === 'win32' ? 'zig.exe' : 'zig',
    verifyArgs: ['version'],
  },
  cmake: {
    id: 'cmake',
    displayName: 'CMake Build System (v3.31.5)',
    binaries: ['cmake', 'ctest', 'cpack'],
    homepage: 'https://cmake.org',
    downloadUrls: {
      win32: 'https://github.com/Kitware/CMake/releases/download/v3.31.5/cmake-3.31.5-windows-x86_64.zip',
      linux: 'https://github.com/Kitware/CMake/releases/download/v3.31.5/cmake-3.31.5-linux-x86_64.tar.gz',
      darwin: 'https://github.com/Kitware/CMake/releases/download/v3.31.5/cmake-3.31.5-macos-universal.tar.gz',
    },
    targetDirName: 'cmake',
    binSubDir: 'bin',
    verifyBinary: process.platform === 'win32' ? 'cmake.exe' : 'cmake',
    verifyArgs: ['--version'],
  },
  ninja: {
    id: 'ninja',
    displayName: 'Ninja Fast Build Tool (v1.12.1)',
    binaries: ['ninja'],
    homepage: 'https://ninja-build.org',
    downloadUrls: {
      win32: 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip',
      linux: 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-linux.zip',
      darwin: 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-mac.zip',
    },
    targetDirName: 'ninja',
    verifyBinary: process.platform === 'win32' ? 'ninja.exe' : 'ninja',
    verifyArgs: ['--version'],
  },
  php: {
    id: 'php',
    displayName: 'PHP Portable Binary (v8.4.26)',
    binaries: ['php'],
    homepage: 'https://www.php.net',
    downloadUrls: {
      win32: 'https://windows.php.net/downloads/releases/php-8.4.26-Win32-vs17-x64.zip',
    },
    targetDirName: 'php',
    verifyBinary: process.platform === 'win32' ? 'php.exe' : 'php',
    verifyArgs: ['-v'],
  },
  ripgrep: {
    id: 'ripgrep',
    displayName: 'Ripgrep Fast Search Binary (v14.1.1)',
    binaries: ['rg', 'ripgrep'],
    homepage: 'https://github.com/BurntSushi/ripgrep',
    downloadUrls: {
      win32: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip',
      linux: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz',
      darwin: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz',
    },
    targetDirName: 'ripgrep',
    verifyBinary: process.platform === 'win32' ? 'rg.exe' : 'rg',
    verifyArgs: ['--version'],
  },
  mingit: {
    id: 'mingit',
    displayName: 'MinGit Portable (v2.48.1)',
    binaries: ['git'],
    homepage: 'https://github.com/git-for-windows/git',
    downloadUrls: {
      win32: 'https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/MinGit-2.48.1-64-bit.zip',
    },
    targetDirName: 'mingit',
    binSubDir: 'cmd',
    verifyBinary: process.platform === 'win32' ? 'git.exe' : 'git',
    verifyArgs: ['--version'],
  },
};

/**
 * Tìm kiếm công thức Toolchain tương ứng với tên file thực thi.
 * Hỗ trợ các đuôi .exe, .cmd, .bat trên Windows.
 */
export function findRecipeForBinary(binaryName: string): ToolchainRecipe | undefined {
  if (!binaryName) return undefined;
  const normalized = binaryName.trim().toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
  
  for (const recipe of Object.values(TOOLCHAIN_RECIPES)) {
    if (recipe.binaries.some((b) => b.toLowerCase() === normalized)) {
      return recipe;
    }
  }
  return undefined;
}

/**
 * Danh sách tất cả các binary có thể tự động tải và cài đặt
 */
export function getAllSupportedBinaries(): string[] {
  const result: string[] = [];
  for (const recipe of Object.values(TOOLCHAIN_RECIPES)) {
    result.push(...recipe.binaries);
  }
  return result;
}
