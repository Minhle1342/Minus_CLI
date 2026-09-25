export type ReviewVerdict = 'approved' | 'changes_requested' | 'rejected';

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'nit';
  description: string;
  file?: string;
  line?: number;
}

export interface ReviewRecord {
  id: string;
  taskId: number;
  reviewerId: string;
  verdict: ReviewVerdict;
  comments: string;
  findings: ReviewFinding[];
  timestamp: string;
  round: number;
}

export interface ReviewRequest {
  id: string;
  taskId: number;
  title: string;
  diffSummary?: string;
  evidence?: string;
  status: 'pending' | 'in_review' | 'approved' | 'changes_requested';
  requestedAt: string;
  reviews: ReviewRecord[];
}

export class ReviewManager {
  private requests: Map<string, ReviewRequest> = new Map();

  /**
   * Yêu cầu review cho một task
   */
  requestReview(taskId: number, title: string, options?: { diffSummary?: string; evidence?: string }): ReviewRequest {
    const id = `review-task-${taskId}-${Date.now()}`;
    const req: ReviewRequest = {
      id,
      taskId,
      title,
      diffSummary: options?.diffSummary,
      evidence: options?.evidence,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      reviews: [],
    };

    this.requests.set(id, req);
    return { ...req };
  }

  /**
   * Gửi kết quả review
   */
  submitReview(
    reviewRequestId: string,
    verdict: ReviewVerdict,
    comments: string,
    options?: { reviewerId?: string; findings?: ReviewFinding[] }
  ): ReviewRecord {
    const req = this.requests.get(reviewRequestId);
    if (!req) {
      throw new Error(`Review request '${reviewRequestId}' not found.`);
    }

    const reviewId = `rev-${Date.now()}-${req.reviews.length + 1}`;
    const record: ReviewRecord = {
      id: reviewId,
      taskId: req.taskId,
      reviewerId: options?.reviewerId || 'reviewer-agent',
      verdict,
      comments,
      findings: options?.findings || [],
      timestamp: new Date().toISOString(),
      round: req.reviews.length + 1,
    };

    req.reviews.push(record);
    req.status = verdict === 'approved' ? 'approved' : 'changes_requested';

    return { ...record };
  }

  /**
   * Kiểm tra xem task đã được phê duyệt qua review hay chưa
   */
  isTaskApproved(taskId: number): boolean {
    for (const req of this.requests.values()) {
      if (req.taskId === taskId && req.status === 'approved') {
        return true;
      }
    }
    return false;
  }

  get(id: string): ReviewRequest | undefined {
    const req = this.requests.get(id);
    return req ? { ...req } : undefined;
  }

  getForTask(taskId: number): ReviewRequest[] {
    return Array.from(this.requests.values())
      .filter((r) => r.taskId === taskId)
      .map((r) => ({ ...r }));
  }
}
