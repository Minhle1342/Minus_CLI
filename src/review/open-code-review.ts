import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Session } from '../session/session.js';
import { loadSession, saveSession, type OcrSessionConfig } from '../session/persistent-session.js';

export type OcrReviewMode = 'workspace' | 'range' | 'commit' | 'scan';
export type OcrSeverity = 'critical' | 'high' | 'medium' | 'low';
export type OcrCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'test'
  | 'style'
  | 'documentation'
  | 'other';

export interface OcrReviewRequest {
  mode?: OcrReviewMode;
  from?: string;
  to?: string;
  commit?: string;
  paths?: string[];
  background?: string;
  rulePath?: string;
  resumeSessionId?: string;
  force?: boolean;
  trigger?: 'manual' | 'completion';
  signal?: AbortSignal;
}

export interface OcrReviewFinding {
  id: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  category: OcrCategory;
  severity: OcrSeverity;
  existingCode?: string;
  suggestionCode?: string;
}

export type OcrRunStatus =
  | 'success'
  | 'completed_with_warnings'
  | 'completed_with_errors'
  | 'skipped'
  | 'failed';

export interface OcrReviewRun {
  runId: string;
  inputHash: string;
  configHash: string;
  status: OcrRunStatus;
  gateStatus: 'pass' | 'block' | 'inconclusive';
  trigger: 'manual' | 'completion';
  mode: OcrReviewMode;
  startedAt: string;
  finishedAt: string;
  findings: OcrReviewFinding[];
  warnings: string[];
  blockingFindingIds: string[];
  filesReviewed: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  totalTokens?: number;
  elapsed?: string;
  artifactRef?: string;
  message?: string;
  errorCode?: string;
}

export interface OcrGateDecision {
  allow: boolean;
  reason?: 'disabled' | 'not-applicable' | 'review-blocked' | 'review-inconclusive';
  continuationPrompt?: string;
  run?: OcrReviewRun;
  blockingFindings: OcrReviewFinding[];
  advisoryFindings: OcrReviewFinding[];
}

export interface OcrDoctorResult {
  ok: boolean;
  installed: boolean;
  version?: string;
  llmReady?: boolean;
  errors: string[];
}

interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export type OcrProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

const REVIEWABLE_CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|cs|php|rb|swift|scala|sh|bash|zsh|ps1|sql|vue|svelte)$/i;
const VALID_STATUS = new Set(['success', 'completed_with_warnings', 'completed_with_errors', 'skipped']);
const VALID_SEVERITY = new Set<OcrSeverity>(['critical', 'high', 'medium', 'low']);
const VALID_CATEGORY = new Set<OcrCategory>([
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other',
]);

export const DEFAULT_OCR_CONFIG: Required<Omit<OcrSessionConfig, 'provider' | 'model' | 'rulePath'>> = {
  enabled: false,
  gateMode: 'enforce',
  effort: 'medium',
  concurrency: 4,
  timeoutMinutes: 15,
  maxTokensBudget: 100_000,
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function isOcrReviewableCodePath(filePath: string): boolean {
  return REVIEWABLE_CODE_EXTENSION.test(normalizeRelativePath(filePath));
}

export function resolveOcrConfig(config?: OcrSessionConfig): OcrSessionConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_OCR_CONFIG.enabled,
    gateMode: config?.gateMode === 'enforce' ? 'enforce' : DEFAULT_OCR_CONFIG.gateMode,
    effort: ['low', 'medium', 'high'].includes(String(config?.effort))
      ? config?.effort
      : DEFAULT_OCR_CONFIG.effort,
    concurrency: clampInteger(config?.concurrency, DEFAULT_OCR_CONFIG.concurrency, 1, 32),
    timeoutMinutes: clampInteger(config?.timeoutMinutes, DEFAULT_OCR_CONFIG.timeoutMinutes, 1, 120),
    maxTokensBudget: clampInteger(config?.maxTokensBudget, DEFAULT_OCR_CONFIG.maxTokensBudget, 1, 10_000_000),
    provider: safeString(config?.provider),
    model: safeString(config?.model),
    rulePath: safeString(config?.rulePath),
  };
}

function parseVersion(text: string): string | undefined {
  return text.match(/open-code-review\s+v?(\d+\.\d+\.\d+)/i)?.[1];
}

function versionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const actual = version.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if ((actual[index] || 0) > minimum[index]) return true;
    if ((actual[index] || 0) < minimum[index]) return false;
  }
  return true;
}

function defaultProcessRunner(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, aborted });
    };
    const stop = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      stderr = `${stderr}${stderr ? '\n' : ''}${error.message}`;
      finish(1);
    });
    child.once('close', (code) => finish(typeof code === 'number' ? code : 1));
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (spec.signal?.aborted) onAbort();
  });
}

export class OcrReviewService {
  private workspaceRoot: string;
  private readonly runner: OcrProcessRunner;
  private readonly cache = new Map<string, OcrReviewRun>();
  private lastRun?: OcrReviewRun;

  constructor(workspaceRoot: string, options?: { runner?: OcrProcessRunner }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.runner = options?.runner || defaultProcessRunner;
  }

  setWorkspace(workspaceRoot: string): void {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.cache.clear();
    this.lastRun = undefined;
  }

  getConfig(): OcrSessionConfig {
    return resolveOcrConfig(loadSession(this.workspaceRoot).ocr);
  }

  updateConfig(patch: Partial<OcrSessionConfig>): OcrSessionConfig {
    const next = resolveOcrConfig({ ...this.getConfig(), ...patch });
    saveSession({ ocr: next }, this.workspaceRoot);
    this.cache.clear();
    return next;
  }

  getLastRun(): OcrReviewRun | undefined {
    return this.lastRun ? structuredClone(this.lastRun) : undefined;
  }

  async doctor(options?: { testLlm?: boolean; signal?: AbortSignal }): Promise<OcrDoctorResult> {
    const errors: string[] = [];
    const invocation = this.resolveInvocation();
    const versionResult = await this.runner({
      ...invocation,
      args: [...invocation.args, 'version'],
      cwd: this.workspaceRoot,
      timeoutMs: 30_000,
      signal: options?.signal,
    });
    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (versionResult.exitCode !== 0 || !version) {
      errors.push('OpenCodeReview CLI was not found or its version output could not be parsed.');
      return { ok: false, installed: false, errors };
    }
    if (!versionAtLeast(version, [1, 9, 0])) {
      errors.push(`OpenCodeReview ${version} is too old; version 1.9.0 or newer is required.`);
    }

    let llmReady: boolean | undefined;
    if (options?.testLlm !== false && errors.length === 0) {
      const llmResult = await this.runner({
        ...invocation,
        args: [...invocation.args, 'llm', 'test'],
        cwd: this.workspaceRoot,
        timeoutMs: 120_000,
        signal: options?.signal,
      });
      llmReady = llmResult.exitCode === 0;
      if (!llmReady) errors.push(this.compactError(llmResult.stderr || llmResult.stdout || 'OCR LLM connectivity test failed.'));
    }
    return { ok: errors.length === 0, installed: true, version, llmReady, errors };
  }

