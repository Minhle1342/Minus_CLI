import fs from 'node:fs';
import path from 'node:path';
import type { FileViewModel } from '../types.js';
import { color, fit, tokyoNight } from '../styles/theme.js';
import { highlightCode } from './viewport-model.js';
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILE_LINES = 5000;
export function createFileView(): FileViewModel {
  return { visible: false, path: '', text: '', offset: 0, truncated: false };
}
let cachedText = '';
let cachedLines: string[] = [];
function linesOf(text: string): string[] {
  if (text !== cachedText) { cachedText = text; cachedLines = text ? text.split('\n') : []; }
  return cachedLines;
}
export function fileLineCount(model: FileViewModel): number { return linesOf(model.text).length; }
export function fileView(model: FileViewModel, width: number, height: number): string[] {
  if (height <= 0) return [];
  const lines = linesOf(model.text);
  const bodyHeight = height - 1;
  const offset = Math.max(0, Math.min(model.offset, Math.max(0, lines.length - bodyHeight)));
  const gutter = String(lines.length).length;
  const header = color(36, `File · ${model.path}${model.truncated ? ' (truncated)' : ''} · ${lines.length} lines · ↑↓ scroll · Esc close`);
  const rows = Array.from({ length: bodyHeight }, (_, i) => {
    const line = lines[offset + i];
    if (line === undefined) return '';
    return color(tokyoNight.muted, String(offset + i + 1).padStart(gutter) + '│') + highlightCode(line);
  });
  return [fit(header, width), ...rows.map(row => fit(row, width))];
}
/** Read a workspace file for the overlay; refuses paths outside root and caps size/lines. */
export function loadFileView(rootDir: string, relPath: string): { path: string; text: string; truncated: boolean } {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relPath);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path outside workspace: ${relPath}`);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
  const fd = fs.openSync(target, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    let text = buf.subarray(0, read).toString('utf8');
    if (text.includes('\0')) throw new Error(`Binary file: ${relPath}`);
    const lines = text.split('\n');
    const truncated = stat.size > read || lines.length > MAX_FILE_LINES;
    if (lines.length > MAX_FILE_LINES) text = lines.slice(0, MAX_FILE_LINES).join('\n');
    return { path: rel.replace(/\\/g, '/'), text, truncated };
  } finally { fs.closeSync(fd); }
}
