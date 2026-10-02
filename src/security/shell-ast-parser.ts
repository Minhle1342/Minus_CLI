/**
 * POSIX / Bash AST Syntactic Guardrail
 * 
 * Provides structural abstract syntax tree (AST) parsing and security classification
 * for shell command lines. Replaces naive regex/substring pattern matching with
 * deterministic tokenization, quotation-aware tree walking, and subshell/obfuscation detection.
 */

export type ShellNodeType =
  | 'Program'
  | 'LogicalList'
  | 'Pipeline'
  | 'SimpleCommand'
  | 'Subshell'
  | 'CommandSubstitution'
  | 'ProcessSubstitution'
  | 'Redirect'
  | 'Word';

export interface ShellRedirect {
  type: string;
  target: string;
  fd?: number;
}

export interface ShellAssignment {
  key: string;
  value: string;
}

export interface ShellSimpleCommand {
  raw: string;
  executable: string;
  args: string[];
  assignments: ShellAssignment[];
  redirects: ShellRedirect[];
}

export interface ShellAstNode {
  type: ShellNodeType;
  raw: string;
  operator?: string;
  children?: ShellAstNode[];
  command?: ShellSimpleCommand;
}

export interface ShellParseResult {
  ast: ShellAstNode;
  segments: string[];
  operators: string[];
  commands: ShellSimpleCommand[];
  complex: boolean;
  hasSubshell: boolean;
  hasObfuscation: boolean;
  obfuscationReasons: string[];
  error?: string;
}

export interface ShellToken {
  type:
    | 'WORD'
    | 'OPERATOR'
    | 'REDIRECT'
    | 'SUBSHELL_START'
    | 'SUBSHELL_END'
    | 'CMD_SUBST'
    | 'EOF';
  value: string;
  quoted?: boolean;
  quoteChar?: "'" | '"' | '`';
  raw: string;
}

/**
 * Tokenize a shell command line while strictly tracking quotes, escapes, and substitutions.
 */
