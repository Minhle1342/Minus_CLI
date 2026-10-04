import type { VerificationLadderTier } from '../skills/verification-policy.js';
import type { FileCoverage } from './coverage-report-reader.js';

export type VerificationCoverageVerdict = 'sufficient' | 'partial' | 'insufficient' | 'unknown';

export interface FileCoverageSummary {
  path: string;
  lineRate: number;
  branchRate?: number;
}

export interface VerificationCoverage {
  verdict: VerificationCoverageVerdict;
  /** 0..1. Only meaningful for sufficient/partial; 0 otherwise. */
  score: number;
  /** Parsed number of executed tests (passed + failed), when the runner summary was found. */
  executedTests?: number;
  /** Runner that produced the parsed summary, e.g. 'jest'. */
  runner?: string;
  /** Impacted suites the command demonstrably targets. */
  matchedSuites: string[];
  /** Impacted suites with no evidence of execution. */
  uncoveredSuites: string[];
  /** Human-readable findings for gate reasons and audits. */
  findings: string[];
  /** Per-modified-file line rates taken from the coverage report, when one was read. */
  fileCoverage?: FileCoverageSummary[];
  /** Report file the fileCoverage entries came from. */
  coverageSource?: string;
  /** Line-rate threshold applied to modified files. */
  coverageThreshold?: number;
}

export interface CoverageEvaluationInput {
  command: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  tier?: VerificationLadderTier;
  /** True only when tier was assigned by harness tooling (not inferred from the command name). */
  tierExplicit?: boolean;
  /** Harness-measured modified files (never LLM-declared). */
  modifiedFiles?: string[];
  /** Harness-measured blast-impacted suites. */
  pendingSuites?: string[];
  /** Parsed coverage report for the workspace, when the repo has one configured. */
  fileCoverage?: FileCoverage[] | null;
  /** Workspace-relative report source, for findings. */
  coverageSource?: string;
  /** Modified files below this line rate are flagged (default 0.5). */
  coverageThreshold?: number;
}

interface ParsedCounts {
  runner: string;
  passed: number;
  failed: number;
  evidence: string;
}

const MAX_OUTPUT_SCAN_CHARS = 24_000;

function combinedOutput(input: CoverageEvaluationInput): string {
  const tail = (s: string | undefined) => (s || '').slice(-MAX_OUTPUT_SCAN_CHARS);
  return `${tail(input.stdout)}\n${tail(input.stderr)}`;
}

const COUNT_PARSERS: Array<{ runner: string; parse: (output: string) => ParsedCounts | undefined }> = [
  {
    runner: 'jest',
    parse: (output) => {
      const m = output.match(/Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*passed,\s*)?(\d+)\s*total/);
      if (!m) return undefined;
      return { runner: 'jest', passed: Number(m[2] || 0), failed: Number(m[1] || 0), evidence: m[0].trim() };
    },
  },
  {
    runner: 'vitest',
    parse: (output) => {
      const m = output.match(/Tests\s+(?:(\d+)\s*failed\s*\|\s*)?(\d+)\s*passed/);
      if (!m) return undefined;
      return { runner: 'vitest', passed: Number(m[2]), failed: Number(m[1] || 0), evidence: m[0].trim() };
    },
  },
  {
    runner: 'mocha',
    parse: (output) => {
      const pass = output.match(/(\d+)\s+passing/);
      if (!pass) return undefined;
      const fail = output.match(/(\d+)\s+failing/);
      return { runner: 'mocha', passed: Number(pass[1]), failed: Number(fail?.[1] || 0), evidence: pass[0].trim() };
    },
  },
  {
    runner: 'cargo',
    parse: (output) => {
      const m = output.match(/test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/);
      if (!m) return undefined;
      return { runner: 'cargo', passed: Number(m[2]), failed: Number(m[3]), evidence: m[0].trim() };
    },
  },
  {
    runner: 'dotnet',
    parse: (output) => {
      const full = output.match(/Passed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+)/i);
      if (full) return { runner: 'dotnet', passed: Number(full[2]), failed: Number(full[1]), evidence: full[0].trim() };
      const ordered = output.match(/Passed:\s*(\d+),\s*Failed:\s*(\d+)/i);
      if (ordered) return { runner: 'dotnet', passed: Number(ordered[1]), failed: Number(ordered[2]), evidence: ordered[0].trim() };
      const reversed = output.match(/Failed:\s*(\d+),\s*Passed:\s*(\d+)/i);
      if (reversed) return { runner: 'dotnet', passed: Number(reversed[2]), failed: Number(reversed[1]), evidence: reversed[0].trim() };
      return undefined;
    },
  },
  {
    runner: 'go',
    parse: (output) => {
      const ok = output.match(/^ok\s+\S+/m);
      const fail = output.match(/^(FAIL|--- FAIL)/m);
      if (!ok && !fail) return undefined;
      const pkgs = (output.match(/^(?:ok|FAIL)\s+\S+/gm) || []).length;
      return { runner: 'go', passed: ok ? Math.max(1, pkgs) : 0, failed: fail ? 1 : 0, evidence: (ok?.[0] || fail?.[0] || '').trim() };
    },
  },
  {
    runner: 'pytest',
    parse: (output) => {
      const m = output.match(/(\d+)\s+passed(?:,\s*(\d+)\s+skipped)?(?:,\s*(\d+)\s+failed)?/);
      if (!m) return undefined;
      return {
        runner: 'pytest',
        passed: Number(m[1]),
        failed: Number(m[3] || 0),
        evidence: m[0].trim(),
      };
    },
  },
];

