export interface ObservationRecord {
  toolName: string;
  argsFingerprint: string;
  resultFingerprint: string;
  mutationSeq: number;
  isFailure: boolean;
}

export interface StagnationDecision {
  stagnant: boolean;
  repetitionCount: number;
  reason?: string;
  actionRequired?: string;
}

export class StagnationDetector {
  private history: ObservationRecord[] = [];

  record(observation: ObservationRecord): StagnationDecision {
    this.history.push(observation);
    if (this.history.length > 20) this.history.shift();

    // Check identical recent repetitions
    let repetitions = 0;
    const latest = observation;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i];
      if (
        item.toolName === latest.toolName &&
        item.argsFingerprint === latest.argsFingerprint &&
        item.resultFingerprint === latest.resultFingerprint &&
        item.mutationSeq === latest.mutationSeq
      ) {
        repetitions++;
      } else {
        break;
      }
    }

    if (repetitions >= 3) {
      return {
        stagnant: true,
        repetitionCount: repetitions,
        reason: `Tool '${latest.toolName}' executed with identical arguments and returned identical results ${repetitions} times without workspace mutation.`,
        actionRequired: 'SWITCH_STRATEGY',
      };
    }

    // Check alternating ping-pong (e.g. A -> B -> A -> B)
    if (this.history.length >= 4) {
      const len = this.history.length;
      const h0 = this.history[len - 4];
      const h1 = this.history[len - 3];
      const h2 = this.history[len - 2];
      const h3 = this.history[len - 1];

      if (
        h0.toolName === h2.toolName &&
        h1.toolName === h3.toolName &&
        h0.argsFingerprint === h2.argsFingerprint &&
        h1.argsFingerprint === h3.argsFingerprint &&
        h0.toolName !== h1.toolName
      ) {
        return {
          stagnant: true,
          repetitionCount: 2,
          reason: `Detected alternating ping-pong loop between '${h0.toolName}' and '${h1.toolName}'.`,
          actionRequired: 'SWITCH_STRATEGY',
        };
      }
    }

    return {
      stagnant: false,
      repetitionCount: repetitions,
    };
  }

  reset(): void {
    this.history = [];
  }
}
