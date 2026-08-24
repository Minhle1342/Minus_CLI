export type TimerCondition = 'never' | 'any' | string;

export interface ScheduleItem {
  id: string;
  type: 'one_shot' | 'cron';
  prompt: string;
  durationSeconds?: number;
  cronExpression?: string;
  timerCondition?: TimerCondition;
  maxIterations?: number;
  currentIterations: number;
  status: 'active' | 'triggered' | 'cancelled';
  createdAt: number;
  expiresAt?: number;
  timerHandle?: NodeJS.Timeout;
}

export type ScheduleNotificationHandler = (notification: {
  scheduleId: string;
  prompt: string;
  type: 'one_shot' | 'cron';
  iteration?: number;
}) => void;

/**
 * ScheduleManager - Quản lý Hẹn giờ (One-shot Timers) và Lập lịch Định kỳ (Recurring Cron)
 * Chuẩn Google Antigravity CLI: Reactive Wakeup không cần polling liên tục.
 */
export class ScheduleManager {
  private schedules = new Map<string, ScheduleItem>();
  private scheduleCounter = 0;
  private notificationHandlers: ScheduleNotificationHandler[] = [];

  onNotification(handler: ScheduleNotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  private dispatchNotification(schedule: ScheduleItem): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler({
          scheduleId: schedule.id,
          prompt: schedule.prompt,
          type: schedule.type,
          iteration: schedule.type === 'cron' ? schedule.currentIterations : undefined,
        });
      } catch {}
    }
  }

  /**
   * Đặt hẹn giờ 1 lần (One-shot Timer)
   */
  scheduleOneShot(options: {
    durationSeconds: number;
    prompt: string;
    timerCondition?: TimerCondition;
  }): ScheduleItem {
    this.scheduleCounter++;
    const id = `schedule_${this.scheduleCounter}`;
    const durationMs = Math.max(100, options.durationSeconds * 1000);
    const expiresAt = Date.now() + durationMs;

    const item: ScheduleItem = {
      id,
      type: 'one_shot',
      prompt: options.prompt,
      durationSeconds: options.durationSeconds,
      timerCondition: options.timerCondition || 'never',
      currentIterations: 0,
      status: 'active',
      createdAt: Date.now(),
      expiresAt,
    };

    item.timerHandle = setTimeout(() => {
      if (item.status === 'active') {
        item.status = 'triggered';
        this.dispatchNotification(item);
      }
    }, durationMs);

    this.schedules.set(id, item);
    return item;
  }

  /**
   * Đặt lịch định kỳ (Recurring Cron / Interval)
   */
  scheduleCron(options: {
    cronExpression: string;
    prompt: string;
    maxIterations?: number;
  }): ScheduleItem {
    this.scheduleCounter++;
    const id = `schedule_${this.scheduleCounter}`;
    const intervalMs = this.parseCronToIntervalMs(options.cronExpression);

    const item: ScheduleItem = {
      id,
      type: 'cron',
      prompt: options.prompt,
      cronExpression: options.cronExpression,
      maxIterations: options.maxIterations,
      currentIterations: 0,
      status: 'active',
      createdAt: Date.now(),
    };

    const runRecurring = () => {
      if (item.status !== 'active') return;
      item.currentIterations++;
      this.dispatchNotification(item);

      if (item.maxIterations && item.currentIterations >= item.maxIterations) {
        item.status = 'triggered';
        return;
      }

      item.timerHandle = setTimeout(runRecurring, intervalMs);
    };

    item.timerHandle = setTimeout(runRecurring, intervalMs);
    this.schedules.set(id, item);
    return item;
  }

  /**
   * Xử lý điều kiện Early-Cancellation khi có sự kiện từ senderId hoặc bất kỳ sender nào
   */
  handleIncomingEvent(senderId?: string): ScheduleItem[] {
    const cancelled: ScheduleItem[] = [];
    for (const schedule of this.schedules.values()) {
      if (schedule.status !== 'active' || schedule.type !== 'one_shot') continue;

      const condition = schedule.timerCondition;
      if (condition === 'any' || (senderId && condition === senderId)) {
        this.cancelSchedule(schedule.id);
        cancelled.push(schedule);
      }
    }
    return cancelled;
  }

  /**
   * Hủy một lịch hẹn giờ
   */
  cancelSchedule(scheduleId: string): boolean {
    const item = this.schedules.get(scheduleId);
    if (!item || item.status !== 'active') return false;

    if (item.timerHandle) {
      clearTimeout(item.timerHandle);
    }
    item.status = 'cancelled';
    return true;
  }

  /**
   * Liệt kê tất cả các schedules
   */
  listSchedules(): Array<Omit<ScheduleItem, 'timerHandle'>> {
    return Array.from(this.schedules.values()).map((s) => ({
      id: s.id,
      type: s.type,
      prompt: s.prompt,
      durationSeconds: s.durationSeconds,
      cronExpression: s.cronExpression,
      timerCondition: s.timerCondition,
      maxIterations: s.maxIterations,
      currentIterations: s.currentIterations,
      status: s.status,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
  }

  /**
   * Dọn dẹp toàn bộ timers
   */
  dispose(): void {
    for (const item of this.schedules.values()) {
      if (item.timerHandle) {
        clearTimeout(item.timerHandle);
      }
    }
    this.schedules.clear();
  }

  private parseCronToIntervalMs(cron: string): number {
    const trimmed = cron.trim();
    // Parse */N * * * * (chạy mỗi N phút)
    const match = trimmed.match(/^\*\/(\d+)/);
    if (match) {
      const minutes = parseInt(match[1], 10);
      return Math.max(1, minutes) * 60 * 1000;
    }
    // Mặc định: 60 giây
    return 60 * 1000;
  }
}