const ZERO_MARKERS = [
  /no tests?(?:\s+were)?\s+found/i,
  /no test files?(?:\s+found)?/i,
  /collected\s+0\s+items?/i,
  /no tests?\s+ran/i,
  /no tests?\s+to\s+run/i,
  /Tests:\s*0\s+total/i,
  /Tests\s+0\s+passed/i,
];

/** Test-file-ish tokens inside a shell command, normalized to lowercase basenames. */
export function extractCommandedTestBasenames(command: string): string[] {
  const basenames = new Set<string>();
  const patterns = [
    /[\w\-./\\]+\.(?:spec|test)\.[cm]?[jt]sx?/gi,
    /test_[\w\-]+\.(?:py|go|rs)/gi,
    /[\w\-]+_test\.(?:py|go|rs)/gi,
    /[\w\-./\\]*test[\w\-./\\]*\.py/gi,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const base = match[0].split(/[\\/]/).pop() || '';
      if (base) basenames.add(base.toLowerCase());
    }
  }
  return Array.from(basenames);
}

function modifiedStemVariants(file: string): string[] {
  const base = (file.split(/[\\/]/).pop() || '').toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  return [base, stem].filter(Boolean);
}

const DEFAULT_COVERAGE_THRESHOLD = 0.5;
const MAX_REPORT_FILES_TRACKED = 20;

function normalizeCoveragePath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function findReportEntry(
  report: FileCoverage[],
  modifiedFile: string,
): FileCoverage | undefined {
  const target = normalizeCoveragePath(modifiedFile);
  if (!target) return undefined;
  const targetBase = target.split('/').pop() || '';
  return report.find((entry) => {
    const candidate = normalizeCoveragePath(entry.path);
    if (!candidate) return false;
    if (candidate === target || target.endsWith(`/${candidate}`) || candidate.endsWith(`/${target}`)) return true;
    const candidateBase = candidate.split('/').pop() || '';
    return candidateBase !== '' && candidateBase === targetBase;
  });
}

/**
 * Refines a base verdict with a parsed coverage report. Only ever downgrades
 * sufficient to partial (or annotates partial/unknown) — a report can never
 * manufacture 'sufficient' on its own, and it can never produce the blocking
 * 'insufficient' verdict, which stays reserved for proven-empty runs.
 */
