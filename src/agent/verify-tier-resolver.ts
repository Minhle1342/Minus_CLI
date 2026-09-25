/**
 * Single source of truth mapping measured edit impact to a verification tier.
 *
 * All inputs are harness-measured (file counts, caller data, classification
 * risk) — never LLM self-assessment. Consumers (verification-policy,
 * submit_solution auditor, critic-gate) must share this module so the
 * "long edit / large impact" definition cannot drift between gates.
 */

export type VerifyLevel = 'LOW' | 'HIGH' | 'CRITICAL';
export type VerifyMinTier = 'inherit' | 'full_test';

export interface VerifyTierInput {
  changedFileCount: number;
  /** True when an edited symbol has known callers/consumers. */
  hasCallers: boolean;
  /** Classification risk R0..R5. */
  classificationRisk?: string;
  /** Measured blast risk LOW|MEDIUM|HIGH|CRITICAL, when available. */
  blastRisk?: string;
  /** True when a touched path is auth/payment/migration/security-adjacent. */
  sensitivePathTouched?: boolean;
}

export interface VerifyTierDecision {
  level: VerifyLevel;
  /** Minimum verification tier; 'inherit' defers to the existing risk ladder. */
  minTier: VerifyMinTier;
  reasons: string[];
}

function resolveMinFiles(value: string | undefined, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function verifyHighMinFiles(): number {
  return resolveMinFiles(process.env.MINUS_VERIFY_HIGH_MIN_FILES, 3);
}

export function verifyCriticalMinFiles(): number {
  return resolveMinFiles(process.env.MINUS_VERIFY_CRITICAL_MIN_FILES, 10);
}

const SENSITIVE_PATH_HINTS = [
  'auth', 'login', 'payment', 'billing', 'checkout',
  'migrat', 'permission', 'security', 'crypto', 'secret',
];

export function isSensitivePath(filePath: string): boolean {
  const normalized = (filePath || '').replace(/\\/g, '/').toLowerCase();
  return SENSITIVE_PATH_HINTS.some((hint) => normalized.includes(hint));
}

function normalizeRisk(risk?: string): string {
  return (risk || '').trim().toUpperCase();
}

/**
 * Resolves the verification level from measured impact. Conservative by
 * construction: every rule can only escalate, never downgrade.
 */
export function resolveVerifyTier(input: VerifyTierInput): VerifyTierDecision {
  const reasons: string[] = [];
  const files = Math.max(0, Math.floor(input.changedFileCount || 0));
  const risk = normalizeRisk(input.classificationRisk);
  const blast = normalizeRisk(input.blastRisk);
  const highMinFiles = verifyHighMinFiles();
  const criticalMinFiles = verifyCriticalMinFiles();

  if (['R4', 'R5'].includes(risk) || blast === 'CRITICAL') {
    reasons.push(risk ? `classification risk ${risk}` : 'measured blast CRITICAL');
    return { level: 'CRITICAL', minTier: 'full_test', reasons };
  }
  if (files >= criticalMinFiles) {
    reasons.push(`${files} files changed (≥${criticalMinFiles})`);
    return { level: 'CRITICAL', minTier: 'full_test', reasons };
  }
  if (input.sensitivePathTouched) {
    reasons.push('touched auth/payment/migration-adjacent path');
    return { level: 'CRITICAL', minTier: 'full_test', reasons };
  }
  if (risk === 'R3' || blast === 'HIGH') {
    reasons.push(risk === 'R3' ? 'classification risk R3' : 'measured blast HIGH');
    return { level: 'HIGH', minTier: 'full_test', reasons };
  }
  if (input.hasCallers) {
    reasons.push('edited symbol has known callers');
    return { level: 'HIGH', minTier: 'full_test', reasons };
  }
  if (files >= highMinFiles) {
    reasons.push(`${files} files changed (≥${highMinFiles})`);
    return { level: 'HIGH', minTier: 'full_test', reasons };
  }
  return { level: 'LOW', minTier: 'inherit', reasons };
}
