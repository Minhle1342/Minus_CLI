import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Session } from './session.js';
import type { Workspace } from '../workspace/workspace.js';

export interface ArchitecturalDecision {
  decisionType: string;
  rationale: string;
  impactScore?: number;
  affectedFiles: string[];
}

export interface StateMutations {
  filesModified: string[];
  filesCreated: string[];
  filesDeleted: string[];
}

export interface ContextDriftReport {
  hasDrift: boolean;
  driftTypes: ('git_head_changed' | 'external_file_mutation' | 'missing_snapshot')[];
  details: string[];
  divergedFiles: string[];
}

export interface TaskContextSnapshot {
  schemaVersion: '1.0.0';
  snapshotId: string;
  sessionId: string;
  turn: number;
  taskPrompt: string;
  capturedAt: string;
  contextFingerprint: string;
  granularity: 'minimal' | 'standard' | 'comprehensive';
  architecturalDecisions: ArchitecturalDecision[];
  stateMutations: StateMutations;
  distilledLearnings: string[];
  verificationStatus: 'verified' | 'unverified' | 'failed';
  summary: string;
  tags: string[];
}

export interface ContextSnapshotIndexItem {
  snapshotId: string;
  turn: number;
  taskPrompt: string;
  capturedAt: string;
  fingerprint: string;
  jsonPath: string;
  mdPath: string;
  verificationStatus: 'verified' | 'unverified' | 'failed';
}

/**
 * ContextSnapshotManager - Quản lý Lưu trữ Ngữ cảnh & Chuyển giao Nhiệm vụ (Task-to-Task Context Lifecycle)
 * 
 * Hiện thực hóa toàn diện chuẩn `context-management-context-save`:
 * 1. Semantic Information Identification: Tự động trích xuất quyết định kiến trúc (Architectural Decisions & Rationales).
 * 2. State Serialization Patterns: Định dạng chuẩn JSON Schema + Markdown có YAML frontmatter.
 * 3. Multi-Session Context Management: Tính toán mã vân tay ngữ cảnh (Context Fingerprint) và phát hiện trôi dạt ngữ cảnh (Context Drift).
 * 4. Selective Context Restoration: Khôi phục ngữ cảnh có chọn lọc, loại bỏ log rác của các vòng lặp thử-sai cũ.
 * 5. Task-to-Task Semantic Handoff: Nén kết quả của task trước thành Digest tinh gọn cho task sau, ngăn ngừa Attention Decay.
 */
export class ContextSnapshotManager {
  readonly workspaceDir: string;
  readonly snapshotsDir: string;
  private indexPath: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.snapshotsDir = path.join(this.workspaceDir, '.codingagent', 'snapshots');
    this.indexPath = path.join(this.snapshotsDir, 'index.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
  }

  /**
   * Tính toán mã vân tay ngữ cảnh (SHA-256 Context Fingerprint)
   * Kết hợp: Danh sách file đã sửa, nội dung tóm tắt và quyết định kiến trúc.
   */
  async computeFingerprint(params: {
    files: string[];
    decisions: ArchitecturalDecision[];
    taskPrompt: string;
    summary: string;
  }): Promise<string> {
    const hash = crypto.createHash('sha256');
    hash.update(params.taskPrompt);
    hash.update(params.summary);

    for (const d of params.decisions) {
      hash.update(`${d.decisionType}:${d.rationale}:${d.affectedFiles.join(',')}`);
    }

    for (const f of params.files.sort()) {
      try {
        const fullPath = path.isAbsolute(f) ? f : path.join(this.workspaceDir, f);
        const stat = await fs.stat(fullPath);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        hash.update(`${f}:missing`);
      }
    }

    return hash.digest('hex');
  }

