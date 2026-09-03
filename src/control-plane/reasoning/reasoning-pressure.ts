import type { ReasoningPressure, RiskLevel } from '../control-plane-state.js';

export interface ComputePressureParams {
  riskLevel: RiskLevel;
  uncertainty?: number;
  blastRadiusScore?: number;
  failureCount: number;
  stagnationScore: number;
  hypothesisCount: number;
  falsifiedCount: number;
  verificationFailures: number;
}

export class ReasoningPressureCalculator {
  static compute(params: ComputePressureParams): ReasoningPressure {
    const riskFactor =
      params.riskLevel === 'CRITICAL'
        ? 1.0
        : params.riskLevel === 'HIGH_RISK'
        ? 0.75
        : params.riskLevel === 'STANDARD'
        ? 0.4
        : 0.1;

    const uncertainty = Math.min(
      1.0,
      (params.uncertainty ?? 0.5) + (params.failureCount > 0 ? 0.2 * params.failureCount : 0),
    );

    const blastRadius = params.blastRadiusScore ?? 0.3;

    const hypothesisEntropy =
      params.hypothesisCount > 0
        ? Math.min(1.0, params.falsifiedCount / params.hypothesisCount)
        : 0;

    return {
      taskRisk: riskFactor,
      uncertainty,
      blastRadius,
      failureCount: params.failureCount,
      stagnationScore: params.stagnationScore,
      hypothesisEntropy,
      verificationFailures: params.verificationFailures,
    };
  }
}
