import { getNativeCore } from '../native/index.js';
import { parseShellAst, ShellAstNode, ShellSimpleCommand } from './shell-ast-parser.js';

export interface ShellAnalysis {
  segments: string[];
  operators: string[];
  complex: boolean;
  error?: string;
  ast?: ShellAstNode;
  commands?: ShellSimpleCommand[];
  hasSubshell?: boolean;
  hasObfuscation?: boolean;
  obfuscationReasons?: string[];
}

/** Quote-aware AST segmentation; substitutions and groups are marked complex for fail-closed policy. */
export function analyzeShellCommand(command: string): ShellAnalysis {
  // 1. Phân tích cú pháp bằng AST Parser chuẩn POSIX/Bash
  const astResult = parseShellAst(command);

  // 2. Tận dụng Rust Native Core nếu có để so khớp siêu tốc, áp dụng chiến lược Phòng thủ Chiều sâu (Defense-in-Depth)
  const native = getNativeCore();
  let nativeRes: { segments: string[]; operators: string[]; complex: boolean; error?: string } | undefined;
  if (native) {
    try {
      const res = native.rsAnalyzeShellCommand(command);
      nativeRes = {
        segments: res.segments,
        operators: res.operators,
        complex: res.complex,
        error: res.error || undefined,
      };
    } catch {
      // Fallback sang AST Parser thuần
    }
  }

  // 3. Hợp nhất kết quả với quy tắc Fail-Closed:
  if (astResult.error) {
    return {
      segments: astResult.segments,
      operators: astResult.operators,
      complex: true,
      error: astResult.error,
      ast: astResult.ast,
      commands: astResult.commands,
      hasSubshell: astResult.hasSubshell,
      hasObfuscation: astResult.hasObfuscation,
      obfuscationReasons: astResult.obfuscationReasons,
    };
  }

  if (nativeRes?.error) {
    return {
      segments: nativeRes.segments.length > 0 ? nativeRes.segments : astResult.segments,
      operators: nativeRes.operators.length > 0 ? nativeRes.operators : astResult.operators,
      complex: true,
      error: nativeRes.error,
      ast: astResult.ast,
      commands: astResult.commands,
      hasSubshell: astResult.hasSubshell,
      hasObfuscation: astResult.hasObfuscation,
      obfuscationReasons: astResult.obfuscationReasons,
    };
  }

  // Bất kỳ lớp nào (AST Parser hoặc Native Core) phát hiện dấu hiệu nguy hiểm/phức tạp
  // (subshell, redirect, background &, obfuscation) -> Phải đánh dấu complex = true
  const isComplex = astResult.complex || Boolean(nativeRes?.complex);

  const segments = astResult.segments.length > 0 ? astResult.segments : (nativeRes?.segments || []);
  const operators = astResult.operators.length > 0 ? astResult.operators : (nativeRes?.operators || []);

  return {
    segments,
    operators,
    complex: isComplex,
    ast: astResult.ast,
    commands: astResult.commands,
    hasSubshell: astResult.hasSubshell,
    hasObfuscation: astResult.hasObfuscation,
    obfuscationReasons: astResult.obfuscationReasons,
  };
}