  /**
   * Tự động trích xuất quyết định kiến trúc từ câu trả lời cuối cùng và thao tác sửa file
   */
  extractDecisionsFromTurn(
    finalAnswer: string,
    mutatedFiles: string[],
    taskPrompt: string,
  ): ArchitecturalDecision[] {
    const decisions: ArchitecturalDecision[] = [];

    // Nhận diện quyết định tạo module / thành phần mới
    const createdModules = mutatedFiles.filter((f) => !f.includes('test') && !f.endsWith('.json') && !f.endsWith('.md'));
    if (createdModules.length > 0) {
      decisions.push({
        decisionType: 'MODULE_IMPLEMENTATION',
        rationale: `Implemented or refactored core components for task: "${taskPrompt.slice(0, 80)}"`,
        impactScore: 8,
        affectedFiles: createdModules,
      });
    }

    // Nhận diện thay đổi bài kiểm thử / hợp đồng kiểm chứng
    const testFiles = mutatedFiles.filter((f) => f.includes('test') || f.includes('spec'));
    if (testFiles.length > 0) {
      decisions.push({
        decisionType: 'VERIFICATION_CONTRACT',
        rationale: `Added or updated verification suites to enforce invariant integrity`,
        impactScore: 7,
        affectedFiles: testFiles,
      });
    }

    // Trích xuất các ý chính từ câu trả lời
    const lines = finalAnswer.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if ((line.startsWith('-') || line.startsWith('•') || line.startsWith('*')) && line.length > 20) {
        const cleaned = line.replace(/^[-•*]\s*/, '').trim();
        if (cleaned.toLowerCase().includes('kiến trúc') || cleaned.toLowerCase().includes('cơ chế') || cleaned.toLowerCase().includes('refactor') || cleaned.toLowerCase().includes('chuyển sang') || cleaned.toLowerCase().includes('pattern')) {
          decisions.push({
            decisionType: 'DESIGN_PATTERN_DECISION',
            rationale: cleaned.slice(0, 200),
            impactScore: 9,
            affectedFiles: mutatedFiles,
          });
          break;
        }
      }
    }

