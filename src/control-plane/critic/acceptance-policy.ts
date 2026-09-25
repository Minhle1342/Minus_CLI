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
            'Deferred action promise detected in response ("I will modify/Tôi sẽ tiến hành..."). You must execute the necessary tool immediately rather than promising to do it later.',
          );
        }
      }
    }

    // 2. Unresolved compiler/syntax errors
    if (params.diagnostics.errors.length > 0) {
      violations.push(
        `Found ${params.diagnostics.errors.length} unresolved compiler error(s).`,
      );
    }
    if (params.diagnostics.syntaxErrors.length > 0) {
      violations.push(
        `Found ${params.diagnostics.syntaxErrors.length} syntax error(s).`,
      );
    }
    if (params.diagnostics.unresolvedImports.length > 0) {
      violations.push(
        `Found ${params.diagnostics.unresolvedImports.length} missing import / undefined name error(s).`,
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
