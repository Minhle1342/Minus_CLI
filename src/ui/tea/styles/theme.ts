import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export { stringWidth as displayWidth };
/** Remove terminal commands from untrusted content; optional SGR is presentation only. */
export function stripTerminalControls(text: string, keepColor = false): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, sequence => keepColor && /^\x1b\[[\d;]*m$/.test(sequence) ? sequence : '')
    .replace(/\x1b[^\x1b]?/g, sequence => keepColor && sequence === '\x1b[' ? sequence : '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, char => keepColor && char === '\x1b' ? char : '')
    .replace(/\r/g, '');
}
export function wrap(text: string, width: number): string[] {
  const clean = stripTerminalControls(text, true);
  if (width < 2) return Array.from(clean.split('\n'), line => stringWidth(line) <= width ? line : '');
  return wrapAnsi(clean, Math.max(1, width), { hard: true, trim: false }).split('\n');
}
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const line = wrap(text, width)[0] || '';
  return line + ' '.repeat(Math.max(0, width - stringWidth(line)));
}
/** Tokyo Night (Night variant), using the upstream Windows Terminal palette. */
export const tokyoNight = {
  background: '#1a1b26', text: '#c0caf5', muted: '#a9b1d6', border: '#414868',
  blue: '#7aa2f7', cyan: '#7dcfff', green: '#9ece6a', red: '#f7768e',
  yellow: '#e0af68', purple: '#bb9af7',
} as const;

const rgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${value >> 16 & 255};${value >> 8 & 255};${value & 255}`;
};

const foreground: Record<number, string> = {
  31: tokyoNight.red, 32: tokyoNight.green, 33: tokyoNight.yellow,
  36: tokyoNight.blue, 37: tokyoNight.text, 90: tokyoNight.muted,
};

export const color = (code: number | string, text: string): string => {
  const hex = typeof code === 'string' ? code : foreground[code];
  return `\x1b[${hex ? `38;2;${rgb(hex)}` : code}m${text}\x1b[0m`;
};

/** Paint the whole terminal row, restoring the canvas after nested SGR resets. */
export function paintCanvas(row: string): string {
  const canvas = `\x1b[38;2;${rgb(tokyoNight.text)};48;2;${rgb(tokyoNight.background)}m`;
  return canvas + row.replace(/\x1b\[0m/g, `\x1b[0m${canvas}`) + '\x1b[0m';
}
/** Small immutable Lip Gloss style composition, bundled as allowed by the plan. */
export class Style {
  constructor(private readonly code = 37, private readonly boxed = false) {}
  foreground(code: number): Style { return new Style(code, this.boxed); }
  border(): Style { return new Style(this.code, true); }
  render(text: string, width: number, height?: number): string[] {
    if (this.boxed && width >= 2) {
      const body = wrap(text, width - 2);
      const rows = height ? body.slice(0, Math.max(0, height - 2)) : body;
      return [color(this.code, '┌' + '─'.repeat(width - 2) + '┐'), ...rows.map(row => color(this.code, '│') + fit(row, width - 2) + color(this.code, '│')), color(this.code, '└' + '─'.repeat(width - 2) + '┘')];
    }
    return wrap(text, width).slice(0, height).map(row => color(this.code, fit(row, width)));
  }
}
export const lipGlossTheme = {
  text: new Style(), muted: new Style(90), accent: new Style(36), panel: new Style(90).border(),
  added: new Style(32), removed: new Style(31), warning: new Style(33),
};
export function joinHorizontal(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => fit(left[i] || '', leftWidth) + fit(right[i] || '', rightWidth));
}
export const joinVertical = (...parts: string[][]): string[] => parts.flat();
