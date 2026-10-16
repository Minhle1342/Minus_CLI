import selectors from './selectors.config.json' with { type: 'json' };

export const GEMINI_WEB_SELECTORS: Record<string, string[]> = selectors as Record<string, string[]>;

export interface IWebTransport {
  send(payload: string): AsyncIterable<string>;
  cancel(): Promise<void>;
}

/** Cầu web: serialize 1 tab/lượt qua mutex, stream token từng phần. */
export class GeminiWebBridge {
  private tail: Promise<void> = Promise.resolve();
  private timeoutMs: number;

  constructor(private transport: IWebTransport, opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 120_000;
  }

  async run(payload: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('aborted');
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    const releaseOnce = () => release();
    signal?.addEventListener('abort', releaseOnce, { once: true });
    await prev;
    if (signal?.aborted) {
      release();
      throw new Error('aborted');
    }
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => {
      deadlineTimer = setTimeout(() => rej(new Error('gemini-web timeout')), this.timeoutMs);
    });
    try {
      let out = '';
      const iter = this.transport.send(payload)[Symbol.asyncIterator]();
      const onAbort = signal
        ? new Promise<never>((_, rej) => {
            if (signal.aborted) rej(new Error('aborted'));
            else signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
          })
        : null;
      for (;;) {
        const next = iter.next();
        const timed = onAbort
          ? await Promise.race([next, deadline, onAbort])
          : await Promise.race([next, deadline]);
        const r = timed as IteratorResult<string>;
        if (r.done) break;
        if (signal?.aborted) {
          await this.transport.cancel().catch(() => {});
          throw new Error('aborted');
        }
        out += r.value;
        onToken?.(r.value);
      }
      return out;
    } catch (e) {
      await this.transport.cancel().catch(() => {});
      throw e;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', releaseOnce);
      release();
    }
  }
}
