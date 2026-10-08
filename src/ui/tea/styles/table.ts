import { color, displayWidth, fit, tokyoNight, wrap } from './theme.js';

export interface TableBorder {
  top: string;
  topMid: string;
  topLeft: string;
  topRight: string;
  bottom: string;
  bottomMid: string;
  bottomLeft: string;
  bottomRight: string;
  mid: string;
  midMid: string;
  midLeft: string;
  midRight: string;
  left: string;
  right: string;
  middle: string;
}

export const roundedBorder: TableBorder = {
  top: '─',
  topMid: '┬',
  topLeft: '╭',
  topRight: '╮',
  bottom: '─',
  bottomMid: '┴',
  bottomLeft: '╰',
  bottomRight: '╯',
  mid: '─',
  midMid: '┼',
  midLeft: '├',
  midRight: '┤',
  left: '│',
  right: '│',
  middle: '│',
};

export interface TableOptions {
  headers?: string[];
  rows?: string[][];
  width?: number;
  border?: TableBorder;
  headerColor?: number | string;
  borderColor?: number | string;
  textColor?: number | string;
}

/**
 * TEA Terminal UI Table Component (Lip Gloss / Bubble Tea style)
 * Provides declarative, width-aware, rounded Unicode table formatting.
 */
export class Table {
  private _headers: string[] = [];
  private _rows: string[][] = [];
  private _width?: number;
  private _border: TableBorder = roundedBorder;
  private _headerColor: number | string = tokyoNight.blue;
  private _borderColor: number | string = tokyoNight.border;
  private _textColor: number | string = tokyoNight.text;

  constructor(options?: TableOptions) {
    if (options?.headers) this._headers = options.headers;
    if (options?.rows) this._rows = options.rows;
    if (options?.width) this._width = options.width;
    if (options?.border) this._border = options.border;
    if (options?.headerColor) this._headerColor = options.headerColor;
    if (options?.borderColor) this._borderColor = options.borderColor;
    if (options?.textColor) this._textColor = options.textColor;
  }

  headers(...headers: string[]): this {
    this._headers = headers.flat();
    return this;
  }

  row(...cells: string[]): this {
    this._rows.push(cells.flat());
    return this;
  }

  rows(rows: string[][]): this {
    this._rows.push(...rows);
    return this;
  }

  width(width: number): this {
    this._width = width;
    return this;
  }

  render(targetWidth?: number): string {
    const width = targetWidth ?? this._width ?? 80;
    const allRows = this._headers.length > 0 ? [this._headers, ...this._rows] : this._rows;
    if (allRows.length === 0) return '';

    const colCount = Math.max(...allRows.map(r => r.length), 1);
    const borderOverhead = 3 * colCount + 1; // 1 start, 3 per col (padding left + cell + padding right + sep)
    const contentBudget = Math.max(colCount * 4, width - borderOverhead);

    // Measure natural width of each column
    const naturalWidths: number[] = Array.from({ length: colCount }, (_, col) => {
      let maxW = 1;
      for (const row of allRows) {
        const text = row[col] || '';
        for (const line of String(text).split('\n')) {
          maxW = Math.max(maxW, displayWidth(line.trim()));
        }
      }
      return maxW;
    });

    const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
    let colWidths: number[];

    if (totalNatural <= contentBudget) {
      colWidths = [...naturalWidths];
    } else {
      // Allocate budget proportionally, keeping minimum column width
      const minColWidth = 6;
      colWidths = naturalWidths.map(w =>
        Math.max(minColWidth, Math.floor(contentBudget * (w / totalNatural))),
      );
      let allocated = colWidths.reduce((a, b) => a + b, 0);
      let diff = contentBudget - allocated;
      if (diff > 0) {
        colWidths[colWidths.length - 1] += diff;
      } else if (diff < 0) {
        for (let i = colWidths.length - 1; i >= 0 && diff < 0; i--) {
          const shrink = Math.min(-diff, Math.max(0, colWidths[i] - minColWidth));
          colWidths[i] -= shrink;
          diff += shrink;
        }
      }
    }

    const b = this._border;
    const lines: string[] = [];

    // Top border
    lines.push(
      b.topLeft +
      colWidths.map(w => b.top.repeat(w + 2)).join(b.topMid) +
      b.topRight,
    );

    const renderRowCells = (row: string[], isHeader = false): string[] => {
      const wrappedCells: string[][] = colWidths.map((w, col) => {
        const text = row[col] != null ? String(row[col]) : '';
        return text.split('\n').flatMap(part => wrap(part, w));
      });
      const maxLines = Math.max(...wrappedCells.map(c => c.length), 1);
      const rowLines: string[] = [];

      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        const cellParts = colWidths.map((w, col) => {
          const raw = wrappedCells[col]?.[lineIdx] || '';
          return fit(raw, w);
        });
        rowLines.push(b.left + ' ' + cellParts.join(` ${b.middle} `) + ' ' + b.right);
      }
      return rowLines;
    };

    if (this._headers.length > 0) {
      lines.push(...renderRowCells(this._headers, true));
      lines.push(
        b.midLeft +
        colWidths.map(w => b.mid.repeat(w + 2)).join(b.midMid) +
        b.midRight,
      );
    }

    for (let r = 0; r < this._rows.length; r++) {
      lines.push(...renderRowCells(this._rows[r], false));
    }

    // Bottom border
    lines.push(
      b.bottomLeft +
      colWidths.map(w => b.bottom.repeat(w + 2)).join(b.bottomMid) +
      b.bottomRight,
    );

    return lines.join('\n');
  }
}

export function renderTable(headers: string[], rows: string[][], options?: TableOptions): string {
  const table = new Table({ ...options, headers, rows });
  return table.render(options?.width);
}

/**
 * Format submit_solution payload into a structured TEA TUI table.
 */
export function formatSubmitSolutionTable(result: Record<string, unknown>, width = 80): string {
  const table = new Table({ width });
  table.headers('Thuộc tính / Property', 'Chi tiết / Details');

  const resolution = result.resolutionType ? String(result.resolutionType) : 'code_fix';
  table.row('Loại giải pháp', resolution);

  if (result.summary) {
    table.row('Tóm tắt', String(result.summary));
  }

  if (result.rootCause) {
    table.row('Nguyên nhân gốc', String(result.rootCause));
  }

  const files = Array.isArray(result.filesModified) ? result.filesModified : [];
  if (files.length > 0) {
    table.row('Tệp đã sửa đổi', files.join('\n'));
  } else {
    table.row('Tệp đã sửa đổi', '(Không có thay đổi tệp)');
  }

  if (result.verificationMethod) {
    table.row('Phương thức kiểm thử', String(result.verificationMethod));
  }

  if (result.verificationEvidence) {
    table.row('Bằng chứng xác minh', String(result.verificationEvidence));
  }

  if (result.groundingScore !== undefined) {
    table.row('Điểm chứng thực', `${result.groundingScore}/100`);
  }

  table.row('Trạng thái', '✔ Đã nộp thành công (Submitted)');

  return table.render(width);
}
