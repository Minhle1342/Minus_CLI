export class StrategySwitcher {
  private static readonly STRATEGY_LADDER = [
    'TEXT_SEARCH',
    'SYMBOL_INSPECTION',
    'CALL_GRAPH_ANALYSIS',
    'ISOLATED_REPRODUCTION',
    'FORM_NEW_HYPOTHESIS',
    'ESCALATE_REASONING',
  ];

  static recommendNextStrategy(currentStrategy: string, failureCount: number): string {
    const idx = this.STRATEGY_LADDER.indexOf(currentStrategy);
    if (idx >= 0 && idx < this.STRATEGY_LADDER.length - 1) {
      return this.STRATEGY_LADDER[idx + 1];
    }
    return this.STRATEGY_LADDER[Math.min(failureCount, this.STRATEGY_LADDER.length - 1)];
  }
}
