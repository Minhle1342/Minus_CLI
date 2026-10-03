/** Semantic colors for the Ink view. Ordinary content uses the terminal foreground. */
const inkColorEnabled = supportsTerminalColor();

export const inkColors = {
  accent: inkColorEnabled ? 'cyan' : undefined,
  success: inkColorEnabled ? 'green' : undefined,
  warning: inkColorEnabled ? 'yellow' : undefined,
  danger: inkColorEnabled ? 'red' : undefined,
  muted: inkColorEnabled ? 'gray' : undefined,
} as const;

/** Keep redirected output and terminals without color support free of SGR codes. */
export function supportsTerminalColor(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if ('NO_COLOR' in env || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return isTTY;
}
