import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export type CoverageEcosystem = 'js' | 'python' | 'go' | 'dotnet' | 'rust' | 'unknown';

export interface FileCoverage {
  /** Workspace-relative path with forward slashes (best effort). */
  path: string;
  linesFound: number;
  linesHit: number;
  /** 0..1 */
  lineRate: number;
  branchesFound?: number;
  branchesHit?: number;
  /** 0..1 */
  branchRate?: number;
}

export interface CoverageReport {
  ecosystem: CoverageEcosystem;
  /** Workspace-relative path of the report file that was parsed. */
  source: string;
  files: FileCoverage[];
}

export interface ReadCoverageReportOptions {
  maxBytes?: number;
  /** Reports older than this are treated as stale and ignored (fail-open). */
  maxAgeMs?: number;
  nowMs?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

const CANDIDATES: Record<Exclude<CoverageEcosystem, 'unknown'>, string[]> = {
  js: [
    'coverage/lcov.info',
    'coverage/coverage-final.json',
    'coverage/coverage-summary.json',
    'coverage/cobertura-coverage.xml',
    'coverage.xml',
    'cobertura-coverage.xml',
    'lcov.info',
  ],
  python: ['coverage.xml', 'coverage/coverage.xml'],
  go: ['coverage.out', 'coverage/coverage.out', 'cover.out'],
  dotnet: [
    'coverage.cobertura.xml',
    'coverage/coverage.cobertura.xml',
    'coverage.xml',
    'TestResults/coverage.cobertura.xml',
  ],
  rust: ['lcov.info', 'coverage/lcov.info', 'cobertura.xml', 'coverage/cobertura.xml'],
};

const GENERIC_FALLBACKS = ['coverage.xml', 'cobertura.xml', 'lcov.info', 'coverage.out'];

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirNames(workspaceDir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(workspaceDir, { withFileTypes: true }).map((e) => e.name));
  } catch {
    return new Set();
  }
}

/**
 * Identify the repo ecosystem(s) from manifests and configs before looking
 * for reports. A repo may host more than one; candidates from every matched
 * ecosystem are considered.
 */
export function detectCoverageEcosystems(workspaceDir: string): Array<Exclude<CoverageEcosystem, 'unknown'>> {
  const names = dirNames(workspaceDir);
  const found: Array<Exclude<CoverageEcosystem, 'unknown'>> = [];
  if (names.has('package.json')) found.push('js');
  if (
    names.has('pyproject.toml') ||
    names.has('setup.py') ||
    names.has('setup.cfg') ||
    names.has('pytest.ini') ||
    names.has('tox.ini')
  ) {
    found.push('python');
  }
  if (names.has('go.mod')) found.push('go');
  if (names.has('Cargo.toml')) found.push('rust');
  if ([...names].some((n) => /\.sln$/i.test(n) || /\.csproj$/i.test(n))) found.push('dotnet');
  return found;
}

function nestedDotnetCandidates(workspaceDir: string): string[] {
  const out: string[] = [];
  try {
    const testResults = path.join(workspaceDir, 'TestResults');
    for (const entry of fs.readdirSync(testResults, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join('TestResults', entry.name, 'coverage.cobertura.xml');
      if (existsFile(path.join(workspaceDir, candidate))) out.push(candidate);
    }
  } catch {
    // No TestResults dir — nothing to add.
  }
  return out;
}

export function findCoverageReportFiles(workspaceDir: string): Array<{ rel: string; abs: string }> {
  const ecosystems = detectCoverageEcosystems(workspaceDir);
  const rels: string[] = [];
  for (const eco of ecosystems) rels.push(...CANDIDATES[eco]);
  if (ecosystems.includes('dotnet')) rels.push(...nestedDotnetCandidates(workspaceDir));
  rels.push(...GENERIC_FALLBACKS);
  const seen = new Set<string>();
  const found: Array<{ rel: string; abs: string }> = [];
  for (const rel of rels) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(workspaceDir, rel);
    if (existsFile(abs)) found.push({ rel, abs });
  }
  return found;
}

