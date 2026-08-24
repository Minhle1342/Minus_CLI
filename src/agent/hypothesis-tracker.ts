export type HypothesisStatus = 'formulated' | 'testing' | 'validated' | 'falsified';
export type BlastRadiusRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Hypothesis {
  id: string;
  statement: string;
  falsificationTest: string;
  targetFiles: string[];
  blastRadius: BlastRadiusRisk;
  proposedFix: string;
  status: HypothesisStatus;
  rejectionReason?: string;
  learning?: string;
  createdAt: string;
  testedAt?: string;
}

/**
 * HypothesisTracker - Hệ thống Quản lý Giả thuyết & Phản biện Cấu trúc (Codex CLI Standard)
 * 
 * Đảm bảo:
 * 1. Mọi hành động mutation phức tạp/sửa lỗi đều dựa trên một giả thuyết (Hypothesis) có thể phản nghiệm.
 * 2. Xác định rõ tiêu chí falsification (test nào fail thì bác bỏ giả thuyết).
 * 3. Lưu trữ các giả thuyết đã bị bác bỏ để tránh lặp lại cùng một sai lầm trong các chu kỳ sau.
 */
export class HypothesisTracker {
  private hypotheses: Hypothesis[] = [];
  private counter: number = 0;

  /**
   * Đưa ra giả thuyết mới trước khi thực hiện sửa đổi
   */
  formulate(params: {
    statement: string;
    falsificationTest: string;
    targetFiles?: string[];
    blastRadius?: BlastRadiusRisk;
    proposedFix?: string;
  }): Hypothesis {
    this.counter++;
    const id = `H${this.counter}`;
    const hypothesis: Hypothesis = {
      id,
      statement: params.statement,
      falsificationTest: params.falsificationTest,
      targetFiles: params.targetFiles || [],
      blastRadius: params.blastRadius || 'MEDIUM',
      proposedFix: params.proposedFix || '',
      status: 'formulated',
      createdAt: new Date().toISOString(),
    };

    this.hypotheses.push(hypothesis);
    return hypothesis;
  }

  /**
   * Lấy giả thuyết hiện tại đang được kiểm nghiệm
   */
  getActiveHypothesis(): Hypothesis | undefined {
    return this.hypotheses.find((h) => h.status === 'formulated' || h.status === 'testing');
  }

  /**
   * Đánh dấu giả thuyết đang trong quá trình chạy test/verification
   */
  markTesting(id?: string): void {
    const target = id ? this.hypotheses.find((h) => h.id === id) : this.getActiveHypothesis();
    if (target) {
      target.status = 'testing';
      target.testedAt = new Date().toISOString();
    }
  }

  /**
   * Đánh dấu giả thuyết được chứng minh ĐÚNG (Tests pass, zero regression)
   */
  markValidated(id?: string, notes?: string): void {
    const target = id ? this.hypotheses.find((h) => h.id === id) : this.getActiveHypothesis();
    if (target) {
      target.status = 'validated';
      target.testedAt = new Date().toISOString();
      if (notes) {
        target.learning = notes;
      }
    }
  }

  /**
   * Đánh dấu giả thuyết bị BÁC BỎ (Falsified) kèm lý do cụ thể và bài học rút ra
   */
  markFalsified(id: string | undefined, reason: string, learning?: string): void {
    const target = id ? this.hypotheses.find((h) => h.id === id) : this.getActiveHypothesis();
    if (target) {
      target.status = 'falsified';
      target.rejectionReason = reason;
      target.learning = learning || `Giả thuyết ${target.id} không đúng do: ${reason}`;
      target.testedAt = new Date().toISOString();
    }
  }

  getHypotheses(): Hypothesis[] {
    return [...this.hypotheses];
  }

  getFalsifiedHypotheses(): Hypothesis[] {
    return this.hypotheses.filter((h) => h.status === 'falsified');
  }

  getValidatedHypotheses(): Hypothesis[] {
    return this.hypotheses.filter((h) => h.status === 'validated');
  }

  /**
   * Xuất chuỗi định dạng Scratchpad ngắn gọn cho LLM / Terminal CLI
   */
  toScratchpad(): string {
    if (this.hypotheses.length === 0) return '';

    const lines: string[] = ['🧠 [SYSTEM 2 HYPOTHESIS SCRATCHPAD]:'];
    for (const h of this.hypotheses) {
      const statusIcon =
        h.status === 'validated'
          ? '✅'
          : h.status === 'falsified'
          ? '❌'
          : h.status === 'testing'
          ? '🧪'
          : '💡';
      lines.push(`  ${statusIcon} [${h.id}] [${h.status.toUpperCase()}]: ${h.statement}`);
      if (h.falsificationTest) {
        lines.push(`     • Falsification Criteria: ${h.falsificationTest}`);
      }
      if (h.rejectionReason && h.status === 'falsified') {
        lines.push(`     • Rejected: ${h.rejectionReason}`);
      }
      if (h.learning) {
        lines.push(`     • Distilled Learning: ${h.learning}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Tạo prompt chỉ dẫn ngắn gọn khi có giả thuyết bị bác bỏ để tránh lặp lại
   */
  toPromptGuidance(): string {
    const falsified = this.getFalsifiedHypotheses();
    if (falsified.length === 0) return '';

    const warnings = falsified.map(
      (h) => `• [${h.id} Rejected]: ${h.statement} ➔ Reason: ${h.rejectionReason || 'Tests failed'}`,
    );

    return [
      `\n🚫 [FALSIFIED HYPOTHESES - DO NOT REPEAT]:`,
      ...warnings,
      `👉 Propose a new hypothesis with a distinct mechanism before further mutations.`,
    ].join('\n');
  }

  reset(): void {
    this.hypotheses = [];
    this.counter = 0;
  }
}