function applyFileCoverageReport(
  base: VerificationCoverage,
  input: CoverageEvaluationInput,
  modified: string[],
): VerificationCoverage {
  const report = input.fileCoverage;
  if (!report || report.length === 0 || modified.length === 0) return base;
  const threshold = input.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const summaries: FileCoverageSummary[] = [];
  const thin: string[] = [];
  const absent: string[] = [];
  for (const file of modified.slice(0, MAX_REPORT_FILES_TRACKED)) {
    const entry = findReportEntry(report, file);
    if (!entry) {
      absent.push(file);
      continue;
    }
    summaries.push({
      path: entry.path,
      lineRate: entry.lineRate,
      ...(entry.branchRate !== undefined ? { branchRate: entry.branchRate } : {}),
    });
    if (entry.lineRate < threshold) {
      thin.push(`${entry.path} (${Math.round(entry.lineRate * 100)}% lines < ${Math.round(threshold * 100)}%)`);
    }
  }
  const shared = {
    fileCoverage: summaries,
    coverageSource: input.coverageSource,
    coverageThreshold: threshold,
  };
  if (thin.length === 0 && absent.length === 0) {
    return {
      ...base,
      ...shared,
      findings: [
        ...base.findings,
        `Coverage report (${input.coverageSource || 'report'}) covers all ${summaries.length} modified file(s) at/above ${Math.round(threshold * 100)}% lines.`,
      ],
    };
  }
  const detail = [
    ...thin.map((t) => `thin coverage: ${t}`),
    ...absent.slice(0, 5).map((a) => `absent from report: ${a}`),
  ].join('; ');
  const findings = [
    `Coverage report flags modified files — ${detail}. Add/extend tests for the uncovered lines before completing.`,
    ...base.findings,
  ];
  if (base.verdict === 'sufficient') {
    return { ...base, ...shared, verdict: 'partial', score: 0.5, findings };
  }
  return { ...base, ...shared, findings };
}

/**
 * Evaluates how much of the required verification the LLM's command actually
 * performed. Fail-open by construction: anything that cannot be proven about
 * the run yields 'unknown' and never blocks completion. Only a *proven*
 * empty run (runner summary with 0 executed tests, or an explicit
 * no-tests marker on a successful command) yields 'insufficient'.
 */
