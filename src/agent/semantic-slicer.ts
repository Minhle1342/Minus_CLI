import ts from 'typescript';

export type SymbolParser = 'typescript-ast' | 'python-indentation' | 'heuristic';
export type ExtractionConfidence = 'high' | 'medium' | 'low';

export interface CodeSymbol {
  name: string;
  qualifiedName?: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'method' | 'variable' | 'export';
  startLine: number;
  endLine: number;
  signature: string;
  parser?: SymbolParser;
  confidence?: ExtractionConfidence;
}

export interface FileOutline {
  path: string;
  totalLines: number;
  symbols: CodeSymbol[];
  summary: string;
  parser: SymbolParser;
  confidence: ExtractionConfidence;
}

export interface SymbolSlice {
  found: boolean;
  code?: string;
  startLine?: number;
  endLine?: number;
  symbol?: CodeSymbol;
  parser: SymbolParser;
  confidence: ExtractionConfidence;
  complete: boolean;
  ambiguousMatches?: Array<Pick<CodeSymbol, 'name' | 'qualifiedName' | 'kind' | 'startLine' | 'endLine'>>;
}

interface ParsedSymbols {
  symbols: CodeSymbol[];
  parser: SymbolParser;
  confidence: ExtractionConfidence;
}

/**
 * Produces low-token outlines and exact symbol slices. TypeScript/JavaScript
 * use the compiler AST, Python uses indentation-aware declaration boundaries,
 * and unknown languages expose a lower-confidence heuristic fallback.
 */
export class SemanticSlicer {
  static extractOutline(filePath: string, content: string): FileOutline {
    const totalLines = content.split('\n').length;
    const parsed = this.parseSymbols(filePath, content);
    const { symbols } = parsed;
    const summary = symbols.length > 0
      ? `File "${filePath}" (${totalLines} dòng) chứa ${symbols.length} symbols [${parsed.parser}/${parsed.confidence}]: `
        + symbols.slice(0, 8).map((symbol) => `${symbol.kind} ${symbol.qualifiedName || symbol.name} (L${symbol.startLine}-${symbol.endLine})`).join(', ')
        + (symbols.length > 8 ? `... và ${symbols.length - 8} symbols khác.` : '.')
      : `File "${filePath}" (${totalLines} dòng). Không phát hiện symbols cấp cao [${parsed.parser}/${parsed.confidence}].`;

    return { path: filePath, totalLines, symbols, summary, parser: parsed.parser, confidence: parsed.confidence };
  }

  static sliceSymbol(content: string, symbolName: string, filePath = 'file.ts'): SymbolSlice {
    const lines = content.split('\n');
    const outline = this.extractOutline(filePath, content);
    const requested = symbolName.trim();
    const qualifiedMatches = outline.symbols.filter((symbol) => symbol.qualifiedName === requested);
    const nameMatches = outline.symbols.filter((symbol) => symbol.name === requested);
    const matches = qualifiedMatches.length > 0 ? qualifiedMatches : nameMatches;

    if (matches.length !== 1) {
      return {
        found: false,
        parser: outline.parser,
        confidence: outline.confidence,
        complete: false,
        ambiguousMatches: matches.length > 1
          ? matches.map(({ name, qualifiedName, kind, startLine, endLine }) => ({ name, qualifiedName, kind, startLine, endLine }))
          : undefined,
      };
    }

    const target = matches[0];
    return {
      found: true,
      code: lines.slice(target.startLine - 1, target.endLine).join('\n'),
      startLine: target.startLine,
      endLine: target.endLine,
      symbol: target,
      parser: outline.parser,
      confidence: outline.confidence,
      complete: outline.parser !== 'heuristic',
    };
  }

