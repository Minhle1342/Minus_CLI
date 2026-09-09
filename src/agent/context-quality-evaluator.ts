export interface ContextQualitySnapshot {
  steps: number;
  toolRecallAtK: number;
  unnecessaryToolRate: number;
  averageContextPrecisionProxy: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

/** Cheap shadow-mode diagnostics for retrieval/context quality. */
export class ContextQualityEvaluator {
  private steps = 0;
  private expectedTools = 0;
  private retrievedExpectedTools = 0;
  private visibleTools = 0;
  private contextSourceCount = 0;
  private retainedSourceCount = 0;
  private tokensBefore = 0;
  private tokensAfter = 0;

  recordToolRetrieval(visibleToolNames: string[], expectedToolNames: string[]): void {
    this.steps++;
    const visible = new Set(visibleToolNames);
    const expected = [...new Set(expectedToolNames)];
    this.expectedTools += expected.length;
    this.retrievedExpectedTools += expected.filter((name) => visible.has(name)).length;
    this.visibleTools += visible.size;
  }

  recordContextArbitration(input: {
    sourceCount: number;
    retainedSourceCount: number;
    beforeTokens: number;
    afterTokens: number;
  }): void {
    this.contextSourceCount += Math.max(0, input.sourceCount);
    this.retainedSourceCount += Math.max(0, input.retainedSourceCount);
    this.tokensBefore += Math.max(0, input.beforeTokens);
    this.tokensAfter += Math.max(0, input.afterTokens);
  }

  snapshot(): ContextQualitySnapshot {
    const toolRecallAtK = this.expectedTools > 0 ? this.retrievedExpectedTools / this.expectedTools : 1;
    const unnecessary = Math.max(0, this.visibleTools - this.retrievedExpectedTools);
    const unnecessaryToolRate = this.visibleTools > 0 ? unnecessary / this.visibleTools : 0;
    const averageContextPrecisionProxy = this.contextSourceCount > 0
      ? this.retainedSourceCount / this.contextSourceCount
      : 1;
    return {
      steps: this.steps,
      toolRecallAtK: Number(toolRecallAtK.toFixed(4)),
      unnecessaryToolRate: Number(unnecessaryToolRate.toFixed(4)),
      averageContextPrecisionProxy: Number(averageContextPrecisionProxy.toFixed(4)),
      tokensBefore: this.tokensBefore,
      tokensAfter: this.tokensAfter,
      tokensSaved: Math.max(0, this.tokensBefore - this.tokensAfter),
    };
  }
}