function toRel(workspaceDir: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(workspaceDir, filePath).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) return rel;
    return normalized.split('/').slice(-3).join('/');
  }
  return normalized.replace(/^\.\//, '');
}

function clampRate(hit: number, found: number): number {
  if (found <= 0) return 0;
  return Math.min(1, Math.max(0, hit / found));
}

function parseLcov(text: string, workspaceDir: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: { path: string; lf: number; lh: number; brf: number; brh: number } | null = null;
  const flush = () => {
    if (current && current.lf > 0) {
      files.push({
        path: toRel(workspaceDir, current.path),
        linesFound: current.lf,
        linesHit: Math.min(current.lh, current.lf),
        lineRate: clampRate(current.lh, current.lf),
        ...(current.brf > 0
          ? { branchesFound: current.brf, branchesHit: Math.min(current.brh, current.brf), branchRate: clampRate(current.brh, current.brf) }
          : {}),
      });
    }
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      flush();
      current = { path: line.slice(3).trim(), lf: 0, lh: 0, brf: 0, brh: 0 };
    } else if (line === 'end_of_record') {
      flush();
    } else if (current) {
      if (line.startsWith('LF:')) current.lf = Number(line.slice(3)) || 0;
      else if (line.startsWith('LH:')) current.lh = Number(line.slice(3)) || 0;
      else if (line.startsWith('BRF:')) current.brf = Number(line.slice(4)) || 0;
      else if (line.startsWith('BRH:')) current.brh = Number(line.slice(4)) || 0;
    }
  }
  flush();
  return files;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseCobertura(text: string, workspaceDir: string): FileCoverage[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const doc = parser.parse(text) as any;
  const coverage = doc?.coverage;
  if (!coverage || typeof coverage !== 'object') throw new Error('Not a cobertura document (missing <coverage>).');
  const packages = coverage?.packages?.package;
  const packageList = Array.isArray(packages) ? packages : packages ? [packages] : [];
  const files: FileCoverage[] = [];
  const visitClasses = (classes: unknown) => {
    const list = Array.isArray(classes) ? classes : classes ? [classes] : [];
    for (const cls of list as any[]) {
      const filename = String(cls?.filename || cls?.name || '');
      if (!filename) continue;
      const lines = cls?.lines?.line;
      const lineList = Array.isArray(lines) ? lines : lines ? [lines] : [];
      let found = 0;
      let hit = 0;
      let branchesFound = 0;
      let branchesHit = 0;
      for (const ln of lineList as any[]) {
        found += 1;
        if (num(ln?.hits) > 0) hit += 1;
        if (ln?.branch === true || ln?.branch === 'true') {
          branchesFound += 1;
          if (String(ln?.['condition-coverage'] || '').startsWith('100%')) branchesHit += 1;
        }
      }
      if (found > 0) {
        files.push({
          path: toRel(workspaceDir, filename),
          linesFound: found,
          linesHit: hit,
          lineRate: clampRate(hit, found),
          ...(branchesFound > 0
            ? { branchesFound, branchesHit, branchRate: clampRate(branchesHit, branchesFound) }
            : {}),
        });
      }
    }
  };
  for (const pkg of packageList) visitClasses(pkg?.classes?.class);
  if (files.length === 0) throw new Error('Cobertura document contains no class line data.');
  return files;
}

