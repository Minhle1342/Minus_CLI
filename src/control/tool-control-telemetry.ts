import type { ClassificationDecision } from './classification-types.js';
import type { ThisTurnToolDecision } from './this-turn-tool-gate.js';

export interface ToolControlMetrics {
  decisions: number;
  toolsBefore: number;
  toolsAfter: number;
  schemaTokensSaved: number;
  deniedCalls: number;
}

export class ToolControlTelemetry {
  private metrics: ToolControlMetrics = { decisions: 0, toolsBefore: 0, toolsAfter: 0, schemaTokensSaved: 0, deniedCalls: 0 };

  recordDecision(classification: ClassificationDecision, decision: ThisTurnToolDecision): void {
    void classification;
    this.metrics.decisions++;
    this.metrics.toolsBefore += decision.allowedToolNames.length + decision.deniedToolNames.length;
    this.metrics.toolsAfter += decision.allowedToolNames.length;
    this.metrics.schemaTokensSaved += Math.max(0, decision.schemaTokensBefore - decision.schemaTokensAfter);
  }

  recordDeniedCall(): void { this.metrics.deniedCalls++; }
  snapshot(): Readonly<ToolControlMetrics> { return { ...this.metrics }; }
  reset(): void { this.metrics = { decisions: 0, toolsBefore: 0, toolsAfter: 0, schemaTokensSaved: 0, deniedCalls: 0 }; }
}
