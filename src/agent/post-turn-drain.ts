/**
 * Post-turn drain: after a dispatched task settles, run the session's queued
 * inputs one by one with a fresh signal. Must only be invoked once no run is
 * active for that session, otherwise it races the run that owns the queue.
 */
export interface PostTurnDrainOptions {
  isShuttingDown: () => boolean;
  hasActiveRun: () => boolean;
  pending: () => number;
  peek: () => { id: string; text: string } | undefined;
  drainNext: () => Promise<unknown>;
  onItem?: (item: { id: string; text: string }) => void;
  onError?: (error: unknown) => void;
}

export async function drainPostTurnQueue(options: PostTurnDrainOptions): Promise<void> {
  while (!options.isShuttingDown() && !options.hasActiveRun() && options.pending() > 0) {
    const next = options.peek();
    if (!next) break;
    options.onItem?.(next);
    try {
      await options.drainNext();
    } catch (error) {
      options.onError?.(error);
      break;
    }
    // No progress on the head item (e.g. nothing claimed it) — stop instead of looping forever.
    if (options.peek()?.id === next.id) break;
  }
}
