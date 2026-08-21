import { Session } from '../session/session.js';

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface PlanTask {
  id: number;
  title: string;
  status: TaskStatus;
  notes?: string;
}

/**
 * PlanManager - Quản lý Cây kế hoạch động (Dynamic Execution Plan Tree)
 * 
 * Giúp Coding Agent:
 * 1. Phân rã mục tiêu lớn thành các bước rõ ràng (Decomposition).
 * 2. Theo dõi tiến độ từng nhiệm vụ (Pending -> In Progress -> Completed/Failed).
 * 3. Tránh việc LLM bị lạc lối trong các vòng lặp dài (30 steps).
 */
export class PlanManager {
  private tasks: PlanTask[] = [];
  private session?: Session;

  bindSession(session: Session): void {
    if (this.session === session) return;

    this.session = session;
    const planEvent = session
      .getEvents()
      .filter((event) => event.type === 'plan/change')
      .at(-1);
    this.tasks = (planEvent?.data.plan || []).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status as TaskStatus,
      ...(task.notes ? { notes: task.notes } : {}),
    }));
  }

  /**
   * Khởi tạo hoặc thay thế kế hoạch mới
   */
  createPlan(tasks: Array<{ id?: number; title: string }>): PlanTask[] {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Plan requires at least one task.');
    }

    const normalizedTasks = tasks.map((task, index): PlanTask => {
      if (!task || typeof task !== 'object' || typeof task.title !== 'string' || !task.title.trim()) {
        throw new Error(`Invalid plan task at index ${index}: title must be a non-empty string.`);
      }
      if (task.id !== undefined && (!Number.isInteger(task.id) || task.id < 1)) {
        throw new Error(`Invalid plan task at index ${index}: id must be a positive integer.`);
      }

      return {
        id: task.id ?? index + 1,
        title: task.title.trim(),
        status: index === 0 ? 'IN_PROGRESS' : 'PENDING',
      };
    });

    this.tasks = normalizedTasks;
    this.persist('created');
    return [...this.tasks];
  }

  /**
   * Cập nhật trạng thái của một nhiệm vụ trong kế hoạch
   */
  updateTask(id: number, status: TaskStatus, notes?: string): PlanTask | null {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) {
      return null;
    }

    task.status = status;
    if (notes) {
      task.notes = notes;
    }

    // Tự động chuyển task tiếp theo sang IN_PROGRESS nếu task hiện tại hoàn thành
    if (status === 'COMPLETED') {
      const nextPending = this.tasks.find((t) => t.id > id && t.status === 'PENDING');
      if (nextPending) {
        nextPending.status = 'IN_PROGRESS';
      }
    }

    this.persist('updated');

    return task;
  }

  /**
   * Lấy danh sách nhiệm vụ hiện tại
   */
  getTasks(): PlanTask[] {
    return [...this.tasks];
  }

  /**
   * Kiểm tra xem đã có kế hoạch chưa
   */
  hasPlan(): boolean {
    return this.tasks.length > 0;
  }

  /**
   * Đếm số lượng task đã hoàn thành
   */
  getProgress(): { total: number; completed: number; inProgress: number; pending: number; failed: number } {
    const total = this.tasks.length;
    const completed = this.tasks.filter((t) => t.status === 'COMPLETED').length;
    const inProgress = this.tasks.filter((t) => t.status === 'IN_PROGRESS').length;
    const pending = this.tasks.filter((t) => t.status === 'PENDING').length;
    const failed = this.tasks.filter((t) => t.status === 'FAILED').length;

    return { total, completed, inProgress, pending, failed };
  }

  /**
   * Xoá kế hoạch cũ
   */
  clear(): void {
    this.tasks = [];
    this.persist('cleared');
  }

  private persist(reason: string): void {
    this.session?.append('plan/change', {
      reason,
      plan: this.tasks.map((task) => ({ ...task })),
    });
  }
}
