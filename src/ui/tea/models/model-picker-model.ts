import type { KeyMsg, ModelPickerModel, ModelPickerOption, RootModel, Cmd } from '../types.js';
import { color, fit, lipGlossTheme, tokyoNight, wrap } from '../styles/theme.js';
import { fuzzyScore, highlightMatch } from './palette-model.js';

export function createModelPickerModel(): ModelPickerModel {
  return { open: false, options: [], selected: 0, query: '' };
}

/** Nền highlight dòng đang chọn — cùng giá trị với viewport selection trong selection.ts. */
const SEL_BG = '\x1b[48;2;65;72;104m';
// Giống paintCanvas/paintInput: cấp lại bg sau mỗi SGR reset lồng bên trong.
function selBg(row: string): string {
  return `${SEL_BG}${row.replace(/\x1b\[0m/g, `\x1b[0m${SEL_BG}`)}\x1b[0m`;
}

/** Lọc fuzzy theo id/name/provider/desc (mirror paletteItems) — query rỗng = toàn bộ, giữ thứ tự gốc khi đồng điểm. */
export function pickerItems(picker: ModelPickerModel): ModelPickerOption[] {
  if (!picker.query) return picker.options;
  return picker.options
    .map((item) => ({ item, score: Math.min(fuzzyScore(picker.query, item.id), fuzzyScore(picker.query, `${item.name} ${item.provider || ''} ${item.desc || ''}`)) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score)
    .map((row) => row.item);
}

/** Geometry + per-row option mapping — nguồn duy nhất cho cả render lẫn hit-test click chuột. */
export interface ModelPickerLayout { panel: string[]; startRow: number; rowOption: (number | undefined)[] }

function optionRow(opt: ModelPickerOption, query: string, selected: boolean): string {
  const marker = selected ? color(tokyoNight.cyan, '› ') : '  ';
  const badge = opt.current ? color(tokyoNight.green, '● ') : opt.recommended ? color(tokyoNight.yellow, '★ ') : '';
  const row = `${marker}${badge}${color(tokyoNight.cyan, `[${highlightMatch(opt.id, query)}]`)} ${highlightMatch(opt.name, query)}`;
  return selected ? selBg(row) : row;
}

export function modelPickerLayout(picker: ModelPickerModel, width: number, height: number): ModelPickerLayout {
  const panelWidth = Math.max(20, Math.min(width - 4, 72));
  const inner = Math.max(1, panelWidth - 2);
  const items = pickerItems(picker);
  const count = items.length;
  const sel = count ? Math.min(picker.selected, count - 1) : 0;
  const body: { text: string; option?: number }[] = [];
  const current = picker.options.find((o) => o.current)?.name;
  const pos = count ? ` · ${sel + 1}/${count}` : '';
  const filt = picker.query ? ` · lọc "${picker.query}"` : '';
  body.push({ text: color(tokyoNight.purple, `MODELS · ${count} models${pos}`) + color(tokyoNight.muted, filt + ' · Esc hủy') });
  if (current) body.push({ text: color(tokyoNight.muted, `Hiện tại: ${current}`) });
  body.push({ text: color(tokyoNight.cyan, `> ${picker.query}`) });
  body.push({ text: '' });
  if (!count) {
    body.push({ text: color(tokyoNight.muted, picker.query ? `No match for "${picker.query}" — xóa để xem tất cả.` : 'Chưa có model.') });
  } else {
    // Cửa sổ trượt quanh selected: ~60 models không vừa màn hình.
    const page = Math.max(1, Math.min(count, height - 12));
    const winStart = Math.max(0, Math.min(sel - Math.floor(page / 2), count - page));
    const winEnd = Math.min(count, winStart + page);
    if (winStart > 0) body.push({ text: color(tokyoNight.muted, `↑ ${winStart} more`) });
    let lastProvider = '';
    for (let i = winStart; i < winEnd; i++) {
      const opt: ModelPickerOption = items[i];
      if (opt.provider && opt.provider !== lastProvider) {
        lastProvider = opt.provider;
        body.push({ text: color(tokyoNight.muted, opt.provider.toUpperCase()) });
      }
      body.push({ text: optionRow(opt, picker.query, i === sel), option: i });
      if (i === sel && opt.desc) {
        for (const d of wrap(opt.desc, inner).slice(0, 2)) body.push({ text: color(tokyoNight.muted, `    ${d}`), option: i });
      }
    }
    if (winEnd < count) body.push({ text: color(tokyoNight.muted, `↓ ${count - winEnd} more`) });
  }
  body.push({ text: '' });
  body.push({ text: color(tokyoNight.muted, '↑↓ chọn · Enter mở · Click chọn · gõ để lọc · Esc hủy') });
  // Wrap từng dòng ở inner width trước: panel.render wrap lại là no-op nên mapping hàng-option giữ nguyên.
  const flat: { text: string; option?: number }[] = [];
  for (const row of body) {
    for (const w of wrap(row.text, inner)) flat.push({ text: w, option: row.option });
  }
  const bodyHeight = Math.min(height - 4, flat.length + 2);
  const content = flat.slice(0, Math.max(1, bodyHeight - 2));
  const panel = lipGlossTheme.panel.render(content.map((r) => r.text).join('\n'), panelWidth, bodyHeight).map((row) => fit(row, panelWidth));
  // panel.render thêm 1 viền trên + 1 viền dưới.
  const rowOption: (number | undefined)[] = [undefined, ...content.map((r) => r.option), undefined];
  const startRow = Math.max(1, Math.floor((height - panel.length) / 2));
  return { panel, startRow, rowOption };
}

export function modelPickerView(picker: ModelPickerModel, width: number, height: number): string[] {
  return modelPickerLayout(picker, width, height).panel;
}

/** Key routing cho model-picker modal — đè lên input/composer (ưu tiên sau question/grill/sessions). */
export function modelPickerKey(msg: KeyMsg, model: RootModel): [RootModel, Cmd[]] | undefined {
  const picker = model.modelPicker;
  if (!picker.open || model.focus !== 'model-picker') return undefined;
  const items = pickerItems(picker);
  const count = items.length;
  const sel = count ? Math.min(picker.selected, count - 1) : 0;
  const setQuery = (query: string): [RootModel, Cmd[]] => [
    { ...model, modelPicker: { ...picker, query, selected: 0 } },
    [],
  ];
  const pick = (index: number): [RootModel, Cmd[]] => {
    const picked = items[index];
    return [
      { ...model, focus: 'composer' as const, modelPicker: { ...picker, open: false, query: '' } },
      [{ type: 'model-pick', id: picked.id, name: picked.name }],
    ];
  };
  // Chuột: click dòng option → chọn ngay; wheel → di chuyển highlight;
  // drag/release và click ngoài option → nuốt để không select text sau modal.
  if (msg.mouse) {
    if (msg.key === 'mouse+press' && msg.mouse.x >= 1 && msg.mouse.x <= model.width) {
      const { startRow, rowOption } = modelPickerLayout(picker, model.width, model.height);
      const opt = rowOption[msg.mouse.y - 1 - startRow];
      if (opt !== undefined) return pick(opt);
    } else if (msg.key === 'mouse+up' || msg.key === 'mouse+down') {
      if (!count) return [model, []];
      const d = msg.key === 'mouse+up' ? -1 : 1;
      return [{ ...model, modelPicker: { ...picker, selected: (sel + d + count) % count } }, []];
    }
    return [model, []];
  }
  switch (msg.key) {
    case 'escape':
    case 'ctrl+c':
      // Esc đầu xóa chuỗi lọc, Esc tiếp mới hủy (mirror palette query UX).
      if (msg.key === 'escape' && picker.query) return setQuery('');
      return [{ ...model, focus: 'composer' as const, modelPicker: { ...picker, open: false, query: '' } }, [{ type: 'model-cancel' }]];
    case 'up':
    case 'left':
      if (!count) return [model, []];
      return [{ ...model, modelPicker: { ...picker, selected: (sel + count - 1) % count } }, []];
    case 'down':
    case 'right':
      if (!count) return [model, []];
      return [{ ...model, modelPicker: { ...picker, selected: (sel + 1) % count } }, []];
    case 'enter': {
      if (!count) return [model, []];
      return pick(sel);
    }
    case 'backspace':
      if (!picker.query) return [model, []];
      return setQuery(Array.from(picker.query).slice(0, -1).join(''));
    default:
      // Gõ để lọc fuzzy (mirror palette: mọi phím có text đều append).
      if (msg.text) return setQuery(picker.query + msg.text);
      return [model, []];
  }
}