export function tokenizeShell(command: string): { tokens: ShellToken[]; error?: string } {
  const tokens: ShellToken[] = [];
  let i = 0;
  const len = command.length;

  while (i < len) {
    // Skip whitespace outside of quotes
    while (i < len && /[ \t\f\v]/.test(command[i])) {
      i++;
    }
    if (i >= len) break;

    const char = command[i];

    // Single quotes: raw literal string, no escapes interpreted
    if (char === "'") {
      let val = '';
      const start = i;
      i++; // skip open quote
      while (i < len && command[i] !== "'") {
        val += command[i];
        i++;
      }
      if (i >= len) {
        return { tokens, error: 'Unterminated single quote in shell command.' };
      }
      i++; // skip close quote
      tokens.push({
        type: 'WORD',
        value: val,
        quoted: true,
        quoteChar: "'",
        raw: command.slice(start, i),
      });
      continue;
    }

    // Double quotes: allows escapes and parameter/command substitutions
    if (char === '"') {
      let val = '';
      const start = i;
      i++; // skip open quote
      let escaped = false;
      let hasInnerSubst = false;
      while (i < len) {
        const c = command[i];
        if (escaped) {
          val += c;
          escaped = false;
          i++;
          continue;
        }
        if (c === '\\') {
          escaped = true;
          val += c;
          i++;
          continue;
        }
        if (c === '"') {
          break;
        }
        if (c === '`' || (c === '$' && i + 1 < len && command[i + 1] === '(')) {
          hasInnerSubst = true;
        }
        val += c;
        i++;
      }
      if (i >= len) {
        return { tokens, error: 'Unterminated double quote in shell command.' };
      }
      i++; // skip close quote
      tokens.push({
        type: hasInnerSubst ? 'CMD_SUBST' : 'WORD',
        value: val,
        quoted: true,
        quoteChar: '"',
        raw: command.slice(start, i),
      });
      continue;
    }

    // Backticks: command substitution
    if (char === '`') {
      let val = '';
      const start = i;
      i++; // skip open backtick
      let escaped = false;
      while (i < len) {
        const c = command[i];
        if (escaped) {
          val += c;
          escaped = false;
          i++;
          continue;
        }
        if (c === '\\') {
          escaped = true;
          i++;
          continue;
        }
        if (c === '`') {
          break;
        }
        val += c;
        i++;
      }
      if (i >= len) {
        return { tokens, error: 'Unterminated backtick command substitution.' };
      }
      i++; // skip close backtick
      tokens.push({
        type: 'CMD_SUBST',
        value: val,
        quoted: true,
        quoteChar: '`',
        raw: command.slice(start, i),
      });
      continue;
    }

    // Command substitution $( ... )
    if (char === '$' && i + 1 < len && command[i + 1] === '(') {
      let parenCount = 1;
      const start = i;
      i += 2; // skip $(
      let subst = '';
      let inSQuote = false;
      let inDQuote = false;
      let escaped = false;

      while (i < len && parenCount > 0) {
        const c = command[i];
        if (escaped) {
          subst += c;
          escaped = false;
          i++;
          continue;
        }
        if (c === '\\' && !inSQuote) {
          escaped = true;
          subst += c;
          i++;
          continue;
        }
        if (c === "'" && !inDQuote) {
          inSQuote = !inSQuote;
          subst += c;
          i++;
          continue;
        }
        if (c === '"' && !inSQuote) {
          inDQuote = !inDQuote;
          subst += c;
          i++;
          continue;
        }
        if (!inSQuote && !inDQuote) {
          if (c === '(') parenCount++;
          else if (c === ')') parenCount--;
        }
        if (parenCount > 0) {
          subst += c;
        }
        i++;
      }

      if (parenCount > 0) {
        return { tokens, error: 'Unterminated $( ... ) command substitution.' };
      }
      tokens.push({
        type: 'CMD_SUBST',
        value: subst,
        raw: command.slice(start, i),
      });
      continue;
    }

    // Process substitution <( ... ) or >( ... )
    if ((char === '<' || char === '>') && i + 1 < len && command[i + 1] === '(') {
      const start = i;
      i += 2;
      let parenCount = 1;
      let inner = '';
      while (i < len && parenCount > 0) {
        const c = command[i];
        if (c === '(') parenCount++;
        else if (c === ')') parenCount--;
        if (parenCount > 0) inner += c;
        i++;
      }
      tokens.push({
        type: 'CMD_SUBST',
        value: inner,
        raw: command.slice(start, i),
      });
      continue;
    }

    // Two-character operators
    const twoChars = command.slice(i, i + 2);
    if (['&&', '||', '>>', '<<', '>&', '<&', '&>', '>|'].includes(twoChars)) {
      if (['>>', '<<', '>&', '<&', '&>', '>|'].includes(twoChars)) {
        tokens.push({ type: 'REDIRECT', value: twoChars, raw: twoChars });
      } else {
        tokens.push({ type: 'OPERATOR', value: twoChars, raw: twoChars });
      }
      i += 2;
      continue;
    }

    // Single-character operators & delimiters
    if (['|', ';', '\n', '\r'].includes(char)) {
      const op = char === '\n' || char === '\r' ? 'newline' : char;
      // Handle \r\n
      if (char === '\r' && i + 1 < len && command[i + 1] === '\n') {
        i += 2;
      } else {
        i++;
      }
      tokens.push({ type: 'OPERATOR', value: op, raw: char });
      continue;
    }

    // Single ampersand '&' (background operator or stream redirect target)
    if (char === '&') {
      tokens.push({ type: 'OPERATOR', value: '&', raw: '&' });
      i++;
      continue;
    }

    // Single redirections '<', '>'
    if (char === '<' || char === '>') {
      tokens.push({ type: 'REDIRECT', value: char, raw: char });
      i++;
      continue;
    }

    // Subshell grouping '(' and ')'
    if (char === '(') {
      tokens.push({ type: 'SUBSHELL_START', value: '(', raw: '(' });
      i++;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'SUBSHELL_END', value: ')', raw: ')' });
      i++;
      continue;
    }

    // Ordinary Word Token (can include escapes like \ )
    let word = '';
    const start = i;
    while (i < len) {
      const c = command[i];
      if (/[ \t\f\v\r\n]/.test(c)) break;
      if (['&', '|', ';', '<', '>', '(', ')', "'", '"', '`'].includes(c)) break;
      if (c === '\\') {
        i++;
        if (i < len) {
          word += command[i];
          i++;
        }
        continue;
      }
      word += c;
      i++;
    }

    if (word.length > 0) {
      // Check for file descriptor redirect prefix e.g. 2>&1 or 2>
      const fdRedirectMatch = /^(\d+)(>>|>|<)$/.exec(word);
      if (fdRedirectMatch) {
        tokens.push({
          type: 'REDIRECT',
          value: fdRedirectMatch[2],
          raw: word,
        });
      } else {
        tokens.push({
          type: 'WORD',
          value: word,
          raw: command.slice(start, i),
        });
      }
    }
  }

  tokens.push({ type: 'EOF', value: '', raw: '' });
  return { tokens };
}

