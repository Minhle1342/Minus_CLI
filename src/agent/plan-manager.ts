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

  /**
   * Khởi tạo hoặc thay thế kế hoạch mới
   */
  createPlan(tasks: Array<{ id?: number; title: string }>): PlanTask[] {
    this.tasks = tasks.map((t, idx) => ({
      id: t.id ?? idx + 1,
      title: t.title.trim(),
      status: idx === 0 ? 'IN_PROGRESS' : 'PENDING',
    }));
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
  }
}
