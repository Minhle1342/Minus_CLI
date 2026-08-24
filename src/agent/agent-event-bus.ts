export interface AgentEvent {
  senderId: string;
  topic: string;
  payload: Record<string, any>;
  timestamp: string;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

/**
 * Event-driven communication backbone for multi-agent systems.
 * Supports loose decoupling through publish-subscribe patterns.
 */
export class AgentEventBus {
  private listeners = new Map<string, Set<AgentEventListener>>();

  subscribe(topic: string, listener: AgentEventListener): void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(listener);
  }

  unsubscribe(topic: string, listener: AgentEventListener): void {
    const topicListeners = this.listeners.get(topic);
    if (topicListeners) {
      topicListeners.delete(listener);
      if (topicListeners.size === 0) {
        this.listeners.delete(topic);
      }
    }
  }

  async publish(senderId: string, topic: string, payload: Record<string, any>): Promise<void> {
    const event: AgentEvent = {
      senderId,
      topic,
      payload,
      timestamp: new Date().toISOString(),
    };

    const topicListeners = this.listeners.get(topic);
    if (!topicListeners) return;

    const promises = Array.from(topicListeners).map(async (listener) => {
      try {
        await listener(event);
      } catch (err) {
        console.error(`Error in event listener for topic '${topic}':`, err);
      }
    });

    await Promise.all(promises);
  }
}
