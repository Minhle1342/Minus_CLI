import type { Workspace } from '../workspace/workspace.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';

export interface ExtractedErrorItem {
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'generic';
  file?: string;
  line?: number;
  column?: number;
  errorCode?: string;
  errorType?: string;
  message: string;
  rawSnippet?: string;
}

export type ErrorPatternCategory =
  | 'NULL_DEREFERENCE'
  | 'MISSING_IMPORT_OR_SYMBOL'
  | 'SIGNATURE_MISMATCH'
  | 'TYPE_INCOMPATIBILITY'
  | 'SYNTAX_OR_PARSING'
  | 'ASSERTION_FAILURE'
  | 'MODULE_RESOLUTION'
  | 'RUNTIME_PANIC'
  | 'ENVIRONMENT_MISCONFIG';

export interface ErrorDetectiveReport {
  extractedErrors: ExtractedErrorItem[];
  primaryDefect?: string;
  location?: string;
  pattern?: ErrorPatternCategory;
  rootCause?: string;
  cascadingChain?: string[];
  suggestedRead?: { path: string; startLine?: number; endLine?: number };
  immediateFix?: string;
  prevention?: string;
  promptGuidance?: string;
}

/**
 * ErrorDetective - Deep Log Analysis, Multi-Language Stack Trace Parser & Causal Root Cause Analyzer
 * 
 * Implements the Error Detective methodology:
 * 1. Log Parsing: Regex pattern extraction for TS/JS, Python, Go, Rust, and test assertion failures.
 * 2. Causal Backward Tracing: Separates surface symptoms from upstream root causes (cascading failure detection).
 * 3. Anti-Pattern Classification: Identifies null dereferences, missing imports, signature drift, etc.
 * 4. Actionable Remediation: Provides concrete file locations, line ranges, and prevention guidance.
 */
export class ErrorDetective {
  /**
   * Main entry point to investigate raw stderr/stdout and synthesize a causal report
   */
  investigate(
    rawText: string,
    workspace?: Workspace,
    recentlyMutatedFiles: string[] = [],
  ): ErrorDetectiveReport {
    const text = rawText || '';
    const extractedErrors: ExtractedErrorItem[] = [];

    // 1. Extract TypeScript / JavaScript Compiler Errors (TSxxxx)
    const tsErrors = this.extractTypeScriptCompilerErrors(text);
    extractedErrors.push(...tsErrors);

    // 2. Extract Node.js / V8 Runtime Stack Traces
    const runtimeErrors = this.extractNodeRuntimeExceptions(text);
    extractedErrors.push(...runtimeErrors);

    // 3. Extract Python Tracebacks
    const pythonErrors = this.extractPythonTracebacks(text);
    extractedErrors.push(...pythonErrors);

    // 4. Extract Test Runner Assertion Failures (Jest, Vitest, Mocha, Node:test)
    const testAssertionErrors = this.extractTestAssertions(text);
    extractedErrors.push(...testAssertionErrors);

    // 5. Extract Go & Rust Errors
    const goRustErrors = this.extractGoRustErrors(text);
    extractedErrors.push(...goRustErrors);

    // If no specific patterns match, extract generic error lines
    if (extractedErrors.length === 0) {
      const generic = this.extractGenericErrors(text);
      if (generic) extractedErrors.push(generic);
    }

    // Select primary defect (prefer compiler/runtime errors on recently mutated files)
    const primary = this.selectPrimaryDefect(extractedErrors, recentlyMutatedFiles);

    // Classify anti-pattern category
    const pattern = this.classifyPattern(primary, text);

    // Perform backward causal analysis
    const causalAnalysis = this.analyzeCausality(primary, pattern, recentlyMutatedFiles, text);

    // Construct high-signal prompt guidance
    const promptGuidance = this.buildPromptGuidance({
      primary,
      pattern,
      causalAnalysis,
      extractedErrors,
    });

    const locationStr = primary?.file
      ? `${primary.file}${primary.line ? `:${primary.line}${primary.column ? `:${primary.column}` : ''}` : ''}`
      : undefined;

    return {
      extractedErrors,
      primaryDefect: primary ? `${primary.errorType || primary.errorCode || 'Error'}: ${primary.message}` : undefined,
      location: locationStr,
      pattern,
      rootCause: causalAnalysis.rootCause,
      cascadingChain: causalAnalysis.cascadingChain,
      suggestedRead: primary?.file && primary.line
        ? {
            path: primary.file,
            startLine: Math.max(1, primary.line - 10),
            endLine: primary.line + 15,
          }
        : undefined,
      immediateFix: causalAnalysis.immediateFix,
      prevention: causalAnalysis.prevention,
      promptGuidance,
    };
  }

