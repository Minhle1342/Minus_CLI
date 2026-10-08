import type { RootModel, Msg, Cmd } from '../types.js';
import { composerDisplay, updateComposer } from './composer-model.js';
import { viewportLines } from './viewport-model.js';
import { displayWidth, stripTerminalControls, wrap } from '../styles/theme.js';

export interface SelectionLayout { composerHeight: number; composerTop: number; bodyHeight: number; mainWidth: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function columnOffset(text: string, column: number): number {
  let cells = 0;
  for (const item of graphemes.segment(text)) {
    const next = cells + displayWidth(item.segment);
    if (next > column) return item.index;
    cells = next;
  }
  return text.length;
}
function lineOffset(lines: string[], row: number, column: number): number {
  const at = Math.max(0, Math.min(lines.length - 1, row));
  return lines.slice(0, at).reduce((sum, line) => sum + line.length + 1, 0) + columnOffset(lines[at] || '', Math.max(0, column));
}
function inputOffset(model: RootModel, layout: SelectionLayout, x: number, y: number): number {
  const display = composerDisplay({ ...model.composer, cursorOffset: model.selection?.composerCursor ?? model.composer.cursorOffset });
  const text = '› ' + display.value;
  const lines = wrap(text, model.width);
  const cursorRow = wrap('› ' + display.value.slice(0, display.cursorOffset), model.width).length - 1;
  const row = Math.max(0, cursorRow - layout.composerHeight + 1) + Math.max(0, Math.min(layout.composerHeight - 1, y - layout.composerTop));
  let start = 0;
  for (let i = 0; i < row && i < lines.length; i++) {
    start += lines[i].length;
    if (text[start] === '\n') start++;
  }
  let projected = Math.max(0, Math.min(display.value.length, start + columnOffset(lines[row] || '', x - 1) - 2));
  let shift = 0;
  for (const block of model.composer.pastedBlocks || []) {
    if (model.composer.value.slice(block.start, block.end) !== block.text) continue;
    const labelLength = `[Pasted ~${block.text.split('\n').length} lines]`.length;
    const from = block.start + shift;
    if (projected <= from) break;
    if (projected < from + labelLength) return projected - from < labelLength / 2 ? block.start : block.end;
    shift += labelLength - (block.end - block.start);
  }
  return Math.min(model.composer.value.length, projected - shift);
}
export function selectionKey(msg: Msg, model: RootModel, layout: SelectionLayout): [RootModel, Cmd[]] | undefined {
  if (msg.type !== 'key') return;
  const selection = model.selection;
  if (msg.mouse && ['mouse+press', 'mouse+drag', 'mouse+release'].includes(msg.key)) {
    if (model.focus === 'palette' || model.height <= 2) return [model, []];
    const { x, y } = msg.mouse;
    const pressed = msg.key === 'mouse+press';
    if (!pressed && !selection?.dragging) return [model, []];
    const target = pressed ? y >= layout.composerTop && y < layout.composerTop + layout.composerHeight ? 'composer'
      : y >= 2 && y < 2 + layout.bodyHeight && x <= layout.mainWidth && !model.diff.visible ? 'viewport' : undefined : selection!.target;
    if (!target) return [{ ...model, selection: undefined, composer: { ...model.composer, selection: undefined } }, []];
    const sourceLines = target === 'viewport' ? (pressed ? viewportLines(model.viewport, layout.mainWidth) : selection!.sourceLines!) : undefined;
    const lines = sourceLines?.map(line => stripTerminalControls(line));
    const viewportOffset = pressed ? model.viewport.offset : selection!.viewportOffset ?? model.viewport.offset;
    const composerCursor = pressed ? model.composer.cursorOffset : selection!.composerCursor;
    const bottom = Math.max(layout.bodyHeight, (lines?.length || 0) - viewportOffset);
    const row = Math.max(0, bottom - layout.bodyHeight) + Math.max(0, Math.min(layout.bodyHeight - 1, y - 2));
    const head = target === 'composer' ? inputOffset(pressed ? { ...model, selection: undefined } : model, layout, x, y) : lineOffset(lines!, row, x - 1);
    const anchor = pressed ? head : selection!.anchor;
    if (msg.key === 'mouse+release' && head === anchor) return [{ ...model, selection: undefined, composer: { ...model.composer, selection: undefined } }, []];
    return [{ ...model, focus: target, selection: { target, anchor, head, dragging: msg.key !== 'mouse+release', lines, sourceLines, entries: pressed ? model.viewport.entries : selection!.entries, width: layout.mainWidth, viewportOffset, composerCursor },
      composer: { ...model.composer, ...(target === 'composer' ? { cursorOffset: head, selection: { anchor, head } } : { selection: undefined }) } }, []];
  }
  if (!selection || selection.anchor === selection.head) return;
  const start = Math.min(selection.anchor, selection.head);
  const end = Math.max(selection.anchor, selection.head);
  if (msg.key === 'ctrl+c') {
    const text = selection.target === 'composer' ? model.composer.value.slice(start, end) : selection.lines!.join('\n').slice(start, end);
    return [model, [{ type: 'copy', text }]];
  }
  if (msg.key === 'delete' || msg.key === 'backspace') {
    if (selection.target === 'composer') {
      const composer = updateComposer({ ...model.composer, cursorOffset: start, selection: { anchor: start, head: end } }, msg);
      return [{ ...model, selection: undefined, composer }, []];
    }
    const archivedLength = (selection.entries || []).reduce((sum, entry) => {
      const rows = viewportLines({ ...model.viewport, entries: [entry], thinking: '', answerStream: '' }, selection.width!).map(line => stripTerminalControls(line));
      return sum + (rows.length ? rows.join('\n').length + 1 : 0);
    }, 0);
    if (end > archivedLength) return [{ ...model, status: { ...model.status, notice: 'Wait for streaming text to finish before deleting it' } }, []];
    let offset = 0;
    const entries = model.viewport.entries.map(entry => {
      if (!selection.entries?.includes(entry)) return entry;
      const rendered = viewportLines({ ...model.viewport, entries: [entry], thinking: '', answerStream: '' }, selection.width!).map(line => stripTerminalControls(line));
      const text = rendered.join('\n');
      const from = Math.max(0, start - offset);
      const to = Math.min(text.length, end - offset);
      offset += rendered.length ? text.length + 1 : 0;
      return to > from ? { ...entry, displayText: (text.slice(0, from) + text.slice(to)).replace(/\n$/, '') } : entry;
    });
    return [{ ...model, selection: undefined, viewport: { ...model.viewport, entries }, status: { ...model.status, notice: 'Selection removed from displayed transcript' } }, []];
  }
  if (msg.key === 'escape') return [{ ...model, selection: undefined, composer: { ...model.composer, selection: undefined } }, []];
}

function highlightRange(line: string, start: number, end: number, base: string): string {
  let offset = 0;
  let selected = false;
  let result = '';
  const background = '\x1b[48;2;65;72;104m';
  for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]+/g) || []) {
    if (token.startsWith('\x1b')) { result += token + (selected ? background : ''); continue; }
    for (const item of graphemes.segment(token)) {
      const active = offset >= start && offset < end;
      if (active !== selected) { result += active ? background : base; selected = active; }
      result += item.segment;
      offset += item.segment.length;
    }
  }
  return result + (selected ? base : '');
}

