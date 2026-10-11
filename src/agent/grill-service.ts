import type { GrillSuggestContext } from './grill-suggest.js';

export interface GrillAskResult {
  picked: string | null;
  capped?: boolean;
  headless?: boolean;
}

export type GrillPromptHandler = (
  question: string,
  ctx: GrillSuggestContext,
  sessionId?: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/** Max model-initiated questions per (session, turn); over it the tool tells the model to proceed. */
const MAX_GRILL_PER_TURN = 2;

/**
 * Loop-side bridge to the interactive grill modal (mirror of PermissionManager's
 * prompt handler). Without a handler (headless, tests) ask() resolves headless
 * instead of hanging the turn.
 */
export class GrillService {
  private promptHandler?: GrillPromptHandler;
  private callsByTurn = new Map<string, number>();

  setPromptHandler(handler: GrillPromptHandler | undefined): void {
    this.promptHandler = handler;
  }

  async ask(
    question: string,
    ctx: GrillSuggestContext = {},
    sessionId?: string,
    turn?: number,
    signal?: AbortSignal,
  ): Promise<GrillAskResult> {
    if (!this.promptHandler) return { picked: null, headless: true };
    if (typeof turn === 'number') {
      const key = `${sessionId || ''}:${turn}`;
      const count = (this.callsByTurn.get(key) || 0) + 1;
      this.callsByTurn.set(key, count);
      if (this.callsByTurn.size > 200) this.callsByTurn.clear();
      if (count > MAX_GRILL_PER_TURN) return { picked: null, capped: true };
    }
    const picked = await this.promptHandler(question, ctx, sessionId, signal);
    return { picked: picked ?? null };
  }
}
