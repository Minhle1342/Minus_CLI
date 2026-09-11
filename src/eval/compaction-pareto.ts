export interface PairedCompactionSample {
  taskId: string;
  baselinePassed: boolean;
  candidatePassed: boolean;
  candidateCost: number;
  candidateLatencyMs: number;
  hardBudgetOverflow?: boolean;
  falseVerification?: boolean;
  invariantFailure?: boolean;
}

export interface ParetoCandidateReport {
  id: string;
  samples: PairedCompactionSample[];
  passRate: number;
  baselinePassRate: number;
  qualityDelta: number;
  qualityDeltaLower95: number;
  meanCost: number;
  p95LatencyMs: number;
  requiredPairedRuns: number;
  statisticallyConclusive: boolean;
  safe: boolean;
  nonInferior: boolean;
  feasible: boolean;
  dominated: boolean;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

function createRandom(seed = 0x51f15e): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function requiredPairedRunsForNonInferiority(
  discordanceRate: number,
  margin = 0.01,
  alphaOneSided = 0.05,
  power = 0.8,
): number {
  // z values are fixed for the registered production gate (alpha=.05,
  // power=.80). Parameters remain explicit so reports record the contract.
  const zAlpha = alphaOneSided === 0.05 ? 1.644854 : 1.959964;
  const zPower = power === 0.8 ? 0.841621 : 1.281552;
  const effectiveDiscordance = Math.max(0.01, Math.min(1, discordanceRate));
  return Math.ceil(((zAlpha + zPower) ** 2 * effectiveDiscordance) / (margin ** 2));
}

function pairedBootstrapLowerBound(samples: PairedCompactionSample[], iterations = 4_000): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;
  const random = createRandom();
  const deltas: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let delta = 0;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[Math.floor(random() * samples.length)];
      delta += Number(sample.candidatePassed) - Number(sample.baselinePassed);
    }
    deltas.push(delta / samples.length);
  }
  return quantile(deltas, 0.05);
}

export function evaluateParetoCandidate(
  id: string,
  samples: PairedCompactionSample[],
  nonInferiorityMargin = 0.01,
): ParetoCandidateReport {
  const total = Math.max(1, samples.length);
  const passRate = samples.filter((sample) => sample.candidatePassed).length / total;
  const baselinePassRate = samples.filter((sample) => sample.baselinePassed).length / total;
  const discordant = samples.filter((sample) => sample.baselinePassed !== sample.candidatePassed).length / total;
  const requiredPairedRuns = requiredPairedRunsForNonInferiority(discordant, nonInferiorityMargin);
  const qualityDeltaLower95 = pairedBootstrapLowerBound(samples);
  const safe = samples.every((sample) => (
    !sample.hardBudgetOverflow
    && !sample.falseVerification
    && !sample.invariantFailure
  ));
  const statisticallyConclusive = samples.length >= requiredPairedRuns;
  const nonInferior = qualityDeltaLower95 >= -nonInferiorityMargin;
  return {
    id,
    samples,
    passRate,
    baselinePassRate,
    qualityDelta: passRate - baselinePassRate,
    qualityDeltaLower95,
    meanCost: samples.reduce((sum, sample) => sum + sample.candidateCost, 0) / total,
    p95LatencyMs: quantile(samples.map((sample) => sample.candidateLatencyMs), 0.95),
    requiredPairedRuns,
    statisticallyConclusive,
    safe,
    nonInferior,
    feasible: safe && statisticallyConclusive && nonInferior,
    dominated: false,
  };
}

export function selectParetoCandidate(reports: ParetoCandidateReport[]): {
  reports: ParetoCandidateReport[];
  selected?: ParetoCandidateReport;
  verdict: 'SELECTED' | 'INCONCLUSIVE';
} {
  const annotated = reports.map((report) => ({ ...report }));
  for (const candidate of annotated) {
    candidate.dominated = annotated.some((other) => (
      other.id !== candidate.id
      && other.safe
      && other.nonInferior
      && other.qualityDelta >= candidate.qualityDelta
      && other.meanCost <= candidate.meanCost
      && (other.qualityDelta > candidate.qualityDelta || other.meanCost < candidate.meanCost)
    ));
  }
  const selected = annotated
    .filter((report) => report.feasible && !report.dominated)
    .sort((left, right) => (
      left.meanCost - right.meanCost
      || left.p95LatencyMs - right.p95LatencyMs
      || left.id.localeCompare(right.id)
    ))[0];
  return { reports: annotated, selected, verdict: selected ? 'SELECTED' : 'INCONCLUSIVE' };
}