  private static parseSymbols(filePath: string, content: string): ParsedSymbols {
    const extension = filePath.toLowerCase().match(/\.[^.\\/]+$/)?.[0] || '';
    if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extension)) {
      return this.parseTypeScript(filePath, content);
    }
    if (extension === '.py') return this.parsePython(content);
    return this.parseHeuristically(content);
  }

  private static parseTypeScript(filePath: string, content: string): ParsedSymbols {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, this.scriptKindFor(filePath));
    const symbols: CodeSymbol[] = [];

    const addSymbol = (node: ts.Node, name: string, kind: CodeSymbol['kind'], owners: string[]): void => {
      const start = node.getStart(sourceFile, false);
      const end = node.getEnd();
      const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
      symbols.push({
        name,
        qualifiedName: owners.length > 0 ? [...owners, name].join('.') : name,
        kind,
        startLine,
        endLine,
        signature: this.compactSignature(content.slice(start, end)),
        parser: 'typescript-ast',
        confidence: 'high',
      });
    };

    const visit = (node: ts.Node, owners: string[]): void => {
      let childOwners = owners;
      if (ts.isFunctionDeclaration(node) && node.name) {
        addSymbol(node, node.name.text, 'function', owners);
      } else if (ts.isClassDeclaration(node) && node.name) {
        addSymbol(node, node.name.text, 'class', owners);
        childOwners = [...owners, node.name.text];
      } else if (ts.isInterfaceDeclaration(node)) {
        addSymbol(node, node.name.text, 'interface', owners);
        childOwners = [...owners, node.name.text];
      } else if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
        addSymbol(node, node.name.text, 'type', owners);
      } else if (
        (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
        && node.name
      ) {
        const name = this.propertyName(node.name, sourceFile);
        if (name) addSymbol(node, name, 'method', owners);
      } else if (ts.isPropertyDeclaration(node) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const name = this.propertyName(node.name, sourceFile);
        if (name) addSymbol(node, name, 'method', owners);
      } else if (ts.isVariableStatement(node) && (ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent))) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer
            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            addSymbol(node, declaration.name.text, 'function', owners);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, childOwners));
    };

    visit(sourceFile, []);
    symbols.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.name.localeCompare(b.name));
    return { symbols, parser: 'typescript-ast', confidence: 'high' };
  }

  private static parsePython(content: string): ParsedSymbols {
    const lines = content.split('\n');
    const raw: Array<CodeSymbol & { indent: number }> = [];
    const declaration = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*(?:->\s*[^:]+)?\s*:/;

    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(declaration);
      if (!match) continue;
      const indent = this.indentationWidth(match[1]);
      let endIndex = lines.length - 1;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const trimmed = lines[cursor].trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (this.indentationWidth(lines[cursor].match(/^\s*/)?.[0] || '') <= indent) {
          endIndex = cursor - 1;
          break;
        }
      }
      let startIndex = index;
      while (startIndex > 0 && lines[startIndex - 1].trimStart().startsWith('@')
        && this.indentationWidth(lines[startIndex - 1].match(/^\s*/)?.[0] || '') === indent) {
        startIndex--;
      }
      const isClass = lines[index].trimStart().startsWith('class ');
      raw.push({
        name: match[2],
        qualifiedName: match[2],
        kind: isClass ? 'class' : indent > 0 ? 'method' : 'function',
        startLine: startIndex + 1,
        endLine: Math.max(index + 1, endIndex + 1),
        signature: lines[index].trim(),
        parser: 'python-indentation',
        confidence: 'medium',
        indent,
      });
    }

    for (const symbol of raw) {
      const owner = raw
        .filter((candidate) => candidate.kind === 'class'
          && candidate.indent < symbol.indent
          && candidate.startLine <= symbol.startLine
          && candidate.endLine >= symbol.endLine)
        .sort((a, b) => b.indent - a.indent)[0];
      symbol.qualifiedName = owner ? `${owner.qualifiedName}.${symbol.name}` : symbol.name;
    }

    return {
      symbols: raw.map(({ indent: _indent, ...symbol }) => symbol),
      parser: 'python-indentation',
      confidence: 'medium',
    };
  }

  private static parseHeuristically(content: string): ParsedSymbols {
    const lines = content.split('\n');
    const symbols: CodeSymbol[] = [];
    const patterns = [
      { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/, kind: 'function' as const },
      { regex: /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/, kind: 'class' as const },
      { regex: /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/, kind: 'interface' as const },
      { regex: /^\s*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/, kind: 'type' as const },
    ];
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*(?:\/\/|\/\*|\*|#)/.test(lines[index])) continue;
      for (const pattern of patterns) {
        const match = lines[index].match(pattern.regex);
        if (!match) continue;
        const endLine = this.estimateBlockEnd(lines, index);
        symbols.push({
          name: match[1],
          qualifiedName: match[1],
          kind: pattern.kind,
          startLine: index + 1,
          endLine,
          signature: lines[index].trim().slice(0, 180),
          parser: 'heuristic',
          confidence: 'low',
        });
        break;
      }
    }
    return { symbols, parser: 'heuristic', confidence: 'low' };
  }

  private static compactSignature(source: string): string {
    const firstBody = source.indexOf('{');
    const signature = firstBody >= 0 ? source.slice(0, firstBody) : source;
    return signature.replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  private static propertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string | undefined {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return name.getText(sourceFile) || undefined;
  }

  private static scriptKindFor(filePath: string): ts.ScriptKind {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
  }

  private static indentationWidth(value: string): number {
    return [...value].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0);
  }

  private static estimateBlockEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;
    for (let index = startIndex; index < lines.length; index++) {
      for (const character of lines[index]) {
        if (character === '{') {
          braceCount++;
          foundOpenBrace = true;
        } else if (character === '}') {
          braceCount--;
        }
      }
      if (foundOpenBrace && braceCount <= 0) return index + 1;
    }
    return Math.min(lines.length, startIndex + 20);
  }
}