  /**
   * Converts ExtractedErrorItem list into standard DiagnosticItem format
   */
  toDiagnosticItems(errors: ExtractedErrorItem[]): DiagnosticItem[] {
    return errors
      .filter((e) => Boolean(e.file))
      .map((e) => {
        const codeNum = e.errorCode ? parseInt(e.errorCode.replace(/[^\d]/g, ''), 10) || 0 : 0;
        return {
          file: e.file!,
          line: e.line || 1,
          character: e.column || 0,
          code: codeNum,
          category: 'error' as const,
          message: `[${e.errorCode || e.errorType || 'ERROR'}] ${e.message}`,
        };
      });
  }

  // =========================================================================
  // Extraction Engines
  // =========================================================================

  private extractTypeScriptCompilerErrors(text: string): ExtractedErrorItem[] {
    const results: ExtractedErrorItem[] = [];

    // Format 1: file.ts(line,col): error TSxxxx: message
    const regex1 = /([a-zA-Z0-9_\-\/\.\\]+\.tsx?)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.+)/g;
    let match;
    while ((match = regex1.exec(text)) !== null) {
      const [, file, line, col, code, message] = match;
      results.push({
        language: 'typescript',
        file: normalizeFilePath(file),
        line: parseInt(line, 10),
        column: parseInt(col, 10),
        errorCode: code,
        message: message.trim(),
        rawSnippet: match[0],
      });
    }

    // Format 2: file.ts:line:col - error TSxxxx: message
    const regex2 = /([a-zA-Z0-9_\-\/\.\\]+\.tsx?):(\d+):(\d+)\s*-\s*error\s*(TS\d+):\s*(.+)/g;
    while ((match = regex2.exec(text)) !== null) {
      const [, file, line, col, code, message] = match;
      results.push({
        language: 'typescript',
        file: normalizeFilePath(file),
        line: parseInt(line, 10),
        column: parseInt(col, 10),
        errorCode: code,
        message: message.trim(),
        rawSnippet: match[0],
      });
    }

