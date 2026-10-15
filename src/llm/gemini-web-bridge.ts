export interface IWebTransport {
  send(payload: string): AsyncIterable<string>;
  cancel(): Promise<void>;
}

/** Cầu web: serialize 1 tab/lượt qua mutex, stream token từng phần. */
export class GeminiWebBridge {
  private tail: Promise<void> = Promise.resolve();

  constructor(private transport: IWebTransport) {}

  async run(payload: string, onToken?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('aborted');
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      if (signal?.aborted) throw new Error('aborted');
      let out = '';
      for await (const chunk of this.transport.send(payload)) {
        if (signal?.aborted) {
          await this.transport.cancel().catch(() => {});
          throw new Error('aborted');
        }
        out += chunk;
        onToken?.(chunk);
      }
      return out;
    } finally {
      release();
    }
  }
}
