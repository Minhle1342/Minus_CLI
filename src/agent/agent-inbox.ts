export type AgentInputSource = 'human' | 'system' | 'injected';

export interface AgentInboxItem {
  id: string;
  sessionId: string;
  text: string;
  source: AgentInputSource;
  enqueuedAt: string;
  promise: Promise<string>;
  resolve: (answer: string) => void;
  reject: (error: unknown) => void;
}

/**
 * One inbox for model-visible inputs. Items are claimed only by the driver
 * for their session, so inputs arriving during a running turn wait for the
 * next turn instead of racing a second AgentLoop invocation.
 */
export class AgentInbox {
  private queues = new Map<string, AgentInboxItem[]>();
  private sequence = 0;

  enqueue(
    sessionId: string,
    text: string,
    source: AgentInputSource,
    options: { id?: string; enqueuedAt?: string } = {},
  ): AgentInboxItem {
    const cleanText = text.trim();
    if (!cleanText) throw new Error('Agent inbox input must not be empty.');

    let resolve!: (answer: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const item: AgentInboxItem = {
      id: options.id || `input-${Date.now()}-${this.sequence++}`,
      sessionId,
      text: cleanText,
      source,
      enqueuedAt: options.enqueuedAt || new Date().toISOString(),
      promise,
      resolve,
      reject,
    };

    const queue = this.queues.get(sessionId) || [];
    queue.push(item);
    this.queues.set(sessionId, queue);
    return item;
  }

  restore(
    sessionId: string,
    input: { inputId: string; text: string; source: AgentInputSource; queuedAt: string },
  ): AgentInboxItem {
    const existing = this.queues.get(sessionId)?.find((item) => item.id === input.inputId);
    return existing || this.enqueue(sessionId, input.text, input.source, {
      id: input.inputId,
      enqueuedAt: input.queuedAt,
    });
  }

  claim(sessionId: string): AgentInboxItem | undefined {
    const queue = this.queues.get(sessionId);
    const item = queue?.shift();
    if (queue && queue.length === 0) this.queues.delete(sessionId);
    return item;
  }

  pending(sessionId: string): number {
    return this.queues.get(sessionId)?.length || 0;
  }
}
