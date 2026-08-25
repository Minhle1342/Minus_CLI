export interface ShellAnalysis {
  segments: string[];
  operators: string[];
  complex: boolean;
  error?: string;
}

/** Quote-aware segmentation; substitutions and groups are marked complex for fail-closed policy. */
export function analyzeShellCommand(command: string): ShellAnalysis {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let complex = false;
  const push = (): boolean => {
    const value = current.trim();
    if (!value) return false;
    segments.push(value);
    current = '';
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '`' || (char === '\\' && quote !== "'")) { current += char; escaped = true; continue; }
    if (quote) { current += char; if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if ((char === '$' && command[i + 1] === '(') || char === '(' || char === ')') complex = true;
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      if (!push()) return { segments, operators, complex: true, error: 'Empty shell command segment.' };
      operators.push(two); i++; continue;
    }
    if (char === '|' || char === ';' || char === '\n' || char === '\r') {
      if (!push()) {
        if (char === '\r' && command[i + 1] === '\n') continue;
        return { segments, operators, complex: true, error: 'Empty shell command segment.' };
      }
      operators.push(char === '\n' || char === '\r' ? 'newline' : char);
      continue;
    }
    current += char;
  }
  if (quote || escaped) return { segments, operators, complex: true, error: 'Unterminated quote or escape sequence.' };
  push();
  if (segments.length === 0) return { segments, operators, complex, error: 'No executable command segment.' };
  return { segments, operators, complex };
}