/**
 * Detect obfuscation patterns, encoded payloads, or stealthy evasion tactics.
 */
export function detectShellObfuscation(command: string): { isObfuscated: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lower = command.toLowerCase();

  // 1. Base64 payload execution (e.g. echo ... | base64 -d | sh)
  if (/\bbase64\s+(?:-[a-z]*d[a-z]*|--decode)\b/i.test(command)) {
    reasons.push('Base64 decode pipeline detected.');
  }

  // 2. Dynamic evaluation primitives (eval, exec, source)
  if (/\b(?:eval|exec)\s+[^\s]/i.test(command)) {
    reasons.push('Dynamic shell eval/exec detected.');
  }

  // 3. Hex / octal byte escapes used to disguise binaries
  if (/\\x[0-9a-fA-F]{2}/i.test(command) || /\\[0-7]{3}/.test(command)) {
    reasons.push('Hex/octal character escape obfuscation detected.');
  }

  // 4. Pipe to shell binary (e.g. curl ... | bash, wget ... | sh)
  if (/\|\s*(?:bash|sh|zsh|dash|ksh|python|perl|ruby)\b/i.test(command)) {
    reasons.push('Direct pipe into shell interpreter detected.');
  }

  // 5. Environmental IFS substitution evasion (${IFS} instead of spaces)
  if (/\$\{IFS\}/i.test(command) || /\$IFS\b/.test(command)) {
    reasons.push('IFS variable expansion evasion detected.');
  }

  // 6. Suspicious shell invocation via string concatenation e.g. /bin/""sh or /bin/$'sh'
  if (/\/(?:bin|usr\/bin)\/['"][a-z]+['"]/i.test(command)) {
    reasons.push('Quoted path evasion detected.');
  }

  return {
    isObfuscated: reasons.length > 0,
    reasons,
  };
}

/**
 * Parse a token list into structured SimpleCommand representations.
 */
function parseSimpleCommandsFromTokens(tokens: ShellToken[]): ShellSimpleCommand[] {
  const commands: ShellSimpleCommand[] = [];
  let currentWords: string[] = [];
  let currentRedirects: ShellRedirect[] = [];
  let currentAssignments: ShellAssignment[] = [];
  let currentRaw: string[] = [];

  const flushCommand = () => {
    if (currentWords.length === 0 && currentAssignments.length === 0) return;
    const executable = currentWords[0] || '';
    const args = currentWords.slice(1);
    commands.push({
      raw: currentRaw.join(' ').trim(),
      executable,
      args,
      assignments: [...currentAssignments],
      redirects: [...currentRedirects],
    });
    currentWords = [];
    currentRedirects = [];
    currentAssignments = [];
    currentRaw = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'EOF') break;

    if (token.type === 'OPERATOR') {
      flushCommand();
      continue;
    }

    if (token.type === 'REDIRECT') {
      currentRaw.push(token.raw);
      const next = tokens[i + 1];
      const target = next && next.type === 'WORD' ? next.value : '';
      currentRedirects.push({
        type: token.value,
        target,
      });
      if (next && next.type === 'WORD') {
        currentRaw.push(next.raw);
        i++;
      }
      continue;
    }

    if (token.type === 'WORD') {
      currentRaw.push(token.raw);
      // Check for variable assignment before command: KEY=VALUE
      if (currentWords.length === 0 && !token.quoted && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(token.value)) {
        const eqIdx = token.value.indexOf('=');
        currentAssignments.push({
          key: token.value.slice(0, eqIdx),
          value: token.value.slice(eqIdx + 1),
        });
        continue;
      }
      currentWords.push(token.value);
      continue;
    }

    if (token.type === 'CMD_SUBST' || token.type === 'SUBSHELL_START' || token.type === 'SUBSHELL_END') {
      currentRaw.push(token.raw);
      currentWords.push(token.raw);
      continue;
    }
  }

  flushCommand();
  return commands;
}