  async run(request: OcrReviewRequest = {}): Promise<OcrReviewRun> {
    const mode = request.mode || 'workspace';
    const trigger = request.trigger || 'manual';
    const config = this.getConfig();
    this.validateRequest({ ...request, mode });
    const configHash = digest(stableJson(config));
    const inputHash = await this.computeInputHash({ ...request, mode }, configHash);
    const cacheKey = `${mode}:${inputHash}:${configHash}`;
    if (!request.force) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.lastRun = cached;
        return structuredClone(cached);
      }
    }

    const startedAt = new Date().toISOString();
    const runId = `ocr_${Date.now()}_${inputHash.slice(0, 10)}`;
    const invocation = this.resolveInvocation();
    const args = [...invocation.args, ...this.buildArgs({ ...request, mode }, config)];
    const hostTimeoutMs = Math.max(5 * 60_000, Number(config.timeoutMinutes) * 4 * 60_000);
    const result = await this.runner({
      command: invocation.command,
      args,
      cwd: this.workspaceRoot,
      timeoutMs: hostTimeoutMs,
      signal: request.signal,
    });

    let run: OcrReviewRun;
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      run = {
        runId,
        inputHash,
        configHash,
        status: 'failed',
        gateStatus: 'inconclusive',
        trigger,
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        findings: [],
        warnings: [],
        blockingFindingIds: [],
        filesReviewed: 0,
        message: result.aborted
          ? 'OpenCodeReview was cancelled.'
          : result.timedOut
            ? 'OpenCodeReview timed out.'
            : this.compactError(result.stderr || result.stdout || 'OpenCodeReview failed.'),
        errorCode: result.aborted ? 'OCR_CANCELLED' : result.timedOut ? 'OCR_TIMEOUT' : 'OCR_EXECUTION_FAILED',
      };
    } else {
      try {
        run = this.parseRun({
          runId,
          inputHash,
          configHash,
          trigger,
          mode,
          startedAt,
          stdout: result.stdout,
        });
      } catch (error: any) {
        run = {
          runId,
          inputHash,
          configHash,
          status: 'failed',
          gateStatus: 'inconclusive',
          trigger,
          mode,
          startedAt,
          finishedAt: new Date().toISOString(),
          findings: [],
          warnings: [],
          blockingFindingIds: [],
          filesReviewed: 0,
          message: error?.message || 'OpenCodeReview returned invalid JSON.',
          errorCode: 'OCR_INVALID_OUTPUT',
        };
      }
    }

    run.artifactRef = await this.persistArtifact(run);
    this.cache.set(cacheKey, run);
    this.lastRun = run;
    return structuredClone(run);
  }

  async evaluateCompletion(params: {
    session: Session;
    filesModified: string[];
    background?: string;
    signal?: AbortSignal;
  }): Promise<OcrGateDecision> {
    const config = this.getConfig();
    if (!config.enabled || config.gateMode !== 'enforce') {
      return { allow: true, reason: 'disabled', blockingFindings: [], advisoryFindings: [] };
    }
    const reviewablePaths = Array.from(new Set(params.filesModified.map(normalizeRelativePath)))
      .filter(isOcrReviewableCodePath)
      .sort();
    if (reviewablePaths.length === 0) {
      return { allow: true, reason: 'not-applicable', blockingFindings: [], advisoryFindings: [] };
    }

    const run = await this.run({
      mode: 'workspace',
      paths: reviewablePaths,
      background: params.background,
      trigger: 'completion',
      signal: params.signal,
    });
    this.recordRun(params.session, run);

    if (run.gateStatus === 'inconclusive') {
      return {
        allow: false,
        reason: 'review-inconclusive',
        run,
        blockingFindings: [],
        advisoryFindings: [],
        continuationPrompt: [
          '[SYSTEM OCR GATE]: OpenCodeReview did not produce a complete trustworthy result.',
          `- ${run.message || run.status}`,
          '- Repair the OCR configuration or rerun the review. Do not bypass this gate.',
        ].join('\n'),
      };
    }

    const waived = this.waivedFindingIds(params.session, run.inputHash);
    const blockingFindings = run.findings.filter(
      (finding) => ['critical', 'high'].includes(finding.severity) && !waived.has(finding.id),
    );
    const advisoryFindings = run.findings.filter((finding) => !blockingFindings.some((item) => item.id === finding.id));
    if (blockingFindings.length === 0) {
      return { allow: true, run, blockingFindings: [], advisoryFindings };
    }

    return {
      allow: false,
      reason: 'review-blocked',
      run,
      blockingFindings,
      advisoryFindings,
      continuationPrompt: [
        `[SYSTEM OCR GATE]: ${blockingFindings.length} critical/high review finding(s) block completion.`,
        ...blockingFindings.slice(0, 8).map((finding) =>
          `- [${finding.id}] ${finding.severity.toUpperCase()} ${finding.path}:${finding.startLine || '?'} `
          + `[${finding.category}] ${finding.content}`
          + (finding.suggestionCode ? `\n  Suggested change: ${finding.suggestionCode}` : ''),
        ),
        '- Fix the findings, then rerun verification and submit again. Only the human operator may waive a finding.',
      ].join('\n'),
    };
  }

  waive(session: Session, findingId: string, reason: string): { findingId: string; inputHash: string; reason: string } {
    const run = this.lastRun;
    if (!run) throw new Error('No OpenCodeReview run is available to waive.');
    if (!run.findings.some((finding) => finding.id === findingId)) {
      throw new Error(`OpenCodeReview finding '${findingId}' was not found in the latest run.`);
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 8) throw new Error('A concrete waiver reason of at least 8 characters is required.');
    const waiver = { findingId, inputHash: run.inputHash, reason: trimmedReason };
    session.append('control/decision', {
      controlDecision: { kind: 'ocr/waiver', ...waiver, waivedAt: new Date().toISOString() },
    });
    return waiver;
  }

  private recordRun(session: Session, run: OcrReviewRun): void {
    const exists = session.getEvents().some(
      (event) => event.type === 'control/decision'
        && event.data.controlDecision?.kind === 'ocr/run'
        && event.data.controlDecision?.runId === run.runId,
    );
    if (exists) return;
    session.append('control/decision', {
      controlDecision: {
        kind: 'ocr/run',
        ...run,
        findings: run.findings.map((finding) => ({ ...finding })),
      },
    });
  }

  private waivedFindingIds(session: Session, inputHash: string): Set<string> {
    return new Set(session.getEvents()
      .filter((event) => event.type === 'control/decision'
        && event.data.controlDecision?.kind === 'ocr/waiver'
        && event.data.controlDecision?.inputHash === inputHash)
      .map((event) => event.data.controlDecision?.findingId)
      .filter((id): id is string => Boolean(id)));
  }

  private resolveInvocation(): { command: string; args: string[] } {
    try {
      const require = createRequire(import.meta.url);
      const packageJson = require.resolve('@alibaba-group/open-code-review/package.json');
      return { command: process.execPath, args: [path.join(path.dirname(packageJson), 'bin', 'ocr.js')] };
    } catch {
      return { command: 'ocr', args: [] };
    }
  }

  private buildArgs(request: OcrReviewRequest & { mode: OcrReviewMode }, config: OcrSessionConfig): string[] {
    const args = request.mode === 'scan' ? ['scan'] : ['review'];
    args.push('--repo', this.workspaceRoot, '--format', 'json', '--audience', 'agent', '--color', 'never');
    if (request.mode === 'range') args.push('--from', request.from!, '--to', request.to!);
    if (request.mode === 'commit') args.push('--commit', request.commit!);
    if (request.mode === 'scan' && request.paths?.length) args.push('--path', request.paths.map(normalizeRelativePath).join(','));
    if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);
    if (request.background) args.push('--background', request.background.slice(0, 8000));
    const conventionalRulePath = '.opencodereview/rule.json';
    const rulePath = request.rulePath
      || config.rulePath
      || (existsSync(path.join(this.workspaceRoot, conventionalRulePath)) ? conventionalRulePath : undefined);
    if (rulePath) args.push('--rule', this.resolveWorkspaceFile(rulePath));
    args.push('--effort', String(config.effort));
    args.push('--concurrency', String(config.concurrency));
    args.push('--timeout', String(config.timeoutMinutes));
    args.push('--max-tokens-budget', String(config.maxTokensBudget));
    if (config.provider) args.push('--provider', config.provider);
    if (config.model) args.push('--model', config.model);
    return args;
  }

  private validateRequest(request: OcrReviewRequest & { mode: OcrReviewMode }): void {
    if (request.mode === 'range' && (!safeString(request.from) || !safeString(request.to))) {
      throw new Error('OCR range mode requires both from and to refs.');
    }
    if (request.mode === 'commit' && !safeString(request.commit)) {
      throw new Error('OCR commit mode requires a commit hash or ref.');
    }
    if (request.resumeSessionId && !['range', 'commit'].includes(request.mode)) {
      throw new Error('OCR resume is supported only for range or commit review modes.');
    }
  }

  private resolveWorkspaceFile(filePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, filePath);
    const rootWithSeparator = `${this.workspaceRoot}${path.sep}`;
    if (resolved !== this.workspaceRoot && !resolved.startsWith(rootWithSeparator)) {
      throw new Error(`OCR rule path escapes the workspace: ${filePath}`);
    }
    return resolved;
  }

  private async computeInputHash(request: OcrReviewRequest & { mode: OcrReviewMode }, configHash: string): Promise<string> {
    const identity: Record<string, unknown> = {
      mode: request.mode,
      from: request.from,
      to: request.to,
      commit: request.commit,
      paths: request.paths?.map(normalizeRelativePath).sort(),
      background: request.background,
      rulePath: request.rulePath,
      configHash,
    };
    if (request.mode === 'workspace') {
      const gitResult = await this.runner({
        command: 'git',
        args: ['--no-pager', 'diff', '--binary', 'HEAD', '--', ...(request.paths || [])],
        cwd: this.workspaceRoot,
        timeoutMs: 60_000,
        signal: request.signal,
      });
      identity.diff = gitResult.stdout;
      const untracked: Array<{ path: string; content: string }> = [];
      for (const relativePath of request.paths || []) {
        try {
          const absolute = this.resolveWorkspaceFile(relativePath);
          const stat = await fs.stat(absolute);
          if (stat.isFile() && !gitResult.stdout.includes(`b/${normalizeRelativePath(relativePath)}`)) {
            untracked.push({ path: normalizeRelativePath(relativePath), content: await fs.readFile(absolute, 'utf8') });
          }
        } catch {}
      }
      identity.untracked = untracked;
    }
    return digest(stableJson(identity));
  }

  private parseRun(params: {
    runId: string;
    inputHash: string;
    configHash: string;
    trigger: 'manual' | 'completion';
    mode: OcrReviewMode;
    startedAt: string;
    stdout: string;
  }): OcrReviewRun {
    const parsed = JSON.parse(params.stdout.trim());
    if (!parsed || typeof parsed !== 'object' || !VALID_STATUS.has(parsed.status) || !Array.isArray(parsed.comments)) {
      throw new Error('OpenCodeReview returned an unsupported JSON envelope.');
    }
    const findings: OcrReviewFinding[] = parsed.comments.map(
      (comment: any, index: number) => this.parseFinding(comment, index),
    );
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((item: unknown) => String(item)) : [];
    const blockingFindingIds = findings
      .filter((finding) => finding.severity === 'critical' || finding.severity === 'high')
      .map((finding) => finding.id);
    const status = parsed.status as Exclude<OcrRunStatus, 'failed'>;
    const incomplete = status === 'completed_with_warnings' || status === 'completed_with_errors' || warnings.length > 0;
    return {
      runId: params.runId,
      inputHash: params.inputHash,
      configHash: params.configHash,
      status,
      gateStatus: incomplete ? 'inconclusive' : blockingFindingIds.length > 0 ? 'block' : 'pass',
      trigger: params.trigger,
      mode: params.mode,
      startedAt: params.startedAt,
      finishedAt: new Date().toISOString(),
      findings,
      warnings,
      blockingFindingIds,
      filesReviewed: Number(parsed.summary?.files_reviewed || 0),
      sessionId: safeString(parsed.session_id),
      provider: safeString(parsed.llm?.provider),
      model: safeString(parsed.llm?.model),
      totalTokens: Number.isFinite(Number(parsed.summary?.total_tokens)) ? Number(parsed.summary.total_tokens) : undefined,
      elapsed: safeString(parsed.summary?.elapsed),
      message: safeString(parsed.message),
    };
  }

  private parseFinding(comment: any, index: number): OcrReviewFinding {
    const filePath = safeString(comment?.path);
    const content = safeString(comment?.content);
    const severity = safeString(comment?.severity)?.toLowerCase() as OcrSeverity | undefined;
    const category = safeString(comment?.category)?.toLowerCase() as OcrCategory | undefined;
    if (!filePath || !content || !severity || !VALID_SEVERITY.has(severity) || !category || !VALID_CATEGORY.has(category)) {
      throw new Error(`OpenCodeReview comment #${index + 1} is missing a valid path, content, severity, or category.`);
    }
    const normalizedPath = normalizeRelativePath(filePath);
    const existingCode = safeString(comment.existing_code);
    const suggestionCode = safeString(comment.suggestion_code);
    const id = `ocrf_${digest(stableJson({
      path: normalizedPath,
      category,
      severity,
      content,
      existingCode,
    })).slice(0, 16)}`;
    return {
      id,
      path: normalizedPath,
      content,
      startLine: clampInteger(comment.start_line, 0, 0, Number.MAX_SAFE_INTEGER),
      endLine: clampInteger(comment.end_line, 0, 0, Number.MAX_SAFE_INTEGER),
      category,
      severity,
      existingCode,
      suggestionCode,
    };
  }

  private async persistArtifact(run: OcrReviewRun): Promise<string | undefined> {
    try {
      const artifactDir = path.join(this.workspaceRoot, '.codingagent', 'reviews');
      await fs.mkdir(artifactDir, { recursive: true });
      const artifactPath = path.join(artifactDir, `${run.runId}.json`);
      const sanitized = { ...run, artifactRef: undefined };
      await fs.writeFile(artifactPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
      return path.relative(this.workspaceRoot, artifactPath).replace(/\\/g, '/');
    } catch {
      return undefined;
    }
  }

  private compactError(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 1200);
  }
}
