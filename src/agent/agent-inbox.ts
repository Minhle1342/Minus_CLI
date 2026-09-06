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
  isSteering?: boolean;
}

/**
 * One inbox for model-visible inputs. Items are claimed only by the driver
 * for their session, so inputs arriving during a running turn wait for the
 * next turn instead of racing a second AgentLoop invocation.
 */
export class AgentInbox {
  private queues = new Map<string, AgentInboxItem[]>();
  private sequence = 0;
  private wakeupListeners = new Set<(sessionId: string, item: AgentInboxItem) => void>();

  /**
   * Đăng ký listener lắng nghe sự kiện khi có tin nhắn mới được đưa vào queue (Reactive Wakeup)
   */
  onWakeup(listener: (sessionId: string, item: AgentInboxItem) => void): () => void {
    this.wakeupListeners.add(listener);
    return () => {
      this.wakeupListeners.delete(listener);
    };
  }

  enqueue(
    sessionId: string,
    text: string,
    source: AgentInputSource,
    options: { id?: string; enqueuedAt?: string; isSteering?: boolean } = {},
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
      isSteering: options.isSteering,
    };

    const queue = this.queues.get(sessionId) || [];
    queue.push(item);
    this.queues.set(sessionId, queue);

    // Kích hoạt Reactive Wakeup cho các tiến trình / timers đang chờ
    for (const listener of this.wakeupListeners) {
      try {
        listener(sessionId, item);
      } catch {}
    }

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

  /**
   * Lấy tin nhắn tiếp theo trong queue để bẻ lái giữa chừng (Mid-Turn Steerability).
   * Khi onlyExplicitSteering = true (ví dụ đang drain inbox cho các turn tuần tự),
   * chỉ claim những tin nhắn được đánh dấu rõ ràng là bẻ lái (isSteering: true).
   */
  claimSteerMessage(sessionId: string, onlyExplicitSteering = false): AgentInboxItem | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return undefined;

    if (onlyExplicitSteering) {
      const idx = queue.findIndex((item) => item.isSteering === true);
      if (idx === -1) return undefined;
      const [item] = queue.splice(idx, 1);
      if (queue.length === 0) this.queues.delete(sessionId);
      return item;
    }

    return this.claim(sessionId);
  }

  /**
   * Xem trước tin nhắn đầu hàng đợi mà không lấy ra
   */
  peek(sessionId: string): AgentInboxItem | undefined {
    return this.queues.get(sessionId)?.[0];
  }

  /**
   * Lấy danh sách toàn bộ tin nhắn đang chờ trong queue của session
   */
  getQueue(sessionId: string): AgentInboxItem[] {
    return [...(this.queues.get(sessionId) || [])];
  }

  /**
   * Hủy một tin nhắn cụ thể trong queue trước khi nó được claim
   */
  cancel(sessionId: string, inputId: string, reason = 'Cancelled by user'): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return false;

    const index = queue.findIndex((item) => item.id === inputId);
    if (index === -1) return false;

    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(sessionId);

    removed.reject(new Error(reason));
    return true;
  }

  /**
   * Xóa sạch tất cả tin nhắn đang chờ trong queue của session
   */
  clear(sessionId: string, reason = 'Queue cleared by user'): number {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return 0;

    const count = queue.length;
    this.queues.delete(sessionId);

    for (const item of queue) {
      try {
        item.reject(new Error(reason));
      } catch {}
    }

    return count;
  }

  pending(sessionId: string): number {
    return this.queues.get(sessionId)?.length || 0;
  }
}