    return decisions;
  }

  /**
   * Chụp Snapshot Ngữ Cảnh của Nhiệm Vụ (Context Capture & Multi-Format Serialization)
   */
  async captureSnapshot(params: {
    sessionId: string;
    turn: number;
    taskPrompt: string;
    finalAnswer: string;
    mutatedFiles: string[];
    createdFiles?: string[];
    deletedFiles?: string[];
    verificationStatus: 'verified' | 'unverified' | 'failed';
    granularity?: 'minimal' | 'standard' | 'comprehensive';
    distilledLearnings?: string[];
    tags?: string[];
  }): Promise<TaskContextSnapshot> {
    await this.init();

    const snapshotId = `task-${params.turn}-${Date.now().toString(36)}`;
    const decisions = this.extractDecisionsFromTurn(params.finalAnswer, params.mutatedFiles, params.taskPrompt);

    const fingerprint = await this.computeFingerprint({
      files: params.mutatedFiles,
      decisions,
      taskPrompt: params.taskPrompt,
      summary: params.finalAnswer.slice(0, 500),
    });

    const snapshot: TaskContextSnapshot = {
      schemaVersion: '1.0.0',
      snapshotId,
      sessionId: params.sessionId,
      turn: params.turn,
      taskPrompt: params.taskPrompt,
      capturedAt: new Date().toISOString(),
      contextFingerprint: fingerprint,
      granularity: params.granularity || 'standard',
      architecturalDecisions: decisions,
      stateMutations: {
        filesModified: params.mutatedFiles,
        filesCreated: params.createdFiles || [],
        filesDeleted: params.deletedFiles || [],
      },
      distilledLearnings: params.distilledLearnings || [
        `Turn ${params.turn} completed successfully with ${params.verificationStatus} verification.`,
      ],
      verificationStatus: params.verificationStatus,
      summary: params.finalAnswer.slice(0, 600),
      tags: params.tags || ['task-boundary', `turn-${params.turn}`],
    };

    // 1. Lưu dạng Structured JSON
    const jsonFileName = `${snapshotId}.json`;
    const jsonPath = path.join(this.snapshotsDir, jsonFileName);
    await fs.writeFile(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8');

    // 2. Lưu dạng Markdown với YAML Frontmatter
    const mdFileName = `${snapshotId}.md`;
    const mdPath = path.join(this.snapshotsDir, mdFileName);
    const mdContent = this.formatSnapshotToMarkdown(snapshot);
    await fs.writeFile(mdPath, mdContent, 'utf8');

    // 3. Cập nhật Index
    await this.updateIndex({
      snapshotId,
      turn: params.turn,
      taskPrompt: params.taskPrompt,
      capturedAt: snapshot.capturedAt,
      fingerprint,
      jsonPath,
      mdPath,
      verificationStatus: params.verificationStatus,
    });

    return snapshot;
  }

  /**
   * Phát hiện trôi dạt ngữ cảnh (Context Drift Detection)
   * Kiểm tra xem các file đã được ghi nhận trong snapshot có bị sửa đổi bên ngoài hệ thống hay không.
   */
  async detectDrift(snapshot: TaskContextSnapshot): Promise<ContextDriftReport> {
    const divergedFiles: string[] = [];
    const details: string[] = [];
    const driftTypes: ('git_head_changed' | 'external_file_mutation' | 'missing_snapshot')[] = [];

    const snapshotTime = new Date(snapshot.capturedAt).getTime();

    for (const f of snapshot.stateMutations.filesModified) {
      try {
        const fullPath = path.isAbsolute(f) ? f : path.join(this.workspaceDir, f);
        const stat = await fs.stat(fullPath);
        // Nếu file có mtime mới hơn snapshot > 2 giây
        if (stat.mtimeMs - snapshotTime > 2000) {
          divergedFiles.push(f);
          details.push(`File ${f} was modified after task snapshot (${new Date(stat.mtimeMs).toISOString()})`);
        }
      } catch {
        divergedFiles.push(f);
        details.push(`File ${f} recorded in snapshot is no longer present on disk.`);
      }
    }

    if (divergedFiles.length > 0) {
      driftTypes.push('external_file_mutation');
    }

    return {
      hasDrift: divergedFiles.length > 0,
      driftTypes,
      details,
      divergedFiles,
    };
  }

  /**
   * Tạo bản Semantic Handoff Digest để truyền ngữ cảnh từ các task trước sang task mới
   * Giúp LLM nắm trọn quyết định kiến trúc mà KHÔNG CẦN đọc lại hàng nghìn dòng log thô cũ.
   */
  generateHandoffDigest(snapshots: TaskContextSnapshot[]): string {
    if (!snapshots || snapshots.length === 0) return '';

    const lines: string[] = [
      `\n🏛️ [INTER-TASK INSTITUTIONAL CONTEXT & ARCHITECTURAL HANDOFF]:`,
      `The following architectural decisions and state invariants were established in preceding tasks:`,
    ];

    for (const s of snapshots.slice(-3)) {
      lines.push(`\n📌 [TASK ${s.turn}: "${s.taskPrompt.slice(0, 90)}"] (Status: ${s.verificationStatus})`);
      lines.push(`   • Summary: ${s.summary.slice(0, 200)}...`);
      if (s.architecturalDecisions.length > 0) {
        lines.push(`   • Decisions:`);
        for (const d of s.architecturalDecisions) {
          lines.push(`     - [${d.decisionType}] ${d.rationale} (Files: ${d.affectedFiles.slice(0, 3).join(', ')})`);
        }
      }
      if (s.stateMutations.filesModified.length > 0) {
        lines.push(`   • Mutated Files: ${s.stateMutations.filesModified.slice(0, 5).join(', ')}`);
      }
    }

    lines.push(`\n👉 INVARIANT: Build upon the decisions and components established above; avoid recreating or contradicting existing structures.\n`);
    return lines.join('\n');
  }

  /**
   * Khôi phục ngữ cảnh có chọn lọc (Selective Context Restoration)
   */
  async restoreSelectiveContext(
    snapshotId: string,
    options: {
      includeDecisions?: boolean;
      includeMutations?: boolean;
      includeLearnings?: boolean;
    } = { includeDecisions: true, includeMutations: true, includeLearnings: true },
  ): Promise<string> {
    const jsonPath = path.join(this.snapshotsDir, `${snapshotId}.json`);
    const raw = await fs.readFile(jsonPath, 'utf8');
    const snapshot: TaskContextSnapshot = JSON.parse(raw);

    const parts: string[] = [
      `🎯 [SELECTIVE CONTEXT RESTORATION - SNAPSHOT ${snapshot.snapshotId}]`,
      `Task: "${snapshot.taskPrompt}" (Turn ${snapshot.turn}, Captured: ${snapshot.capturedAt})`,
    ];

    if (options.includeDecisions && snapshot.architecturalDecisions.length > 0) {
      parts.push(`\nArchitectural Decisions:`);
      for (const d of snapshot.architecturalDecisions) {
        parts.push(`  • [${d.decisionType}] ${d.rationale} (Impact: ${d.impactScore || 5}/10)`);
      }
    }

    if (options.includeMutations) {
      parts.push(`\nActive Files: ${snapshot.stateMutations.filesModified.join(', ')}`);
    }

    if (options.includeLearnings && snapshot.distilledLearnings.length > 0) {
      parts.push(`\nDistilled Learnings:`);
      for (const l of snapshot.distilledLearnings) {
        parts.push(`  • ${l}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Đọc danh sách tất cả Snapshots
   */
  async listSnapshots(): Promise<ContextSnapshotIndexItem[]> {
    try {
      const content = await fs.readFile(this.indexPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /**
   * Đọc Snapshot mới nhất
   */
  async getLatestSnapshot(): Promise<TaskContextSnapshot | undefined> {
    const index = await this.listSnapshots();
    if (index.length === 0) return undefined;
    const latest = index[index.length - 1];
    try {
      const raw = await fs.readFile(latest.jsonPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private formatSnapshotToMarkdown(snapshot: TaskContextSnapshot): string {
    return [
      `---`,
      `snapshot_id: "${snapshot.snapshotId}"`,
      `session_id: "${snapshot.sessionId}"`,
      `turn: ${snapshot.turn}`,
      `captured_at: "${snapshot.capturedAt}"`,
      `context_fingerprint: "${snapshot.contextFingerprint}"`,
      `verification_status: "${snapshot.verificationStatus}"`,
      `tags: [${snapshot.tags.map((t) => `"${t}"`).join(', ')}]`,
      `---`,
      ``,
      `# Task Context Snapshot: Turn ${snapshot.turn}`,
      ``,
      `## 1. Task Objective`,
      `> ${snapshot.taskPrompt}`,
      ``,
      `## 2. Architectural Decisions & Rationales`,
      snapshot.architecturalDecisions.length > 0
        ? snapshot.architecturalDecisions
            .map((d) => `- **[${d.decisionType}]**: ${d.rationale}\n  - Affected Files: \`${d.affectedFiles.join('`, `')}\``)
            .join('\n')
        : `*No explicit architectural changes recorded.*`,
      ``,
      `## 3. State Mutations`,
      `- **Modified Files**: ${snapshot.stateMutations.filesModified.map((f) => `\`${f}\``).join(', ') || 'None'}`,
      `- **Created Files**: ${snapshot.stateMutations.filesCreated.map((f) => `\`${f}\``).join(', ') || 'None'}`,
      `- **Deleted Files**: ${snapshot.stateMutations.filesDeleted.map((f) => `\`${f}\``).join(', ') || 'None'}`,
      ``,
      `## 4. Execution Summary`,
      snapshot.summary,
      ``,
      `## 5. Distilled Learnings`,
      snapshot.distilledLearnings.map((l) => `- ${l}`).join('\n'),
      ``,
    ].join('\n');
  }

  private async updateIndex(item: ContextSnapshotIndexItem): Promise<void> {
    let list: ContextSnapshotIndexItem[] = [];
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      list = JSON.parse(raw);
    } catch {
      list = [];
    }

    list = list.filter((existing) => existing.snapshotId !== item.snapshotId);
    list.push(item);
    await fs.writeFile(this.indexPath, JSON.stringify(list, null, 2), 'utf8');
  }
}
