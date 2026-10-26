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
  /** Machine-readable notice type, e.g. "background-task-completed". */
  kind?: string;
  /** Files the failed subagent touched — parent takeover is only proven by touching one. */
  takeoverFiles?: string[];
}

/** True khi item là thông báo hệ thống về background task (claim thì mở khóa manage_task). */
export function isBackgroundTaskNotice(item: Pick<AgentInboxItem, 'kind'>): boolean {
  return typeof item.kind === 'string' && item.kind.startsWith('background-task');
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
    options: { id?: string; enqueuedAt?: string; isSteering?: boolean; kind?: string; takeoverFiles?: string[] } = {},
  ): AgentInboxItem {
    const cleanText = text.trim();
    if (!cleanText) throw new Error('Agent inbox input must not be empty.');

    let resolve!: (answer: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Fire-and-forget steering is supported. Keep the original promise rejected
    // for consumers while observing an otherwise orphaned cancellation/failure.
    void promise.catch(() => {});
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
      kind: options.kind,
      takeoverFiles: options.takeoverFiles,
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
    input: { inputId: string; text: string; source: AgentInputSource; queuedAt: string; isSteering?: boolean },
  ): AgentInboxItem {
    const existing = this.queues.get(sessionId)?.find((item) => item.id === input.inputId);
    return existing || this.enqueue(sessionId, input.text, input.source, {
      id: input.inputId,
      enqueuedAt: input.queuedAt,
      isSteering: input.isSteering,
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

    // Background-task notices never steer a step: the turn-end gate claims them.
    const isClaimable = (item: AgentInboxItem) => item.isSteering === true && !isBackgroundTaskNotice(item);

    if (onlyExplicitSteering) {
      const idx = queue.findIndex(isClaimable);
      if (idx === -1) return undefined;
      const [item] = queue.splice(idx, 1);
      if (queue.length === 0) this.queues.delete(sessionId);
      return item;
    }

    const claimableIdx = queue.findIndex(isClaimable);
    if (claimableIdx === 0) return this.claim(sessionId);
    if (claimableIdx === -1) return undefined;
    // Đầu hàng đợi là notice nền → claim item claimable phía sau, giữ notice tại chỗ.
    const [item] = queue.splice(claimableIdx, 1);
    if (queue.length === 0) this.queues.delete(sessionId);
    return item;
  }

  /** Dequeue notice nền đầu tiên — chỉ gate cuối turn được gọi. */
  claimBackgroundNotice(sessionId: string): AgentInboxItem | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue) return undefined;
    const idx = queue.findIndex(isBackgroundTaskNotice);
    if (idx === -1) return undefined;
    const [item] = queue.splice(idx, 1);
    if (queue.length === 0) this.queues.delete(sessionId);
    return item;
  }

  /**
   * Xem trước tin nhắn đầu hàng đợi mà không lấy ra
   */
  peek(sessionId: string): AgentInboxItem | undefined {
    return this.queues.get(sessionId)?.[0];
  }

  /** True khi session còn item chưa claim có `kind` bắt đầu bằng prefix (vd "background-task"). */
  hasPendingKind(sessionId: string, kindPrefix: string): boolean {
    return (this.queues.get(sessionId) || []).some((item) =>
      typeof item.kind === 'string' && item.kind.startsWith(kindPrefix));
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
