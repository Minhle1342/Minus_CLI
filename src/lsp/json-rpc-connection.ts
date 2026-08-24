import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type NotificationHandler = (params: any) => void;
type RequestHandler = (params: any) => any | Promise<any>;

/** Minimal LSP JSON-RPC 2.0 transport using Content-Length framing over stdio. */
export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly defaultTimeoutMs: number,
  ) {
    process.stdout.on('data', (chunk: Buffer | string) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.once('error', (error) => this.close(error));
    process.once('exit', (code, signal) => this.close(new Error(`LSP process exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`)));
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) || new Set<NotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => this.requestHandlers.delete(method);
  }

  async request<T = any>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.closed) throw new Error('LSP JSON-RPC connection is closed.');
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method} (${timeoutMs}ms).`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  dispose(reason = new Error('LSP connection disposed.')): void {
    this.close(reason);
  }

  private write(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.process.stdin.write(Buffer.concat([header, body]));
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // Invalid server frames are ignored; valid pending requests still retain their timeout.
      }
    }
  }

  private dispatch(message: any): void {
    if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(`LSP error ${message.error.code ?? ''}: ${message.error.message || 'Unknown error'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message && typeof message.method === 'string' && message.id !== undefined) {
      const handler = this.requestHandlers.get(message.method);
      if (!handler) {
        this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.params))
        .then((result) => this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
        .catch((error: any) => this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message || 'Client request failed' } }));
      return;
    }
    if (message && typeof message.method === 'string' && message.id === undefined) {
      for (const handler of this.notificationHandlers.get(message.method) || []) {
        try { handler(message.params); } catch {}
      }
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
