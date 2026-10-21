import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Session id của subagent đang in ra stdout.
 * Loop cha và loop con chạy song song; stdout là kênh chung nên phải gắn nhãn
 * theo ngữ cảnh async để TUI biết dòng này của ai (tab con, không phải tab cha).
 */
const subagentOutputSession = new AsyncLocalStorage<string>();

/** Chạy fn với ngữ cảnh "output thuộc subagent sessionId". */
export function runWithSubagentOutput<T>(sessionId: string, fn: () => T): T {
  return subagentOutputSession.run(sessionId, fn);
}

/** Session id của subagent đang in ra stdout (undefined nếu là agent cha). */
export function currentSubagentOutputSessionId(): string | undefined {
  return subagentOutputSession.getStore();
}
