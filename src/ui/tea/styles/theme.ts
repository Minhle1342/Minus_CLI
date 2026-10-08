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
  // P2: muted lifted to 8.9:1 on the canvas (was 8.1:1) — still visibly dimmer than text at 10.6:1.
  background: '#1a1b26', inputBackground: '#292e42', text: '#c0caf5', muted: '#b3badb', border: '#414868',
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
/** Keep the input background across nested text colors and their resets. */
export function paintInput(row: string): string {
  const background = `\x1b[48;2;${rgb(tokyoNight.inputBackground)}m`;
  return background + row.replace(/\x1b\[0m/g, `\x1b[0m${background}`) + '\x1b[0m';
}
/** Small immutable Lip Gloss style composition, bundled as allowed by the plan. */
export class Style {
  constructor(private readonly code = 37, private readonly boxed = false) {}
  foreground(code: number): Style { return new Style(code, this.boxed); }
  border(): Style { return new Style(this.code, true); }
  render(text: string, width: number, height?: number): string[] {
    if (this.boxed && width >= 2) {
      // P2: rounded corners everywhere — matches the permission card (╭─╮), no more ┌/╭ mix.
      const body = wrap(text, width - 2);
      const rows = height ? body.slice(0, Math.max(0, height - 2)) : body;
      return [color(this.code, '╭' + '─'.repeat(width - 2) + '╮'), ...rows.map(row => color(this.code, '│') + fit(row, width - 2) + color(this.code, '│')), color(this.code, '╰' + '─'.repeat(width - 2) + '╯')];
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
/** P2: no animated spinner for reduced-motion users (NO_COLOR set or dumb terminal) — static bullet instead. */
export function motionAllowed(): boolean {
  return !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
}
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinnerFrame(frame: number): string {
  if (!motionAllowed()) return '•';
  return SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}
export const joinVertical = (...parts: string[][]): string[] => parts.flat();
export { Table, renderTable, formatSubmitSolutionTable, type TableBorder, type TableOptions, roundedBorder } from './table.js';
