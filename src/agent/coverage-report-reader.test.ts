import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectCoverageEcosystems,
  findCoverageReportFiles,
  readCoverageReport,
} from './coverage-report-reader.js';

function makeWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-reader-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const LCOV = `TN:
SF:src/auth/login.ts
FNF:2
FNH:2
LF:10
LH:9
BRF:4
BRH:3
end_of_record
TN:
SF:src/utils/format.ts
FNF:1
FNH:0
LF:5
LH:1
end_of_record
`;

const COBERTURA = `<?xml version="1.0" ?>
<coverage line-rate="0.8" branch-rate="0.5" version="7.0">
  <packages>
    <package name="pkg">
      <classes>
        <class name="login" filename="src/auth/login.py">
          <lines>
            <line number="1" hits="5"/>
            <line number="2" hits="0"/>
            <line number="3" hits="2" branch="true" condition-coverage="50% (1/2)"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

const GO_COVER = `mode: atomic
example.com/proj/auth/login.go:4.20,6.2 2 1
example.com/proj/auth/login.go:8.10,10.2 2 0
`;

const JEST_FINAL = JSON.stringify({
  '/repo/src/auth/login.ts': { s: { '1': 5, '2': 0, '3': 3 }, statementMap: {} },
});

const ISTANBUL_SUMMARY = JSON.stringify({
  'src/auth/login.ts': { lines: { total: 4, covered: 4, pct: 100 } },
});

test('detects ecosystems from manifests, including multi-ecosystem repos', () => {
  const dir = makeWorkspace({ 'package.json': '{}', 'go.mod': 'module x', 'Cargo.toml': '' });
  try {
    assert.deepEqual(detectCoverageEcosystems(dir), ['js', 'go', 'rust']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parses lcov reports', () => {
  const dir = makeWorkspace({ 'package.json': '{}', 'coverage/lcov.info': LCOV });
  try {
    const report = readCoverageReport(dir, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    assert.ok(report);
    assert.equal(report?.ecosystem, 'js');
    assert.equal(report?.source, 'coverage/lcov.info');
    const login = report?.files.find((f) => f.path === 'src/auth/login.ts');
    assert.equal(login?.linesFound, 10);
    assert.equal(login?.linesHit, 9);
    assert.equal(login?.lineRate, 0.9);
    assert.equal(login?.branchRate, 0.75);
    const thin = report?.files.find((f) => f.path === 'src/utils/format.ts');
    assert.equal(thin?.lineRate, 0.2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parses cobertura xml reports', () => {
  const dir = makeWorkspace({ 'pyproject.toml': '', 'coverage.xml': COBERTURA });
  try {
    const report = readCoverageReport(dir, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    assert.ok(report);
    assert.equal(report?.ecosystem, 'python');
    const login = report?.files.find((f) => f.path === 'src/auth/login.py');
    assert.equal(login?.linesFound, 3);
    assert.equal(login?.linesHit, 2);
    assert.equal(login?.branchesFound, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parses go coverprofiles', () => {
  const dir = makeWorkspace({ 'go.mod': 'module example.com/proj', 'coverage.out': GO_COVER });
  try {
    const report = readCoverageReport(dir, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    assert.ok(report);
    const login = report?.files.find((f) => f.path.endsWith('auth/login.go'));
    assert.equal(login?.linesFound, 4);
    assert.equal(login?.linesHit, 2);
    assert.equal(login?.lineRate, 0.5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parses jest coverage-final.json and istanbul summaries', () => {
  const dir = makeWorkspace({
    'package.json': '{}',
    'coverage/coverage-final.json': JEST_FINAL,
  });
  try {
    const report = readCoverageReport(dir, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    const login = report?.files.find((f) => f.path.endsWith('src/auth/login.ts'));
    assert.equal(login?.linesFound, 3);
    assert.equal(login?.linesHit, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = makeWorkspace({
    'package.json': '{}',
    'coverage/coverage-summary.json': ISTANBUL_SUMMARY,
  });
  try {
    const report = readCoverageReport(dir2, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    assert.equal(report?.files[0]?.lineRate, 1);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('fail-open: missing, stale, oversized, or corrupt reports yield null', () => {
  const empty = makeWorkspace({ 'package.json': '{}' });
  try {
    assert.equal(readCoverageReport(empty), null);
    assert.deepEqual(findCoverageReportFiles(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  const stale = makeWorkspace({ 'package.json': '{}', 'coverage/lcov.info': LCOV });
  try {
    const old = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(path.join(stale, 'coverage/lcov.info'), old / 1000, old / 1000);
    assert.equal(readCoverageReport(stale), null);
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
  const corrupt = makeWorkspace({ 'package.json': '{}', 'coverage.xml': '<not coverage at all' });
  try {
    assert.equal(readCoverageReport(corrupt, { maxAgeMs: Number.MAX_SAFE_INTEGER }), null);
  } finally {
    fs.rmSync(corrupt, { recursive: true, force: true });
  }
});
