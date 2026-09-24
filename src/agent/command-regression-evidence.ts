import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Session } from '../session/session.js';
import type { Workspace } from '../workspace/workspace.js';

export interface CommandDiagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
  sourceHash?: string;
}

export interface CommandBaseline {
  command: string;
  turn: number;
  resultSeq: number;
  exitCode: number;
  sandbox?: string;
  executionTarget?: string;
  complete: boolean;
  diagnostics: CommandDiagnostic[];
}

export interface CommandRegressionEvidence {
  classification: 'pre_existing_out_of_scope' | 'new_failures_detected' | 'undetermined';
  reason: string;
  baselineResultSeq?: number;
  preExisting: CommandDiagnostic[];
  newFailures: CommandDiagnostic[];
}

const MAX_DIAGNOSTICS = 30;

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function fingerprint(item: CommandDiagnostic): string {
  return `${item.file.toLowerCase()}:${item.line}:${item.code}:${item.message}`;
}

function normalizePath(workspace: Workspace, file: string): string | undefined {
  try {
    const absolute = workspace.resolveSafePath(file);
    const relative = path.relative(workspace.rootDir, absolute).replace(/\\/g, '/');
    return relative && !relative.startsWith('..') ? relative : undefined;
  } catch {
    return undefined;
  }
}

/** Deliberately strict: unsupported test formats remain unknown rather than being certified as green. */
export function parseTypeScriptDiagnostics(result: Record<string, any>, workspace: Workspace): CommandDiagnostic[] {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const diagnostics: CommandDiagnostic[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?\.[cm]?[jt]sx?)(?:\((\d+),\d+\)|:(\d+):\d+)\s*:?\s*-?\s*error\s+(TS\d+):\s*(.+?)\s*$/i);
    if (!match) continue;
    const file = normalizePath(workspace, match[1]);
    if (!file) continue;
    const item = { file, line: Number(match[2] || match[3]), code: match[4].toUpperCase(), message: match[5].trim().replace(/\s+/g, ' ') };
    const key = fingerprint(item);
    if (!seen.has(key)) {
      diagnostics.push(item);
      seen.add(key);
    }
  }
  return diagnostics;
}

async function sourceHash(workspace: Workspace, file: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await fs.readFile(workspace.resolveSafePath(file))).digest('hex');
  } catch {
    return undefined;
  }
}

function completeOutput(result: Record<string, any>): boolean {
  return result.verificationOutputComplete !== false && !result.logFilePath && !result.savedTokensEstimate
    && result.commandOutcome !== 'blocked_preflight'
    && typeof result.exitCode === 'number';
}

export async function captureCommandBaseline(
  session: Session,
  turn: number,
  command: string,
  result: Record<string, any>,
  workspace: Workspace,
): Promise<CommandBaseline | undefined> {
  if (!completeOutput(result)) return undefined;
  const diagnostics = parseTypeScriptDiagnostics(result, workspace);
  const withHashes = await Promise.all(diagnostics.slice(0, MAX_DIAGNOSTICS)
    .map(async (item) => ({ ...item, sourceHash: await sourceHash(workspace, item.file) })));
  const baseline: CommandBaseline = {
    command: normalizeCommand(command), turn, resultSeq: session.seq, exitCode: result.exitCode,
    ...(result.sandbox ? { sandbox: String(result.sandbox) } : {}),
    ...(result.executionTarget ? { executionTarget: String(result.executionTarget) } : {}),
    complete: diagnostics.length <= MAX_DIAGNOSTICS
      && (result.exitCode === 0 ? diagnostics.length === 0 : diagnostics.length > 0)
      && withHashes.every((item) => Boolean(item.sourceHash)),
    diagnostics: withHashes,
  };
  session.append('control/decision', { turn, controlDecision: { commandBaseline: baseline } });
  return baseline;
}

/** Never label a failure out-of-scope without a matching pre-edit run and unchanged failing source. */
export async function attributeCommandFailure(
  session: Session,
  turn: number,
  command: string,
  result: Record<string, any>,
  workspace: Workspace,
  modifiedFiles: string[],
  latestMutationSeq: number,
): Promise<CommandRegressionEvidence> {
  const unknown = (reason: string, baselineResultSeq?: number): CommandRegressionEvidence => ({
    classification: 'undetermined', reason, ...(baselineResultSeq ? { baselineResultSeq } : {}), preExisting: [], newFailures: [],
  });
  const baseline = session.getEvents().reverse().find((event) => event.type === 'control/decision'
    && event.data.turn === turn && event.data.controlDecision?.commandBaseline?.command === normalizeCommand(command))
    ?.data.controlDecision?.commandBaseline as CommandBaseline | undefined;
  if (!baseline) return unknown('No observation of this exact command before the first task mutation. The failure cannot be attributed safely.');
  if (latestMutationSeq <= baseline.resultSeq) {
    return unknown('The matching command was not observed before the latest task mutation.', baseline.resultSeq);
  }
  if (!baseline.complete || !completeOutput(result)) {
    return unknown('Baseline or current output is incomplete; no regression attribution is safe.', baseline.resultSeq);
  }
  if (baseline.sandbox !== result.sandbox || baseline.executionTarget !== result.executionTarget) {
    return unknown('The baseline and current command ran in different execution environments.', baseline.resultSeq);
  }
  const observed = parseTypeScriptDiagnostics(result, workspace);
  if (observed.length === 0 || observed.length > MAX_DIAGNOSTICS) {
    return unknown('The command failure has no complete, supported TypeScript diagnostic set.', baseline.resultSeq);
  }
  const changed = new Set(modifiedFiles.map((file) => normalizePath(workspace, file)?.toLowerCase()).filter(Boolean));
  const before = new Map(baseline.diagnostics.map((item) => [fingerprint(item), item]));
  const preExisting: CommandDiagnostic[] = [];
  const newFailures: CommandDiagnostic[] = [];
  for (const item of observed) {
    const prior = before.get(fingerprint(item));
    if (prior && prior.sourceHash && !changed.has(item.file.toLowerCase())
      && prior.sourceHash === await sourceHash(workspace, item.file)) {
      preExisting.push({ ...item, sourceHash: prior.sourceHash });
    } else {
      newFailures.push(item);
    }
  }
  if (newFailures.length > 0) {
    return { classification: 'new_failures_detected',
      reason: 'At least one diagnostic is new or its source changed since the pre-edit run; do not attribute it to the baseline.',
      baselineResultSeq: baseline.resultSeq, preExisting, newFailures };
  }
  return { classification: 'pre_existing_out_of_scope',
    reason: 'The same command failed before edits with identical diagnostics; every failing source is unchanged and outside the observed write set. This is not a newly introduced diagnostic.',
    baselineResultSeq: baseline.resultSeq, preExisting, newFailures: [] };
}
