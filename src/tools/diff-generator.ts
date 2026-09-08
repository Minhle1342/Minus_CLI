import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Danh sách các công cụ sửa đổi/thao tác file cốt lõi đã được đăng ký trong ToolRegistry.
 */
export const FILE_MUTATION_TOOLS = new Set([
  'replace_text',
  'write_file',
  'apply_patch',
  'create_file',
  'delete_file',
  'move_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

/**
 * Kiểm tra xem một tool có phải là tool sửa file/thay đổi trạng thái file hay không.
 */
export function isMutationTool(toolName: string): boolean {
  return FILE_MUTATION_TOOLS.has(toolName);
}

/**
 * Thuật toán tính toán Line Diff nhanh, hiệu năng cao giữa nội dung cũ và mới.
 * Sử dụng kỹ thuật common prefix/suffix matching và đóng gói thành Unified Diff chunk.
 */
export function computeLineDiff(oldText: string, newText: string, filePath: string): string {
  const normOld = (oldText || '').replace(/\r\n/g, '\n');
  const normNew = (newText || '').replace(/\r\n/g, '\n');

  if (normOld === normNew) {
    return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,1 @@\n (không có thay đổi nội dung)`;
  }

  const oldLines = normOld.split('\n');
  const newLines = normNew.split('\n');

  // 1. Tìm prefix chung
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  // 2. Tìm suffix chung
  let suffixLen = 0;
  while (
    suffixLen < (oldLines.length - prefixLen) &&
    suffixLen < (newLines.length - prefixLen) &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const removedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);

  // Lấy tối đa 2 dòng ngữ cảnh trước và sau nếu có
  const contextBefore = oldLines.slice(Math.max(0, prefixLen - 2), prefixLen);
  const contextAfter = oldLines.slice(
    oldLines.length - suffixLen,
    Math.min(oldLines.length, oldLines.length - suffixLen + 2)
  );

  const oldStart = Math.max(1, prefixLen - contextBefore.length + 1);
  const oldCount = contextBefore.length + removedLines.length + contextAfter.length;

  const newStart = Math.max(1, prefixLen - contextBefore.length + 1);
  const newCount = contextBefore.length + addedLines.length + contextAfter.length;

  const hunkLines: string[] = [];
  hunkLines.push(`--- a/${filePath}`);
  hunkLines.push(`+++ b/${filePath}`);
  hunkLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

  for (const line of contextBefore) {
    hunkLines.push(` ${line}`);
  }
  for (const line of removedLines) {
    hunkLines.push(`-${line}`);
  }
  for (const line of addedLines) {
    hunkLines.push(`+${line}`);
  }
  for (const line of contextAfter) {
    hunkLines.push(` ${line}`);
  }

  return hunkLines.join('\n');
}

/**
 * Sinh Unified Git Diff xem trước từ tham số của các Tool sửa file.
 */
export async function generateFileToolDiff(
  toolName: string,
  args: Record<string, any>,
  workspaceRoot?: string
): Promise<string | undefined> {
  if (!isMutationTool(toolName)) {
    return undefined;
  }

  const resolvePath = (relPath: string): string => {
    if (!relPath) return '';
    if (workspaceRoot && !path.isAbsolute(relPath)) {
      return path.resolve(workspaceRoot, relPath);
    }
    return path.resolve(relPath);
  };

  // 1. apply_patch
  if (toolName === 'apply_patch') {
    const rawPatch = String(args.patch || '').trim();
    if (!rawPatch) return undefined;
    // Bỏ markdown code block nếu có
    const cleanedPatch = rawPatch
      .replace(/^```(?:diff|patch)?\r?\n/i, '')
      .replace(/\r?\n```$/i, '')
      .trim();
    return cleanedPatch;
  }

  // 2. replace_text
  if (toolName === 'replace_text') {
    const target = String(args.path || args.filePath || args.targetFile || '').trim();
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');

    if (!target) return undefined;

    let existingContent: string | null = null;
    try {
      const fullPath = resolvePath(target);
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      // Tìm vị trí của oldText trong file
      const normExisting = existingContent.replace(/\r\n/g, '\n');
      const normOld = oldText.replace(/\r\n/g, '\n');
      const normNew = newText.replace(/\r\n/g, '\n');

      if (normExisting.includes(normOld)) {
        const updated = normExisting.replace(normOld, normNew);
        return computeLineDiff(normExisting, updated, target);
      }
    }

    // Fallback nếu không đọc được file hoặc oldText không khớp chính xác nội dung trên đĩa
    const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
    const newLines = newText.replace(/\r\n/g, '\n').split('\n');
    const hunk: string[] = [
      `--- a/${target}`,
      `+++ b/${target}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map(l => `-${l}`),
      ...newLines.map(l => `+${l}`),
    ];
    return hunk.join('\n');
  }

  // 3. write_file
  if (toolName === 'write_file') {
    const target = String(args.path || args.filePath || args.targetFile || '').trim();
    const newContent = String(args.content ?? '');

    if (!target) return undefined;

    let existingContent: string | null = null;
    try {
      const fullPath = resolvePath(target);
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      return computeLineDiff(existingContent, newContent, target);
    }

    // File mới chưa tồn tại trên đĩa
    const lines = newContent.replace(/\r\n/g, '\n').split('\n');
    const hunk: string[] = [
      '--- /dev/null',
      `+++ b/${target}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(l => `+${l}`),
    ];
    return hunk.join('\n');
  }

  // 4. create_file
  if (toolName === 'create_file') {
    const target = String(args.path || args.filePath || args.targetFile || '').trim();
    const content = String(args.content ?? '');
    if (!target) return undefined;

    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const hunk: string[] = [
      '--- /dev/null',
      `+++ b/${target}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(l => `+${l}`),
    ];
    return hunk.join('\n');
  }

  // 5. delete_file
  if (toolName === 'delete_file') {
    const target = String(args.path || args.filePath || args.targetFile || '').trim();
    if (!target) return undefined;

    let existingContent: string | null = null;
    try {
      const fullPath = resolvePath(target);
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      const lines = existingContent.replace(/\r\n/g, '\n').split('\n');
      const hunk: string[] = [
        `--- a/${target}`,
        '+++ /dev/null',
        `@@ -1,${lines.length} +0,0 @@`,
        ...lines.map(l => `-${l}`),
      ];
      return hunk.join('\n');
    }

    return [
      `--- a/${target}`,
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-(toàn bộ nội dung file sẽ bị xóa)',
    ].join('\n');
  }

  // 6. move_file
  if (toolName === 'move_file') {
    const sourcePath = String(args.sourcePath || args.from || '').trim();
    const targetPath = String(args.targetPath || args.to || '').trim();
    if (!sourcePath || !targetPath) return undefined;

    return [
      `similarity index 100%`,
      `rename from ${sourcePath}`,
      `rename to ${targetPath}`,
    ].join('\n');
  }

  // 7. write_to_file
  if (toolName === 'write_to_file') {
    const target = String(args.TargetFile || args.targetFile || args.path || args.filePath || '').trim();
    const newContent = String(args.CodeContent ?? args.codeContent ?? args.content ?? '');

    if (!target) return undefined;

    let existingContent: string | null = null;
    try {
      const fullPath = resolvePath(target);
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      return computeLineDiff(existingContent, newContent, target);
    }

    const lines = newContent.replace(/\r\n/g, '\n').split('\n');
    const hunk: string[] = [
      '--- /dev/null',
      `+++ b/${target}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(l => `+${l}`),
    ];
    return hunk.join('\n');
  }

  // 8. replace_file_content
  if (toolName === 'replace_file_content') {
    const target = String(args.TargetFile || args.targetFile || args.path || args.filePath || '').trim();
    const targetContent = String(args.TargetContent ?? args.targetContent ?? '');
    const replacementContent = String(args.ReplacementContent ?? args.replacementContent ?? '');

    if (!target) return undefined;

    let existingContent: string | null = null;
    try {
      const fullPath = resolvePath(target);
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      const normExisting = existingContent.replace(/\r\n/g, '\n');
      const normTarget = targetContent.replace(/\r\n/g, '\n');
      const normReplacement = replacementContent.replace(/\r\n/g, '\n');

      if (normExisting.includes(normTarget)) {
        const updated = normExisting.replace(normTarget, normReplacement);
        return computeLineDiff(normExisting, updated, target);
      }
    }

    const oldLines = targetContent.replace(/\r\n/g, '\n').split('\n');
    const newLines = replacementContent.replace(/\r\n/g, '\n').split('\n');
    const hunk: string[] = [
      `--- a/${target}`,
      `+++ b/${target}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map(l => `-${l}`),
      ...newLines.map(l => `+${l}`),
    ];
    return hunk.join('\n');
  }

  // 9. multi_replace_file_content
  if (toolName === 'multi_replace_file_content') {
    const target = String(args.TargetFile || args.targetFile || args.path || args.filePath || '').trim();
    const chunks = Array.isArray(args.ReplacementChunks)
      ? args.ReplacementChunks
      : (Array.isArray(args.replacementChunks) ? args.replacementChunks : []);

    if (!target || chunks.length === 0) return undefined;

    let existingContent: string | null = null;
    try {
      const fullPath = resolvePath(target);
      existingContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null) {
      let current = existingContent.replace(/\r\n/g, '\n');
      for (const chunk of chunks) {
        const tc = String(chunk.TargetContent ?? chunk.targetContent ?? '').replace(/\r\n/g, '\n');
        const rc = String(chunk.ReplacementContent ?? chunk.replacementContent ?? '').replace(/\r\n/g, '\n');
        if (tc && current.includes(tc)) {
          current = current.replace(tc, rc);
        }
      }
      return computeLineDiff(existingContent, current, target);
    }

    return undefined;
  }

  return undefined;
}
