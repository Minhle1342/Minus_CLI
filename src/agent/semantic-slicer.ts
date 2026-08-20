export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'method' | 'variable' | 'export';
  startLine: number;
  endLine: number;
  signature: string;
}

export interface FileOutline {
  path: string;
  totalLines: number;
  symbols: CodeSymbol[];
  summary: string;
}

/**
 * SemanticSlicer - Phân tích cú pháp ngữ nghĩa và trích xuất cấu trúc code (AST / Outline Slicing)
 * 
 * Giúp Coding Agent:
 * 1. Đọc lướt (Scan) các file 1.000 - 5.000 dòng để lấy sơ đồ Function/Class/Interface mà không tốn token.
 * 2. Cắt tỉa (Slice) chính xác phần thân của hàm/lớp đang cần sửa.
 * 3. Chuyển đổi nội dung file lớn thành bản tóm tắt có cấu trúc khi nén Session Context.
 */
export class SemanticSlicer {
  /**
   * Trích xuất danh mục symbols (Hàm, Lớp, Interface, Type) từ nội dung mã nguồn
   */
  static extractOutline(filePath: string, content: string): FileOutline {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const symbols: CodeSymbol[] = [];

    // Regex nhận diện các định nghĩa mã nguồn phổ biến (TypeScript, JavaScript, Python)
    const patterns = [
      { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/, kind: 'function' as const },
      { regex: /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends|\s+implements|\s*\{)/, kind: 'class' as const },
      { regex: /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)(?:\s+extends|\s*\{)/, kind: 'interface' as const },
      { regex: /^\s*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/, kind: 'type' as const },
      { regex: /^\s*(?:static\s+)?(?:async\s+)?([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/, kind: 'method' as const },
      { regex: /^\s*(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, kind: 'function' as const },
      { regex: /^\s*def\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\):/, kind: 'function' as const },
    ];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // Bỏ qua comment
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*') || line.trim().startsWith('#')) {
        continue;
      }

      for (const p of patterns) {
        const match = line.match(p.regex);
        if (match) {
          const symbolName = match[1];
          // Bỏ qua các từ khoá trùng lặp phổ biến trong block
          if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(symbolName)) {
            continue;
          }

          // Ước lượng endLine dựa trên cặp dấu ngoặc nhọn hoặc indent
          const endLine = this.estimateBlockEnd(lines, i);

          symbols.push({
            name: symbolName,
            kind: p.kind,
            startLine: lineNum,
            endLine,
            signature: line.trim().slice(0, 100),
          });
          break;
        }
      }
    }

    const summary = symbols.length > 0
      ? `File "${filePath}" (${totalLines} dòng) chứa ${symbols.length} symbols: ` +
        symbols.slice(0, 8).map((s) => `${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`).join(', ') +
        (symbols.length > 8 ? `... và ${symbols.length - 8} symbols khác.` : '.')
      : `File "${filePath}" (${totalLines} dòng). Không phát hiện symbols cấp cao.`;

    return {
      path: filePath,
      totalLines,
      symbols,
      summary,
    };
  }

  /**
   * Cắt lấy một cửa sổ mã nguồn bao quanh một symbol cụ thể
   */
  static sliceSymbol(content: string, symbolName: string): { found: boolean; code?: string; startLine?: number; endLine?: number } {
    const lines = content.split('\n');
    const outline = this.extractOutline('file', content);
    const target = outline.symbols.find((s) => s.name === symbolName);

    if (!target) {
      return { found: false };
    }

    const slicedLines = lines.slice(target.startLine - 1, target.endLine);
    return {
      found: true,
      code: slicedLines.join('\n'),
      startLine: target.startLine,
      endLine: target.endLine,
    };
  }

  /**
   * Ước lượng dòng kết thúc của một block mở ngoặc nhọn { ... }
   */
  private static estimateBlockEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '{') {
          braceCount++;
          foundOpenBrace = true;
        } else if (char === '}') {
          braceCount--;
        }
      }

      if (foundOpenBrace && braceCount <= 0) {
        return i + 1;
      }
    }

    // Nếu không có ngoặc (vd Python def), lấy đến dòng trống hoặc indent kế tiếp
    return Math.min(lines.length, startIndex + 20);
  }
}
