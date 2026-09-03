import path from 'node:path';
import type { BlastRadiusEstimate, RiskLevel } from '../control-plane-state.js';

export class MutationImpactAnalyzer {
  /**
   * Analyzes changed file paths and symbols to estimate the blast radius and risk level.
   */
  static analyze(params: {
    changedFiles: string[];
    affectedSymbols?: string[];
    registeredFiles?: string[];
  }): BlastRadiusEstimate {
    const { changedFiles, affectedSymbols = [], registeredFiles = [] } = params;

    if (changedFiles.length === 0) {
      return {
        risk: 'MINIMAL',
        estimatedFiles: [],
        estimatedSymbols: [],
        score: 0.1,
      };
    }

    let riskScore = 0.2;
    const estimatedFiles = new Set<string>(changedFiles);

    for (const f of changedFiles) {
      const lower = f.toLowerCase().replace(/\\/g, '/');

      // Detect high-risk core modules
      if (
        lower.includes('auth') ||
        lower.includes('security') ||
        lower.includes('permission') ||
        lower.includes('session') ||
        lower.includes('token')
      ) {
        riskScore = Math.max(riskScore, 0.85);
      } else if (
        lower.includes('kernel') ||
        lower.includes('database') ||
        lower.includes('migration') ||
        lower.includes('schema') ||
        lower.includes('config') ||
        lower.includes('control-plane')
      ) {
        riskScore = Math.max(riskScore, 0.75);
      } else if (
        lower.includes('middleware') ||
        lower.includes('router') ||
        lower.includes('server') ||
        lower.includes('dispatcher')
      ) {
        riskScore = Math.max(riskScore, 0.6);
      }

      // Add related test files to estimated affected scope
      const parsed = path.parse(f);
      const ext = parsed.ext;
      const base = parsed.name;

      if (!base.includes('.test') && !base.includes('.spec') && !base.startsWith('test_')) {
        const testCandidate1 = path.join(parsed.dir, `${base}.test${ext}`);
        const testCandidate2 = path.join(parsed.dir, `${base}.spec${ext}`);
        const testCandidate3 = path.join(parsed.dir, '__tests__', `${base}.test${ext}`);
        estimatedFiles.add(testCandidate1.replace(/\\/g, '/'));
        estimatedFiles.add(testCandidate2.replace(/\\/g, '/'));
        estimatedFiles.add(testCandidate3.replace(/\\/g, '/'));
      }
    }

    // Scale by number of files modified
    if (changedFiles.length > 5) {
      riskScore = Math.max(riskScore, 0.8);
    } else if (changedFiles.length > 2) {
      riskScore = Math.max(riskScore, 0.5);
    }

    // Check for unregistered files in locked scopes
    if (registeredFiles.length > 0) {
      const unregistered = changedFiles.filter((f) => !registeredFiles.includes(f));
      if (unregistered.length > 0) {
        riskScore = Math.max(riskScore, 0.9);
      }
    }

    let risk: RiskLevel = 'STANDARD';
    if (riskScore >= 0.85) risk = 'CRITICAL';
    else if (riskScore >= 0.65) risk = 'HIGH_RISK';
    else if (riskScore <= 0.25) risk = 'MINIMAL';

    return {
      risk,
      estimatedFiles: Array.from(estimatedFiles),
      estimatedSymbols: [...affectedSymbols],
      score: riskScore,
    };
  }

  /**
   * Determines if a modified file affects a given test or evidence target.
   */
  static doesMutationAffectEvidence(params: {
    mutatedFile: string;
    evidenceAffectedFiles?: string[];
    evidenceTarget?: string;
  }): boolean {
    const { mutatedFile, evidenceAffectedFiles = [], evidenceTarget } = params;

    const normMutated = mutatedFile.toLowerCase().replace(/\\/g, '/');

    // Direct match
    if (evidenceAffectedFiles.some((f) => f.toLowerCase().replace(/\\/g, '/') === normMutated)) {
      return true;
    }

    if (evidenceTarget) {
      const normTarget = evidenceTarget.toLowerCase().replace(/\\/g, '/');
      if (normTarget === normMutated || normTarget.includes(normMutated) || normMutated.includes(normTarget)) {
        return true;
      }
    }

    // Related test file check
    const mutatedBase = path.parse(normMutated).name.replace(/\.(test|spec)$/, '');
    for (const f of evidenceAffectedFiles) {
      const targetBase = path.parse(f.toLowerCase().replace(/\\/g, '/')).name.replace(/\.(test|spec)$/, '');
      if (mutatedBase === targetBase) {
        return true;
      }
    }

    // If evidence is global test/build run without specific files, any source mutation affects it
    if (evidenceAffectedFiles.length === 0) {
      return true;
    }

    return false;
  }
}