/**
 * Top-level AST Parser: Converts shell command string to full AST & security analysis.
 */
export function parseShellAst(command: string): ShellParseResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      ast: { type: 'Program', raw: '' },
      segments: [],
      operators: [],
      commands: [],
      complex: false,
      hasSubshell: false,
      hasObfuscation: false,
      obfuscationReasons: [],
      error: 'Empty shell command.',
    };
  }

  const { tokens, error } = tokenizeShell(command);
  if (error) {
    return {
      ast: { type: 'Program', raw: command },
      segments: [],
      operators: [],
      commands: [],
      complex: true,
      hasSubshell: false,
      hasObfuscation: false,
      obfuscationReasons: [],
      error,
    };
  }

  const obfuscation = detectShellObfuscation(command);
  const commands = parseSimpleCommandsFromTokens(tokens);

  // Extract segments and operators
  const segments: string[] = [];
  const operators: string[] = [];
  let currentSegmentTokens: ShellToken[] = [];
  let complex = false;
  let hasSubshell = false;

  const flushSegment = (): boolean => {
    if (currentSegmentTokens.length === 0) return false;
    const segText = currentSegmentTokens.map((t) => t.raw).join(' ').trim();
    if (!segText) return false;
    segments.push(segText);
    currentSegmentTokens = [];
    return true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'EOF') break;

    if (token.type === 'CMD_SUBST' || token.type === 'SUBSHELL_START' || token.type === 'SUBSHELL_END') {
      complex = true;
      hasSubshell = true;
      currentSegmentTokens.push(token);
      continue;
    }

    if (token.type === 'REDIRECT') {
      complex = true;
      currentSegmentTokens.push(token);
      continue;
    }

    if (token.type === 'OPERATOR') {
      // Single & is background operator (complex)
      if (token.value === '&') {
        complex = true;
      }
      // Pipe | is complex (pipeline)
      if (token.value === '|') {
        complex = true;
      }

      if (!flushSegment()) {
        if (token.value === 'newline') continue;
        return {
          ast: { type: 'Program', raw: command },
          segments,
          operators,
          commands,
          complex: true,
          hasSubshell,
          hasObfuscation: obfuscation.isObfuscated,
          obfuscationReasons: obfuscation.reasons,
          error: 'Empty shell command segment.',
        };
      }
      operators.push(token.value);
      continue;
    }

    currentSegmentTokens.push(token);
  }

  flushSegment();

  if (segments.length === 0) {
    return {
      ast: { type: 'Program', raw: command },
      segments,
      operators,
      commands,
      complex,
      hasSubshell,
      hasObfuscation: obfuscation.isObfuscated,
      obfuscationReasons: obfuscation.reasons,
      error: 'No executable command segment.',
    };
  }

  if (obfuscation.isObfuscated) {
    complex = true;
  }

  // Build root AST node
  const ast: ShellAstNode = {
    type: 'Program',
    raw: command,
    children: commands.map((c) => ({
      type: 'SimpleCommand',
      raw: c.raw,
      command: c,
    })),
  };

  return {
    ast,
    segments,
    operators,
    commands,
    complex,
    hasSubshell,
    hasObfuscation: obfuscation.isObfuscated,
    obfuscationReasons: obfuscation.reasons,
  };
}
