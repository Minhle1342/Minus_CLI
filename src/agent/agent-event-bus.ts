export interface AgentEvent {
  senderId: string;
  topic: string;
  payload: Record<string, any>;
  timestamp: string;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

/**
 * Event-driven communication backbone for multi-agent systems.
 * Supports loose decoupling through publish-subscribe patterns,
 * topic wildcards, and bounded event history caching.
 */
export class AgentEventBus {
  private listeners = new Map<string, Set<AgentEventListener>>();
  private eventHistory: AgentEvent[] = [];
  private readonly maxHistory: number;

  constructor(options?: { maxHistory?: number }) {
    this.maxHistory = options?.maxHistory ?? 100;
  }

  subscribe(topic: string, listener: AgentEventListener): void {
    const cleanTopic = topic.trim();
    if (!this.listeners.has(cleanTopic)) {
      this.listeners.set(cleanTopic, new Set());
    }
    this.listeners.get(cleanTopic)!.add(listener);
  }

  unsubscribe(topic: string, listener: AgentEventListener): void {
    const cleanTopic = topic.trim();
    const topicListeners = this.listeners.get(cleanTopic);
    if (topicListeners) {
      topicListeners.delete(listener);
      if (topicListeners.size === 0) {
        this.listeners.delete(cleanTopic);
      }
    }
  }

  listenerCount(topic?: string): number {
    if (topic) {
      return this.listeners.get(topic.trim())?.size || 0;
    }
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }

  async publish(senderId: string, topic: string, payload: Record<string, any>): Promise<void> {
    const cleanTopic = topic.trim();
    const event: AgentEvent = {
      senderId: senderId.trim(),
      topic: cleanTopic,
      payload,
      timestamp: new Date().toISOString(),
    };

    // Bounded Ring Buffer for Event History
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    // Collect direct listeners and wildcard listeners
    const matchedListeners = new Set<AgentEventListener>();

    for (const [registeredTopic, listeners] of this.listeners.entries()) {
      if (
        registeredTopic === cleanTopic ||
        registeredTopic === '*' ||
        (registeredTopic.endsWith('*') && cleanTopic.startsWith(registeredTopic.slice(0, -1)))
      ) {
        for (const l of listeners) {
          matchedListeners.add(l);
        }
      }
    }

    if (matchedListeners.size === 0) return;

    const promises = Array.from(matchedListeners).map(async (listener) => {
      try {
        await listener(event);
      } catch (err) {
        console.error(`Error in event listener for topic '${cleanTopic}':`, err);
      }
    });

    await Promise.all(promises);
  }

  /**
   * Lấy danh sách các sự kiện gần nhất (hỗ trợ lọc theo topic).
   */
  getRecentEvents(topic?: string, limit = 20): AgentEvent[] {
    let filtered = this.eventHistory;
    if (topic) {
      const cleanTopic = topic.trim();
      filtered = filtered.filter(
        (e) =>
          e.topic === cleanTopic ||
          (cleanTopic.endsWith('*') && e.topic.startsWith(cleanTopic.slice(0, -1))),
      );
    }
    return filtered.slice(-limit).map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  /**
   * Xóa bộ đệm lịch sử sự kiện.
   */
  clearHistory(): void {
    this.eventHistory = [];
  }
}
