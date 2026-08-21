export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'timed_out';

export interface ApprovalRequest {
  id: string;
  action: string;
  description: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  reason?: string;
  response?: string;
  timeoutMs?: number;
}

export class ApprovalManager {
  private requests: Map<string, ApprovalRequest> = new Map();
  private listeners: Array<(req: ApprovalRequest) => void> = [];

  /**
   * Tạo một yêu cầu phê duyệt mới
   */
  requestApproval(action: string, description: string, options?: { timeoutMs?: number }): ApprovalRequest {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const req: ApprovalRequest = {
      id,
      action,
      description,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      timeoutMs: options?.timeoutMs,
    };

    this.requests.set(id, req);
    this.notify(req);
    return { ...req };
  }

  /**
   * Phê duyệt hoặc từ chối một yêu cầu
   */
  resolveApproval(id: string, approved: boolean, responseOrReason?: string): boolean {
    const req = this.requests.get(id);
    if (!req || req.status !== 'pending') {
      return false;
    }

    req.status = approved ? 'approved' : 'rejected';
    req.resolvedAt = new Date().toISOString();
    if (approved) {
      req.response = responseOrReason;
    } else {
      req.reason = responseOrReason;
    }

    this.notify(req);
    return true;
  }

  get(id: string): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    return req ? { ...req } : undefined;
  }

  getPending(): ApprovalRequest[] {
    return Array.from(this.requests.values())
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r }));
  }

  isApproved(id: string): boolean {
    const req = this.requests.get(id);
    return req?.status === 'approved';
  }

  onApprovalRequested(listener: (req: ApprovalRequest) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(req: ApprovalRequest): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...req });
      } catch {}
    }
  }
}