export function evaluateVerificationCoverage(input: CoverageEvaluationInput): VerificationCoverage {
  const pending = Array.from(new Set((input.pendingSuites || []).map((s) => String(s)).filter(Boolean)));
  const modified = Array.from(new Set((input.modifiedFiles || []).map((s) => String(s)).filter(Boolean)));
  const commanded = extractCommandedTestBasenames(input.command);

  const matchedSuites = pending.filter((suite) => {
    const lowered = suite.toLowerCase();
    const suiteBase = lowered.split(/[\\/]/).pop() || '';
    return commanded.some((base) => lowered.includes(base) || (suiteBase !== '' && base.includes(suiteBase)));
  });
  // Fallback to the pre-existing substring rule so scores never under-report it.
  for (const suite of pending) {
    if (!matchedSuites.includes(suite) && (input.command.includes(suite) || suite.includes(input.command))) {
      matchedSuites.push(suite);
    }
  }
  const uncoveredSuites = pending.filter((suite) => !matchedSuites.includes(suite));

  const commandedRelatedToModified = modified.length === 0 || commanded.length === 0
    ? undefined
    : commanded.some((base) => modified.some((file) =>
      modifiedStemVariants(file).some((variant) => base.includes(variant) || variant.includes(base.replace(/\.(spec|test)\.[^.]+$/, ''))),
    ));

  const output = combinedOutput(input);
  let counts: ParsedCounts | undefined;
  for (const parser of COUNT_PARSERS) {
    counts = parser.parse(output);
    if (counts) break;
  }
  let zeroMarker: string | undefined;
  if (!counts) {
    zeroMarker = ZERO_MARKERS.map((pattern) => output.match(pattern)?.[0].trim()).find(Boolean);
  }

  const executed = counts ? counts.passed + counts.failed : zeroMarker ? 0 : undefined;
  const findings: string[] = [];

  // Harness-executed suites (run_test_suite and friends) report their own
  // pass/fail; there is nothing to second-guess from stdout parsing. This
  // trust applies ONLY to explicitly assigned tiers — an inferred tier from
  // the command name (e.g. 'npm test' -> full_test) is a guess, not evidence.
  if ((input.tier === 'full_test' || input.tier === 'build') && input.tierExplicit && input.success && executed === undefined && !zeroMarker) {
    return applyFileCoverageReport(
      {
        verdict: 'sufficient',
        score: 1,
        matchedSuites,
        uncoveredSuites,
        findings: [`Harness-measured ${input.tier} pass; runner-summary parsing not required.`],
      },
      input,
      modified,
    );
  }

  if (!input.success) {
    if (executed !== undefined) {
      findings.push(`Command failed after executing ${executed} test(s)${counts ? ` (${counts.runner}: ${counts.evidence})` : ''}.`);
    } else {
      findings.push('Command failed; coverage unevaluable until a green run exists.');
    }
    return { verdict: 'insufficient', score: 0, executedTests: executed, runner: counts?.runner, matchedSuites, uncoveredSuites, findings };
  }

  if (executed !== undefined && executed === 0 && modified.length > 0) {
    const evidence = counts ? `${counts.runner} summary "${counts.evidence}"` : `marker "${zeroMarker}"`;
    findings.push(
      `Command exited 0 but executed 0 tests (${evidence}) despite ${modified.length} modified file(s). ` +
      `Rerun with a filter matching the impacted area${uncoveredSuites.length > 0 ? `: ${uncoveredSuites.slice(0, 3).join(', ')}` : ''}.`,
    );
    return { verdict: 'insufficient', score: 0, executedTests: 0, runner: counts?.runner, matchedSuites, uncoveredSuites, findings };
  }

  if (executed !== undefined && executed > 0) {
    findings.push(`Executed ${executed} test(s)${counts ? ` (${counts.runner}: ${counts.evidence})` : ''}.`);
    if (pending.length === 0) {
      // No blast-impacted suites: a bare suite run is sufficient, but a run
      // explicitly targeting files unrelated to the modification is partial.
      if (commanded.length > 0 && commandedRelatedToModified === false) {
        findings.push(
          `Command targets ${commanded.slice(0, 3).join(', ')}, unrelated to modified files (${modified.slice(0, 3).join(', ')}). ` +
          `Run the suite covering the modified area before completing.`,
        );
        return { verdict: 'partial', score: 0.5, executedTests: executed, runner: counts?.runner, matchedSuites, uncoveredSuites, findings };
      }
      return applyFileCoverageReport(
        { verdict: 'sufficient', score: 1, executedTests: executed, runner: counts?.runner, matchedSuites, uncoveredSuites, findings },
        input,
        modified,
      );
    }
    const score = matchedSuites.length / pending.length;
    if (uncoveredSuites.length === 0) {
      return applyFileCoverageReport(
        { verdict: 'sufficient', score: 1, executedTests: executed, runner: counts?.runner, matchedSuites, uncoveredSuites, findings },
        input,
        modified,
      );
    }
    findings.push(`Impacted suites without execution evidence: ${uncoveredSuites.slice(0, 5).join(', ')}.`);
    return applyFileCoverageReport(
      { verdict: 'partial', score, executedTests: executed, runner: counts?.runner, matchedSuites, uncoveredSuites, findings },
      input,
      modified,
    );
  }

  if (commanded.length > 0 && commandedRelatedToModified === false && (pending.length > 0 || modified.length > 0)) {
    findings.push(
      `Command targets ${commanded.slice(0, 3).join(', ')}, unrelated to modified files (${modified.slice(0, 3).join(', ') || 'none tracked'})` +
      `${uncoveredSuites.length > 0 ? ` and impacted suites (${uncoveredSuites.slice(0, 3).join(', ')})` : ''}. ` +
      `Confirm the impacted area is covered before completing.`,
    );
    return { verdict: 'partial', score: 0.5, matchedSuites, uncoveredSuites, findings };
  }

  findings.push('No parseable runner summary and no suite targeting evidence; coverage unknown.');
  return applyFileCoverageReport(
    { verdict: 'unknown', score: 0, matchedSuites, uncoveredSuites, findings },
    input,
    modified,
  );
}
