import type { ControlRisk } from '../control/classification-types.js';
import type { Session } from '../session/session.js';

export interface ParetoEvidenceSnapshot {
  score: number;
  threshold: number;
  uncertainty: 'low' | 'medium' | 'high';
  reasons: string[];
  inspectedFiles: string[];
  hasFailureEvidence: boolean;
  hasDiagnosticEvidence: boolean;
  hasEmpiricalEvidence: boolean;
  hasSufficientEvidence: boolean;
}

export interface ParetoEvidenceInput {
  session: Session;
  turn: number;
  taskClass?: string;
  risk?: ControlRisk | string;
  hasPlan?: boolean;
  validatedHypothesisCount?: number;
  supportedHypothesisCount?: number;
}

function isFailure(result: Record<string, any>): boolean {
  return result.success === false
    || Boolean(result.error || result.errorCode)
    || (typeof result.exitCode === 'number' && result.exitCode !== 0);
}

function normalizePath(value: unknown): string {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

const NON_EMPIRICAL_EXECUTION_ERRORS = new Set([
  'COMMAND_NOT_FOUND',
  'COMMAND_NOT_EXECUTABLE',
  'COMMAND_TIMEOUT',
  'COMMAND_RESOURCE_LIMIT',
  'NATIVE_DEPENDENCY_MISSING',
  'PACKAGE_DEPENDENCY_MISSING',
  'MULTIPLE_RUNTIMES_REQUIRED',
  'RUNTIME_SANDBOX_INIT_FAILED',
]);

export function getParetoEvidenceThreshold(taskClass?: string, risk?: string): number {
  if (taskClass === 'security' || risk === 'R4' || risk === 'R5') return 6;
  if (risk === 'R3') return 5;
  if (risk === 'R2') return 3;
  return 2;
}

/** Collects durable evidence already observed in the current turn. */
export function assessParetoEvidence(input: ParetoEvidenceInput): ParetoEvidenceSnapshot {
  const calls = new Map<string, { toolName: string; args: Record<string, any> }>();
  const inspectedFiles = new Set<string>();
  const reasons = new Set<string>();
  let hasFailureEvidence = false;
  let hasDiagnosticEvidence = false;
  let hasEmpiricalEvidence = false;
  let currentTurn: number | undefined;

  for (const event of input.session.getEvents()) {
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn;
      calls.clear();
    }
    const eventTurn = event.data.turn ?? currentTurn;
    if (eventTurn !== input.turn) continue;
    if (event.type === 'tool/call' && event.data.toolCallId) {
      calls.set(event.data.toolCallId, {
        toolName: String(event.data.toolName || ''),
        args: event.data.args || {},
      });
      continue;
    }
    if (event.type !== 'tool/result') continue;
    const call = event.data.toolCallId ? calls.get(event.data.toolCallId) : undefined;
    const toolName = call?.toolName || String(event.data.toolName || '');
    const args = call?.args || {};
    const result = (event.data.result || {}) as Record<string, any>;
    const failed = isFailure(result);

    if (['read_file', 'read_compressed_code'].includes(toolName) && !failed) {
      const target = normalizePath(args.path || args.filePath || result.path);
      if (target) inspectedFiles.add(target);
    }
    if (['inspect_symbol', 'get_symbol_context_360', 'query_call_graph', 'analyze_symbol_flow'].includes(toolName) && !failed) {
      reasons.add('STRUCTURAL_EVIDENCE');
    }
    if (toolName === 'get_diagnostics' && !failed && (result.totalErrors > 0 || result.clean === false)) {
      hasDiagnosticEvidence = true;
      reasons.add('DIAGNOSTIC_EVIDENCE');
    }
    if (toolName === 'run_command' && /(?:test|pytest|jest|vitest|mocha|cargo test|go test|gradle test|mvn test)/i.test(String(args.command || ''))) {
      if (NON_EMPIRICAL_EXECUTION_ERRORS.has(String(result.errorCode || ''))) {
        reasons.add('EXECUTION_ENVIRONMENT_FAILURE');
        continue;
      }
      hasEmpiricalEvidence = true;
      if (failed) {
        hasFailureEvidence = true;
        reasons.add('FAILING_REPRODUCTION');
      } else {
        reasons.add('PASSING_VERIFICATION');
      }
    }
    if (toolName === 'formulate_and_verify_hypothesis' && result.status === 'validated') {
      hasEmpiricalEvidence = true;
      reasons.add('EMPIRICALLY_VALIDATED_HYPOTHESIS');
    }
  }

  let score = 0;
  if (input.hasPlan) {
    score += 1;
    reasons.add('ACTIVE_PLAN');
  }
  if ((input.supportedHypothesisCount || 0) > 0) {
    score += 2;
    reasons.add('SUPPORTED_HYPOTHESIS');
  }
  if ((input.validatedHypothesisCount || 0) > 0) {
    score += 6;
    hasEmpiricalEvidence = true;
    reasons.add('EMPIRICALLY_VALIDATED_HYPOTHESIS');
  }
  if (hasFailureEvidence) score += 3;
  if (hasDiagnosticEvidence) score += 2;
  if (reasons.has('STRUCTURAL_EVIDENCE')) score += 1;

  const threshold = getParetoEvidenceThreshold(input.taskClass, input.risk);
  const ratio = score / Math.max(1, threshold);
  return {
    score,
    threshold,
    uncertainty: ratio >= 1 ? 'low' : ratio >= 0.5 ? 'medium' : 'high',
    reasons: Array.from(reasons),
    inspectedFiles: Array.from(inspectedFiles),
    hasFailureEvidence,
    hasDiagnosticEvidence,
    hasEmpiricalEvidence,
    hasSufficientEvidence: score >= threshold,
  };
}
