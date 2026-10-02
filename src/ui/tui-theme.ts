/** Semantic colors for the Ink view. Ordinary content uses the terminal foreground. */
export const inkColors = {
  accent: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
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
