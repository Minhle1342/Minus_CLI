import type { DiagnosticSnapshot, ChangedFileState } from '../control-plane-state.js';
import { hasUnfulfilledDeferredPromise, isCompletionStub } from '../../agent/final-answer-guard.js';

export class AcceptancePolicy {
  /**
   * Evaluates hard safety invariants.
   * Returns any fatal violations that immediately force score = 0 and reject candidate.
   */
  static checkHardInvariants(params: {
    diagnostics: DiagnosticSnapshot;
    changedFiles: ChangedFileState[];
    registeredFiles?: string[];
    finalAnswerText?: string;
  }): { passed: boolean; violations: string[] } {
    const violations: string[] = [];

    // 1. Anti-Hallucination & Anti-Deferred Work checks on Final Answer
    if (params.finalAnswerText !== undefined) {
      const trimmed = params.finalAnswerText.trim();
      if (!trimmed) {
        violations.push('Empty final response received. Must execute a tool or provide substantive explanation.');
      } else {
        const hasDeferred = hasUnfulfilledDeferredPromise(trimmed) || isCompletionStub(trimmed);
        if (hasDeferred) {
          violations.push(
            'Provide the actual answer or continue only the user-authorized work still needed; do not substitute a status stub or deferred promise.',
          );
        }
      }
    }

    // 2. Unresolved compiler/syntax errors
    const normalized = (file: string) => file.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const changed = new Set(params.changedFiles.map(file => normalized(file.path)));
    const targeted = (items: DiagnosticSnapshot['errors']) => items.filter(item => changed.has(normalized(item.file)));
    const errors = targeted(params.diagnostics.errors);
    const syntaxErrors = targeted(params.diagnostics.syntaxErrors);
    const unresolvedImports = targeted(params.diagnostics.unresolvedImports);
    if (errors.length > 0) {
      violations.push(
        `Found ${errors.length} unresolved compiler error(s) in changed files.`,
      );
    }
    if (syntaxErrors.length > 0) {
      violations.push(
        `Found ${syntaxErrors.length} syntax error(s) in changed files.`,
      );
    }
    if (unresolvedImports.length > 0) {
      violations.push(
        `Found ${unresolvedImports.length} missing import / undefined name error(s) in changed files.`,
      );
    }

    // 3. Unregistered files in restricted scopes
    if (params.registeredFiles && params.registeredFiles.length > 0) {
      const unregistered = params.changedFiles.filter(
        (f) =>
          !params.registeredFiles!.some(
            (reg) => f.path === reg || f.path.startsWith(`${reg.replace(/\/$/, '')}/`),
          ),
      );
      if (unregistered.length > 0) {
        violations.push(
          `Mutated files outside registered scope: ${unregistered.map((u) => u.path).join(', ')}`,
        );
      }
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }
}
