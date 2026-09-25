import type { Session } from '../session/session.js';

export interface TaskAuditRecord {
  id: string;
  turn: number;
  timestamp: string;
  summary: string;
  rootCause?: string;
  filesModified: string[];
  diffHash?: string;
  verificationCommand: string;
  verificationExitCode: number;
  critiqueScore: number;
  lspDiagnosticsCount: number;
  status: 'APPROVED' | 'REJECTED';
  reasons?: string[];
}

/**
 * AuditLedger - Codex CLI Structured Completion & Telemetry Ledger
 * 
 * Records immutable, verifiable task completion records into session event logs.
 */
export class AuditLedger {
  private records: TaskAuditRecord[] = [];

  record(entry: Omit<TaskAuditRecord, 'id' | 'timestamp'>, session?: Session): TaskAuditRecord {
    const record: TaskAuditRecord = {
      id: `audit_${Date.now()}_${this.records.length + 1}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.records.push(record);

    if (session) {
      session.append('audit/task-completion', record);
    }

    return record;
  }

  getRecords(): TaskAuditRecord[] {
    return [...this.records];
  }

  getLatestRecord(): TaskAuditRecord | undefined {
    return this.records[this.records.length - 1];
  }

  formatAuditReport(record: TaskAuditRecord): string {
    const lines = [
      '╭── 📋 CODEX CLI AUDIT & VERIFICATION LEDGER ────────────────────────╮',
      `│  Audit ID:   ${record.id}`,
      `│  Timestamp:  ${record.timestamp}`,
      `│  Status:     ${record.status === 'APPROVED' ? '✔ APPROVED' : '✖ REJECTED'} (Score: ${record.critiqueScore}/100)`,
      `│  Diff Hash:  ${record.diffHash || 'N/A'}`,
      `│  Verified:   ${record.verificationCommand} (exit: ${record.verificationExitCode})`,
      `│  LSP Diags:  ${record.lspDiagnosticsCount} errors`,
      `│  Files:      ${record.filesModified.length > 0 ? record.filesModified.join(', ') : 'None'}`,
      '╰────────────────────────────────────────────────────────────────────╯',
    ];
    return lines.join('\n');
  }
}
