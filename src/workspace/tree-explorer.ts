import fs from 'node:fs';
import path from 'node:path';

export interface TreeNode {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes?: number;
  fileCount?: number;
  dirCount?: number;
  extension?: string;
  children?: TreeNode[];
  depth: number;
}

export interface TreeScanResult {
  rootPath: string;
  rootNode: TreeNode;
  totalFiles: number;
  totalDirectories: number;
  totalSizeBytes: number;
  maxDepth: number;
}

export interface TreeExplorerOptions {
  maxDepth?: number;
  maxEntriesPerDir?: number;
  ignorePatterns?: string[];
  includeHidden?: boolean;
}

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.codingagent',
  '.next',
  '.gemini',
  'coverage',
  '.cache',
  '.turbo',
  'tmp',
  'temp',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * Trả về biểu tượng (icon/badge) cho từng định dạng tệp tin
 */
export function getFileExtensionBadge(extOrFilename: string): { icon: string; badge: string; colorKey: string } {
  const ext = path.extname(extOrFilename) || extOrFilename;
  const normalized = ext.toLowerCase().replace(/^\./, '');
  switch (normalized) {
    case 'ts':
    case 'mts':
    case 'cts':
      return { icon: '📘', badge: 'TS', colorKey: 'brightCyan' };
    case 'tsx':
      return { icon: '⚛️ ', badge: 'TSX', colorKey: 'brightCyan' };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { icon: '🟨', badge: 'JS', colorKey: 'brightYellow' };
    case 'jsx':
      return { icon: '⚛️ ', badge: 'JSX', colorKey: 'brightYellow' };
    case 'json':
      return { icon: '📋', badge: 'JSON', colorKey: 'geminiAmber' };
    case 'md':
    case 'markdown':
      return { icon: '📝', badge: 'MD', colorKey: 'geminiBlue' };
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return { icon: '🎨', badge: 'CSS', colorKey: 'geminiPurple' };
    case 'html':
    case 'htm':
      return { icon: '🌐', badge: 'HTML', colorKey: 'geminiAmber' };
    case 'py':
      return { icon: '🐍', badge: 'PY', colorKey: 'geminiGreen' };
    case 'go':
      return { icon: '🐹', badge: 'GO', colorKey: 'geminiCyan' };
    case 'rs':
      return { icon: '🦀', badge: 'RS', colorKey: 'geminiRed' };
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'ps1':
      return { icon: '⚡', badge: 'SH', colorKey: 'emerald' };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return { icon: '🖼️ ', badge: 'IMG', colorKey: 'geminiPurple' };
    case 'sql':
      return { icon: '🗄️ ', badge: 'SQL', colorKey: 'teal' };
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'env':
      return { icon: '⚙️ ', badge: 'CFG', colorKey: 'slate' };
    default:
      return { icon: '📄', badge: normalized.toUpperCase() || 'FILE', colorKey: 'mutedText' };
  }
}

/**
 * Quét đệ quy cây thư mục của Workspace và trả về cấu trúc phân cấp chuẩn Antigravity
 */
export async function exploreDirectoryTree(
  targetDir: string,
  options: TreeExplorerOptions = {}
): Promise<TreeScanResult> {
  const maxDepth = options.maxDepth ?? 3;
  const maxEntries = options.maxEntriesPerDir ?? 40;
  const ignores = new Set([...DEFAULT_IGNORE_PATTERNS, ...(options.ignorePatterns || [])]);

  let totalFiles = 0;
  let totalDirectories = 0;
  let totalSizeBytes = 0;

  async function scanDir(currentPath: string, relativePath: string, depth: number): Promise<TreeNode> {
    const name = path.basename(currentPath) || currentPath;
    const node: TreeNode = {
      name,
      relativePath: relativePath || '.',
      isDirectory: true,
      depth,
      children: [],
      fileCount: 0,
      dirCount: 0,
      sizeBytes: 0,
    };

    if (depth > maxDepth) {
      return node;
    }

    try {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

      // Sắp xếp thư mục lên trước, tệp tin theo sau theo thứ tự bảng chữ cái
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      let entryCount = 0;
      for (const entry of sorted) {
        if (ignores.has(entry.name)) continue;
        if (!options.includeHidden && entry.name.startsWith('.') && entry.name !== '.env.example') continue;

        const entryFullPath = path.join(currentPath, entry.name);
        const entryRelPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

        if (entry.isDirectory()) {
          totalDirectories++;
          node.dirCount = (node.dirCount || 0) + 1;
          const childDir = await scanDir(entryFullPath, entryRelPath, depth + 1);
          node.children!.push(childDir);
          node.sizeBytes = (node.sizeBytes || 0) + (childDir.sizeBytes || 0);
          node.fileCount = (node.fileCount || 0) + (childDir.fileCount || 0);
        } else if (entry.isFile()) {
          totalFiles++;
          node.fileCount = (node.fileCount || 0) + 1;
          entryCount++;

          if (entryCount <= maxEntries) {
            let sizeBytes = 0;
            try {
              const stat = await fs.promises.stat(entryFullPath);
              sizeBytes = stat.size;
            } catch {}

            totalSizeBytes += sizeBytes;
            node.sizeBytes = (node.sizeBytes || 0) + sizeBytes;

            node.children!.push({
              name: entry.name,
              relativePath: entryRelPath,
              isDirectory: false,
              depth: depth + 1,
              sizeBytes,
              extension: path.extname(entry.name),
            });
          }
        }
      }
    } catch {
      // Bỏ qua lỗi truy cập thư mục phân quyền
    }

    return node;
  }

  const rootNode = await scanDir(targetDir, '', 0);

  return {
    rootPath: targetDir,
    rootNode,
    totalFiles,
    totalDirectories,
    totalSizeBytes,
    maxDepth,
  };
}
