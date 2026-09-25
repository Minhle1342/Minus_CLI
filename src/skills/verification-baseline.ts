import type { Workspace } from '../workspace/workspace.js';
import { computeWorkspaceDigest, computeDiffHash } from '../workspace/workspace-digest.js';

export interface VerificationFailureItem {
  id: string;
  source: 'typecheck' | 'test' | 'build' | 'lint' | 'diagnostics';
  message: string;
  file?: string;
  line?: number;
}

export interface BaselineSnapshot {
  timestamp: string;
  workspaceDigest: string;
  diffHash: string;
  isGreen: boolean;
  failures: VerificationFailureItem[];
}

/**
 * VerificationBaselineManager
 * 
 * Ghi nhận và lưu giữ trạng thái baseline (trước mutation) của repository.
 * Hỗ trợ Differential Verification: Nếu baseline đã có lỗi từ trước,
 * Agent không bị coi là thất bại nếu không tạo thêm bất kỳ lỗi mới nào (newFailures == 0).
 */
export class VerificationBaselineManager {
  private baselineCache = new Map<string, BaselineSnapshot>();
  private currentBaseline?: BaselineSnapshot;

  async captureBaseline(
    workspace: Workspace,
    initialFailures: VerificationFailureItem[] = [],
  ): Promise<BaselineSnapshot> {
    const workspaceDigest = await computeWorkspaceDigest(workspace);
    const diffHash = await computeDiffHash(workspace);

    if (this.baselineCache.has(workspaceDigest)) {
      this.currentBaseline = this.baselineCache.get(workspaceDigest)!;
      return this.currentBaseline;
    }

    const snapshot: BaselineSnapshot = {
      timestamp: new Date().toISOString(),
      workspaceDigest,
      diffHash,
      isGreen: initialFailures.length === 0,
      failures: [...initialFailures],
    };

    this.baselineCache.set(workspaceDigest, snapshot);
    this.currentBaseline = snapshot;
    return snapshot;
  }

  getCurrentBaseline(): BaselineSnapshot | undefined {
    return this.currentBaseline;
  }

  /**
   * So sánh kết quả verification sau mutation với baseline
   */
  evaluateDifferential(
    postFailures: VerificationFailureItem[],
  ): {
    hasNewFailures: boolean;
    newFailures: VerificationFailureItem[];
    preExistingFailures: VerificationFailureItem[];
    baselineWasGreen: boolean;
  } {
    if (!this.currentBaseline) {
      return {
        hasNewFailures: postFailures.length > 0,
        newFailures: postFailures,
        preExistingFailures: [],
        baselineWasGreen: true,
      };
    }

    const baselineFailureSignatures = new Set(
      this.currentBaseline.failures.map((f) => `${f.source}:${f.file || ''}:${f.message.trim()}`),
    );

    const newFailures: VerificationFailureItem[] = [];
    const preExistingFailures: VerificationFailureItem[] = [];

    for (const failure of postFailures) {
      const sig = `${failure.source}:${failure.file || ''}:${failure.message.trim()}`;
      if (baselineFailureSignatures.has(sig)) {
        preExistingFailures.push(failure);
      } else {
        newFailures.push(failure);
      }
    }

    return {
      hasNewFailures: newFailures.length > 0,
      newFailures,
      preExistingFailures,
      baselineWasGreen: this.currentBaseline.isGreen,
    };
  }

  reset(): void {
    this.currentBaseline = undefined;
  }
}