    return results;
  }

  private extractNodeRuntimeExceptions(text: string): ExtractedErrorItem[] {
    const results: ExtractedErrorItem[] = [];

    // Match: ErrorName: message \n at ...
    const errRegex = /(?:^|\n)(TypeError|ReferenceError|SyntaxError|RangeError|URIError|AssertionError|Error):\s*([^\n]+)/g;
    let errMatch;

    while ((errMatch = errRegex.exec(text)) !== null) {
      const [, errorType, message] = errMatch;
      const startIndex = errMatch.index;
      const snippet = text.slice(startIndex, startIndex + 600);

      // Find call sites in stack trace
      const callSiteRegex = /at\s+(?:([^\s(]+)\s+\()?([a-zA-Z0-9_\-\/\.\\]+\.[jt]sx?):(\d+):(\d+)\)?/;
      const callSiteMatch = callSiteRegex.exec(snippet);

      results.push({
        language: 'javascript',
        errorType,
        message: message.trim(),
        file: callSiteMatch ? normalizeFilePath(callSiteMatch[2]) : undefined,
        line: callSiteMatch ? parseInt(callSiteMatch[3], 10) : undefined,
        column: callSiteMatch ? parseInt(callSiteMatch[4], 10) : undefined,
        rawSnippet: errMatch[0],
      });
    }

    return results;
  }

  private extractPythonTracebacks(text: string): ExtractedErrorItem[] {
    const results: ExtractedErrorItem[] = [];
    if (!text.includes('Traceback (most recent call last):')) return results;

    const fileLineRegex = /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+([^\n]+))?/g;
    const fileMatches: Array<{ file: string; line: number; func?: string }> = [];
    let match;
    while ((match = fileLineRegex.exec(text)) !== null) {
      fileMatches.push({
        file: normalizeFilePath(match[1]),
        line: parseInt(match[2], 10),
        func: match[3],
      });
    }

    const exRegex = /(?:^|\n)([a-zA-Z0-9_]+Error|[a-zA-Z0-9_]+Exception):\s*([^\n]+)/g;
    let exMatch;
    while ((exMatch = exRegex.exec(text)) !== null) {
      const [, errorType, message] = exMatch;
      // The deepest frame in Python traceback is usually the root fault site
      const deepestFrame = fileMatches[fileMatches.length - 1];

      results.push({
        language: 'python',
        errorType,
        message: message.trim(),
        file: deepestFrame?.file,
        line: deepestFrame?.line,
        rawSnippet: exMatch[0],
      });
    }

    return results;
  }

  private extractTestAssertions(text: string): ExtractedErrorItem[] {
    const results: ExtractedErrorItem[] = [];

    // Vitest / Jest Expected vs Received
    if (text.includes('Expected:') && text.includes('Received:')) {
      const expMatch = /Expected:\s*([^\n]+)/.exec(text);
      const recMatch = /Received:\s*([^\n]+)/.exec(text);
      const fileMatch = /at\s+([^\s]+)\s+\(([a-zA-Z0-9_\-\/\.\\]+\.[jt]sx?):(\d+):(\d+)\)/.exec(text);

      results.push({
        language: 'typescript',
        errorType: 'AssertionError',
        message: `Expected "${expMatch?.[1]?.trim() || '...'}" but received "${recMatch?.[1]?.trim() || '...'}"`,
        file: fileMatch ? normalizeFilePath(fileMatch[2]) : undefined,
        line: fileMatch ? parseInt(fileMatch[3], 10) : undefined,
        column: fileMatch ? parseInt(fileMatch[4], 10) : undefined,
      });
    }

    // Node assert / Chai
    const assertMatch = /AssertionError(?:\s*\[ERR_ASSERTION\])?:\s*([^\n]+)/.exec(text);
    if (assertMatch && results.length === 0) {
      const fileMatch = /at\s+.*?([a-zA-Z0-9_\-\/\.\\]+\.[jt]sx?):(\d+):(\d+)/.exec(text);
      results.push({
        language: 'javascript',
        errorType: 'AssertionError',
        message: assertMatch[1].trim(),
        file: fileMatch ? normalizeFilePath(fileMatch[1]) : undefined,
        line: fileMatch ? parseInt(fileMatch[2], 10) : undefined,
        column: fileMatch ? parseInt(fileMatch[3], 10) : undefined,
      });
    }

    return results;
  }

  private extractGoRustErrors(text: string): ExtractedErrorItem[] {
    const results: ExtractedErrorItem[] = [];

    // Go: file.go:line:col: message
    const goRegex = /([a-zA-Z0-9_\-\/\.]+\.go):(\d+):(\d+):\s*(.+)/g;
    let match;
    while ((match = goRegex.exec(text)) !== null) {
      results.push({
        language: 'go',
        file: normalizeFilePath(match[1]),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: match[4].trim(),
      });
    }

    // Rust: error[E0425]: ... --> src/main.rs:12:34
    const rustRegex = /error\[(E\d+)\]:\s*([^\n]+)[\s\S]*?-->\s*([a-zA-Z0-9_\-\/\.]+\.rs):(\d+):(\d+)/g;
    while ((match = rustRegex.exec(text)) !== null) {
      results.push({
        language: 'rust',
        errorCode: match[1],
        message: match[2].trim(),
        file: normalizeFilePath(match[3]),
        line: parseInt(match[4], 10),
        column: parseInt(match[5], 10),
      });
    }

    return results;
  }

  private extractGenericErrors(text: string): ExtractedErrorItem | undefined {
    const errorLineRegex = /(?:error|failed|fatal|exception):\s*([^\n]{5,150})/i;
    const match = errorLineRegex.exec(text);
    if (match) {
      return {
        language: 'generic',
        message: match[1].trim(),
      };
    }
    return undefined;
  }

  // =========================================================================
  // Classification & Causal Analysis
  // =========================================================================

  private selectPrimaryDefect(
    errors: ExtractedErrorItem[],
    mutatedFiles: string[],
  ): ExtractedErrorItem | undefined {
    if (errors.length === 0) return undefined;

    // Priority 1: Error on a file recently touched
    const onTouch = errors.find((e) => e.file && mutatedFiles.some((m) => e.file?.includes(m) || m.includes(e.file!)));
    if (onTouch) return onTouch;

    // Priority 2: Compiler error with specific code
    const compiler = errors.find((e) => Boolean(e.errorCode));
    if (compiler) return compiler;

    // Priority 3: Runtime error with location
    const withLoc = errors.find((e) => Boolean(e.file && e.line));
    if (withLoc) return withLoc;

    return errors[0];
  }

  private classifyPattern(
    primary?: ExtractedErrorItem,
    fullText = '',
  ): ErrorPatternCategory {
    const msg = `${primary?.message || ''} ${primary?.errorType || ''} ${primary?.errorCode || ''} ${fullText}`.toLowerCase();

    if (
      msg.includes('cannot read propert')
      || msg.includes('is undefined')
      || msg.includes('is null')
      || msg.includes('nullpointer')
      || msg.includes('none type')
      || msg.includes('attributeerror: \'none\'')
    ) {
      return 'NULL_DEREFERENCE';
    }

    if (
      msg.includes('cannot find name')
      || msg.includes('not defined')
      || msg.includes('nameerror')
      || msg.includes('ts2304')
      || msg.includes('ts2552')
      || msg.includes('undefined symbol')
      || msg.includes('cannot find value')
    ) {
      return 'MISSING_IMPORT_OR_SYMBOL';
    }

    if (
      msg.includes('expected') && (msg.includes('arguments') || msg.includes('parameters'))
      || msg.includes('takes') && msg.includes('positional arguments')
      || msg.includes('ts2554')
    ) {
      return 'SIGNATURE_MISMATCH';
    }

    if (
      msg.includes('is not assignable to')
      || msg.includes('type mismatch')
      || msg.includes('typeerror')
      || msg.includes('ts2322')
    ) {
      return 'TYPE_INCOMPATIBILITY';
    }

    if (
      msg.includes('cannot find module')
      || msg.includes('modulenotfounderror')
      || msg.includes('no such file or directory')
      || msg.includes('ts2307')
    ) {
      return 'MODULE_RESOLUTION';
    }

    if (
      msg.includes('assertionerror')
      || msg.includes('expected') && msg.includes('received')
    ) {
      return 'ASSERTION_FAILURE';
    }

    if (msg.includes('panic:') || msg.includes('fatal error:')) {
      return 'RUNTIME_PANIC';
    }

    if (msg.includes('syntaxerror') || msg.includes('parsing error')) {
      return 'SYNTAX_OR_PARSING';
    }

    return 'ENVIRONMENT_MISCONFIG';
  }

  private analyzeCausality(
    primary?: ExtractedErrorItem,
    pattern?: ErrorPatternCategory,
    mutatedFiles: string[] = [],
    fullText = '',
  ): {
    rootCause: string;
    cascadingChain: string[];
    immediateFix: string;
    prevention: string;
  } {
    const file = primary?.file || 'the modified file';
    const loc = primary?.line ? `${file}:${primary.line}` : file;

    switch (pattern) {
      case 'MISSING_IMPORT_OR_SYMBOL':
        return {
          rootCause: `Symbol referenced at ${loc} without being imported or declared in scope.`,
          cascadingChain: [
            `1. Symbol missing in local scope at ${loc}.`,
            `2. Compiler/interpreter abruptly halts evaluation.`,
          ],
          immediateFix: `Inspect imports at top of ${file}. Add required export/import statement.`,
          prevention: `Run LSP type checking ("npm run build" or "tsc --noEmit") before completing.`,
        };

      case 'NULL_DEREFERENCE':
        return {
          rootCause: `Accessing nested property or method on undefined/null object at ${loc}. Downstream symptom of an upstream function returning null without a guard.`,
          cascadingChain: [
            `1. Upstream call returns undefined/null (e.g. not found, empty payload, async timing).`,
            `2. Intermediate function passes value without checking validity.`,
            `3. Crash occurs downstream at ${loc} when dereferencing property.`,
          ],
          immediateFix: `Use optional chaining (?.) or add early return guard "if (!obj) return ..." in ${file}.`,
          prevention: `Enable strictNullChecks in tsconfig.json and write test cases for null/missing edge cases.`,
        };

      case 'SIGNATURE_MISMATCH':
        return {
          rootCause: `Caller arguments count or parameter types do not match the target declaration signature at ${loc}.`,
          cascadingChain: [
            `1. Function signature was refactored or called with obsolete argument shape.`,
            `2. Typechecker/runtime rejects invocation.`,
          ],
          immediateFix: `Use "inspect_symbol" to inspect target function signature and update callsite arguments in ${file}.`,
          prevention: `Verify all callers with "find_references" when modifying function signatures.`,
        };

      case 'ASSERTION_FAILURE':
        return {
          rootCause: `Output state returned by business logic diverges from unit test expectations at ${loc}.`,
          cascadingChain: [
            `1. Logic implementation returned unexpected value.`,
            `2. Test assertion detected contract violation.`,
          ],
          immediateFix: `Read ${loc} using read_file to inspect expected vs received values. Fix the return logic.`,
          prevention: `DO NOT comment out or delete failing assertions; fix the underlying business logic.`,
        };

      case 'MODULE_RESOLUTION':
        return {
          rootCause: `Module path cannot be resolved from ${file}. Incorrect relative path or missing dependency.`,
          cascadingChain: [
            `1. Import path does not point to an existing file on disk.`,
            `2. Bundler/compiler fails module resolution.`,
          ],
          immediateFix: `Verify relative path (.js/.ts extension) or check package.json dependencies.`,
          prevention: `Ensure paths use project relative conventions and run "npm run build".`,
        };

      default:
        return {
          rootCause: `Execution failed at ${loc}: ${primary?.message || 'Error encountered'}.`,
          cascadingChain: [
            `1. Triggered in ${file}.`,
            `2. Execution aborted with non-zero exit code.`,
          ],
          immediateFix: `Read target source lines around ${loc} and repair the defective statement.`,
          prevention: `Verify with regression test before declaring completion.`,
        };
    }
  }

  private buildPromptGuidance(params: {
    primary?: ExtractedErrorItem;
    pattern?: ErrorPatternCategory;
    causalAnalysis: {
      rootCause: string;
      cascadingChain: string[];
      immediateFix: string;
      prevention: string;
    };
    extractedErrors: ExtractedErrorItem[];
  }): string {
    const { primary, pattern, causalAnalysis, extractedErrors } = params;
    const lines: string[] = [
      `\n🕵️ [ERROR DETECTIVE - CAUSAL ROOT CAUSE ANALYSIS ACTIVATED]:`,
    ];

    if (primary) {
      lines.push(
        `1. [SURFACE SYMPTOM]: ${primary.errorType || primary.errorCode || 'Error'}: ${primary.message}`,
        primary.file ? `   📍 Location: ${primary.file}${primary.line ? `:${primary.line}:${primary.column || 0}` : ''}` : '',
        `2. [ANTI-PATTERN DETECTED]: ${pattern || 'GENERIC_FAILURE'}`,
        `3. [BACKWARD CAUSAL TRACE (ROOT CAUSE)]:`,
        `   • Root Cause: ${causalAnalysis.rootCause}`,
        ...causalAnalysis.cascadingChain.map((c) => `   ${c}`),
        `4. [ACTIONABLE REPAIR PROTOCOL]:`,
        `   👉 Immediate Fix: ${causalAnalysis.immediateFix}`,
        `   🛡️ Prevention: ${causalAnalysis.prevention}`,
      );
    }

    if (extractedErrors.length > 1) {
      lines.push(`\n5. [ADDITIONAL CORRELATED DEFECTS (${extractedErrors.length - 1})]:`);
      for (const err of extractedErrors.slice(1, 5)) {
        lines.push(`   • [${err.errorCode || err.errorType || 'ERROR'}] ${err.file || 'unknown'}:${err.line || 0} - ${err.message}`);
      }
    }

    lines.push(`\n👉 MANDATORY INVARIANT: Do not perform superficial monkey-patching! Address the root cause identified above.`);

    return lines.filter(Boolean).join('\n');
  }
}

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
