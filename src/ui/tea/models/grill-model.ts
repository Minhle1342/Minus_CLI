import type { GrillModel, GrillOption, KeyMsg, RootModel, Cmd } from '../types.js';
import { color, fit, lipGlossTheme, tokyoNight, wrap } from '../styles/theme.js';

export function createGrillModel(): GrillModel {
  return { open: false, question: '', options: [], selected: 0, loading: false };
}

export function openGrill(question: string, options: GrillOption[] = []): GrillModel {
  return { open: true, question, options, selected: 0, loading: options.length === 0 };
}

/** Key routing cho grill modal — đè lên input/composer (ưu tiên sau question/permission). */
export function grillKey(msg: KeyMsg, model: RootModel): [RootModel, Cmd[]] | undefined {
  const grill = model.grill;
  if (!grill.open || model.focus !== 'grill') return undefined;

  // Xử lý chế độ người dùng tự nhập nội dung trực tiếp trong modal
  if (grill.customInput?.active) {
    if (msg.key === 'escape') {
      return [{ ...model, grill: { ...grill, customInput: { active: false, value: '', cursor: 0 } } }, []];
    }
    if (msg.key === 'enter') {
      const text = (grill.customInput.value || '').trim() || 'Tự nhập phương án khác...';
      return [
        { ...model, focus: 'composer' as const, grill: { ...grill, open: false, loading: false, customInput: undefined } },
        [{ type: 'grill-pick', text }],
      ];
    }
    if (msg.key === 'backspace') {
      const val = grill.customInput.value || '';
      const nextVal = val.slice(0, Math.max(0, val.length - 1));
      return [{ ...model, grill: { ...grill, customInput: { active: true, value: nextVal, cursor: nextVal.length } } }, []];
    }
    if (msg.text && !msg.ctrl) {
      const val = (grill.customInput.value || '') + msg.text;
      return [{ ...model, grill: { ...grill, customInput: { active: true, value: val, cursor: val.length } } }, []];
    }
    return [model, []];
  }

  const count = grill.options.length;
  switch (msg.key) {
    case 'escape':
    case 'ctrl+c':
      return [{ ...model, focus: 'composer' as const, grill: { ...grill, open: false, loading: false } }, [{ type: 'grill-cancel' }]];
    case 'up':
    case 'left':
      if (!count) return [model, []];
      return [{ ...model, grill: { ...grill, selected: (grill.selected + count - 1) % count } }, []];
    case 'down':
    case 'right':
      if (!count) return [model, []];
      return [{ ...model, grill: { ...grill, selected: (grill.selected + 1) % count } }, []];
    case 'enter': {
      if (grill.loading || !count) return [model, []];
      const picked = grill.options[Math.min(grill.selected, count - 1)];
      if (picked.id === 'custom' || picked.source === 'user') {
        return [{ ...model, grill: { ...grill, customInput: { active: true, value: '', cursor: 0 } } }, []];
      }
      return [
        { ...model, focus: 'composer' as const, grill: { ...grill, open: false, loading: false } },
        [{ type: 'grill-pick', text: picked.label }],
      ];
    }
    default: {
      // Phím số 1..9 chọn nhanh; các phím khác không lọt xuống composer.
      const digit = msg.text && /^[1-9]$/.test(msg.text) ? Number(msg.text) - 1 : -1;
      if (digit >= 0 && digit < count && !grill.loading) {
        const picked = grill.options[digit];
        if (picked.id === 'custom' || picked.source === 'user') {
          return [{ ...model, grill: { ...grill, customInput: { active: true, value: '', cursor: 0 } } }, []];
        }
        return [
          { ...model, focus: 'composer' as const, grill: { ...grill, open: false, loading: false } },
          [{ type: 'grill-pick', text: picked.label }],
        ];
      }
      return [model, []];
    }
  }
}

export function grillView(grill: GrillModel, width: number, height: number): string[] {
  const panelWidth = Math.max(20, Math.min(width - 4, 72));
  const lines: string[] = [];
  lines.push(color(tokyoNight.purple, 'ELICITATION / GRILL-ME · Thống nhất lựa chọn') + color(tokyoNight.muted, ' · Esc hủy'));
  lines.push(...wrap(color(tokyoNight.text, grill.question || '(không có câu hỏi)'), panelWidth));
  lines.push('');
  if (grill.customInput?.active) {
    lines.push(color(tokyoNight.cyan, '› Nhập câu trả lời của bạn:'));
    lines.push(color(tokyoNight.text, `  [ ${grill.customInput.value || ''}▏ ]`));
    lines.push('');
    lines.push(color(tokyoNight.muted, 'Enter xác nhận · Esc quay lại danh sách'));
  } else if (grill.loading) {
    lines.push(...wrap(color(tokyoNight.yellow, '… LLM đang gợi ý phương án, chờ chút…'), panelWidth));
  } else if (!grill.options.length) {
    lines.push(...wrap(color(tokyoNight.muted, 'Chưa có phương án. Nhập /grill-me <câu hỏi> để xin gợi ý từ LLM.'), panelWidth));
  } else {
    grill.options.forEach((opt, i) => {
      const marker = i === grill.selected ? color(tokyoNight.cyan, '› ') : '  ';
      const badge = opt.source === 'llm' ? color(tokyoNight.green, '[LLM] ') : opt.source === 'heuristic' ? color(tokyoNight.yellow, '[gợi ý] ') : opt.source === 'user' ? color(tokyoNight.purple, '[tự nhập] ') : '';
      lines.push(...wrap(`${marker}${color(tokyoNight.cyan, `${i + 1}.`)} ${badge}${opt.label}`, panelWidth));
      if (opt.detail) lines.push(...wrap(`    ${color(tokyoNight.muted, opt.detail)}`, panelWidth));
    });
    lines.push('');
    lines.push(color(tokyoNight.muted, '↑↓ di chuyển · Enter/1-9 chọn · Esc hủy'));
  }
  const bodyHeight = Math.min(height - 4, lines.length + 2);
  return lipGlossTheme.panel.render(lines.slice(0, Math.max(1, bodyHeight)).join('\n'), panelWidth, bodyHeight).map((row) => fit(row, panelWidth));
}