export function selectionRows(model: RootModel, rows: string[], layout: SelectionLayout): string[] {
  const selection = model.selection;
  if (!selection || selection.anchor === selection.head) return rows;
  let start = Math.min(selection.anchor, selection.head);
  let end = Math.max(selection.anchor, selection.head);
  let lines: string[];
  let top: number;
  let offset = 0;
  if (selection.target === 'viewport') {
    lines = selection.lines || [];
    const bottom = Math.max(layout.bodyHeight, lines.length - (selection.viewportOffset ?? model.viewport.offset));
    const first = Math.max(0, bottom - layout.bodyHeight);
    offset = lines.slice(0, first).reduce((sum, line) => sum + line.length + 1, 0);
    lines = lines.slice(first, bottom);
    top = 1;
  } else {
    const display = composerDisplay({ ...model.composer, cursorOffset: selection.composerCursor ?? model.composer.cursorOffset });
    start = composerDisplay({ ...model.composer, cursorOffset: start }).cursorOffset + 2;
    end = composerDisplay({ ...model.composer, cursorOffset: end }).cursorOffset + 2;
    const text = '› ' + display.value;
    lines = wrap(text, model.width);
    const cursorRow = wrap(text.slice(0, display.cursorOffset + 2), model.width).length - 1;
    const first = Math.max(0, cursorRow - layout.composerHeight + 1);
    for (let i = 0; i < first; i++) { offset += lines[i].length; if (text[offset] === '\n') offset++; }
    lines = lines.slice(first, first + layout.composerHeight);
    top = layout.composerTop - 1;
  }
  const next = [...rows];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const from = Math.max(0, start - offset);
    const to = Math.min(line.length, end - offset);
    if (to > from && next[top + i] !== undefined) {
      const base = selection.target === 'composer' ? '\x1b[48;2;41;46;66m' : '\x1b[48;2;26;27;38m';
      next[top + i] = highlightRange(next[top + i], from, to, base);
    }
    offset += line.length + (selection.target === 'viewport' ? 1 : ('› ' + composerDisplay(model.composer).value)[offset + line.length] === '\n' ? 1 : 0);
  }
  return next;
}