function parseGoCover(text: string, workspaceDir: string): FileCoverage[] {
  const lines = text.split(/\r?\n/);
  if (!/^mode:\s*\w+/.test(lines[0] || '')) throw new Error('Not a go coverprofile (missing mode line).');
  const byFile = new Map<string, { found: number; hit: number }>();
  for (const line of lines.slice(1)) {
    const m = line.match(/^(.+?):\d+\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const entry = byFile.get(m[1]) || { found: 0, hit: 0 };
    const stmts = Number(m[2]) || 0;
    entry.found += stmts;
    if ((Number(m[3]) || 0) > 0) entry.hit += stmts;
    byFile.set(m[1], entry);
  }
  const files: FileCoverage[] = [];
  for (const [file, counts] of byFile) {
    if (counts.found <= 0) continue;
    files.push({
      path: toRel(workspaceDir, file),
      linesFound: counts.found,
      linesHit: Math.min(counts.hit, counts.found),
      lineRate: clampRate(counts.hit, counts.found),
    });
  }
  if (files.length === 0) throw new Error('Go coverprofile contains no file blocks.');
  return files;
}

function parseJestFinal(text: string, workspaceDir: string): FileCoverage[] {
  const doc = JSON.parse(text) as Record<string, any>;
  const files: FileCoverage[] = [];
  for (const [file, data] of Object.entries(doc)) {
    if (!data || typeof data !== 'object' || !data.s || typeof data.s !== 'object') continue;
    const hits = Object.values(data.s as Record<string, unknown>);
    const found = hits.length;
    if (found === 0) continue;
    const hit = hits.filter((h) => num(h) > 0).length;
    files.push({
      path: toRel(workspaceDir, file),
      linesFound: found,
      linesHit: hit,
      lineRate: clampRate(hit, found),
    });
  }
  if (files.length === 0) throw new Error('coverage-final.json contains no per-file statement data.');
  return files;
}

function parseIstanbulSummary(text: string, workspaceDir: string): FileCoverage[] {
  const doc = JSON.parse(text) as Record<string, any>;
  const files: FileCoverage[] = [];
  for (const [file, data] of Object.entries(doc)) {
    const lines = (data as any)?.lines;
    if (!lines || typeof lines.total !== 'number') continue;
    const found = num(lines.total);
    if (found <= 0) continue;
    const hit = num(lines.covered);
    files.push({
      path: toRel(workspaceDir, file),
      linesFound: found,
      linesHit: Math.min(hit, found),
      lineRate: clampRate(hit, found),
      ...(typeof lines.branches === 'object' && typeof lines.branches.total === 'number' && lines.branches.total > 0
        ? {
          branchesFound: num(lines.branches.total),
          branchesHit: Math.min(num(lines.branches.covered), num(lines.branches.total)),
          branchRate: clampRate(num(lines.branches.covered), num(lines.branches.total)),
        }
        : {}),
    });
  }
  if (files.length === 0) throw new Error('coverage-summary.json contains no per-file line data.');
  return files;
}

/**
 * Read the freshest usable coverage report in the workspace. Returns null
 * when the repo has no coverage configured, the report is missing, stale,
 * oversized, or unparseable — every one of those is fail-open for the caller.
 */
export function readCoverageReport(
  workspaceDir: string,
  opts: ReadCoverageReportOptions = {},
): CoverageReport | null {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  let candidates: Array<{ rel: string; abs: string }>;
  try {
    candidates = findCoverageReportFiles(workspaceDir);
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  const ecosystems = detectCoverageEcosystems(workspaceDir);
  const ecosystem: CoverageEcosystem = ecosystems[0] || 'unknown';
  for (const { rel, abs } of candidates) {
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) continue;
      if (nowMs - stat.mtimeMs > maxAgeMs) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const files = parseCoverageText(text, rel, workspaceDir);
      if (files.length > 0) return { ecosystem, source: rel, files };
    } catch {
      continue;
    }
  }
  return null;
}

function parseCoverageText(text: string, rel: string, workspaceDir: string): FileCoverage[] {
  const lower = rel.toLowerCase();
  const trimmed = text.trimStart();
  if (lower.endsWith('.info') || text.includes('SF:')) return parseLcov(text, workspaceDir);
  if (lower.endsWith('.out') || /^mode:\s*\w+/m.test(text.slice(0, 200))) return parseGoCover(text, workspaceDir);
  if (lower.endsWith('.json') || trimmed.startsWith('{')) {
    try {
      return parseIstanbulSummary(text, workspaceDir);
    } catch {
      return parseJestFinal(text, workspaceDir);
    }
  }
  if (lower.endsWith('.xml') || trimmed.startsWith('<')) return parseCobertura(text, workspaceDir);
  // Content sniff as a last resort.
  if (text.includes('<coverage')) return parseCobertura(text, workspaceDir);
  if (text.includes('SF:')) return parseLcov(text, workspaceDir);
  throw new Error(`Unrecognized coverage format: ${rel}.`);
}
