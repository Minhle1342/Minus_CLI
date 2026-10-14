// Caps ported from OpenCode Code Mode limits: check size before building, fail fast with RangeError.
export const MAX_STRING_LENGTH = 2 ** 24;
export const MAX_ARRAY_LENGTH = 10_000_000;
export const MAX_PENDING_PROMISES = 10_000;
export const MAX_RECURSION_DEPTH = 10_000;

export function checkStringLength(n: number): void {
  if (n > MAX_STRING_LENGTH) throw new RangeError('Invalid string length');
}

export function checkArrayLength(n: number): void {
  if (n > MAX_ARRAY_LENGTH) throw new RangeError('Invalid array length');
}

/** Depth guard for interpreter-style recursion: throws like V8 at the cap. */
export function nextDepth(depth: number): number {
  if (depth + 1 > MAX_RECURSION_DEPTH) throw new RangeError('Maximum call stack size exceeded');
  return depth + 1;
}
