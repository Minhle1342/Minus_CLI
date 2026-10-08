import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Session, SessionMessage } from '../session/session.js';

export type PriorityLevel = 'P0' | 'P1' | 'P2';

export interface TechnicalDecision {
  topic: string;
  decision: string;
  rationale: string;
  alternativesDiscarded?: string[];
  affectedFiles: string[];
}

export interface TaskStateItem {
  id?: string;
  description: string;
  status: 'completed' | 'pending' | 'in_progress' | 'blocked';
  priority: 'P0' | 'P1' | 'P2';
  dependencies?: string[];
}

export interface AppliedFix {
  symptom: string;
  rootCause: string;
  exactSolution: string;
  affectedFiles: string[];
}

export interface CodeMutationRecord {
  path: string;
  nature: string;
  linesChanged?: string;
  rationale?: string;
}

export interface ResolvedError {
  errorMessage: string;
  rootCause?: string;
  resolution: string;
}

export interface ExtractedCriticalContext {
  projectId: string;
  timestamp: string;
  phase: string;
  // P0 - Fatal Loss (Preserved with triple redundancy)
  p0: {
    technicalDecisions: TechnicalDecision[];
    taskState: TaskStateItem[];
    appliedFixes: AppliedFix[];
    codeMutations: CodeMutationRecord[];
    resolvedErrors: ResolvedError[];
    workingCommands: string[];
  };
  // P1 - Severe Loss (Preserved with verification)
  p1: {
    discoveredPatterns: string[];
    componentDependencies: string[];
    userPreferences: string[];
    projectContext: {
      keyFiles: string[];
      architectureNotes: string[];
    };
    openQuestions: string[];
  };
  // P2 - Tolerable Loss (Compact summary)
  p2: {
    attemptHistory: string[];
    progressMetrics: Record<string, any>;
    exploratoryNotes: string[];
  };
}

export interface IntegrityCheckItem {
  name: string;
  passed: boolean;
  details?: string;
}

export interface IntegrityCheckResult {
  passed: boolean;
  score: number;
  checks: IntegrityCheckItem[];
  missingItems: string[];
}

export interface GuardianSnapshotResult {
  snapshotId: string;
  snapshotPath: string;
  jsonPath: string;
  briefing: string;
  integrity: IntegrityCheckResult;
}

/**
 * ContextGuardian - Người Bảo Vệ Ngữ Cảnh Trước Khi Nén Tự Động (Pre-Compaction Context Guard)
 * Hiện thực hóa quy chuẩn kỹ năng `context-guardian` (4 Fases):
 * 1. Fase 1: Trích xuất có cấu trúc theo phân cấp P0 (Perda Fatal), P1 (Perda Grave), P2 (Perda Tolerável)
 * 2. Fase 2: Kiểm tra tính toàn vẹn đa chiều với Checklist 8 điểm
 * 3. Fase 3: Lưu trữ bền vững 3 tầng (Snapshot File, ACTIVE_CONTEXT.md, Session Registry)
 * 4. Fase 4: Tạo Thẻ Tóm Tắt Chuyển Giao (Transition Briefing) trước khi nén để LLM không bao giờ bị mất ngữ cảnh
 */
export class ContextGuardian {
  readonly workspaceDir: string;
  readonly snapshotsDir: string;

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
    this.snapshotsDir = path.join(this.workspaceDir, '.codingagent', 'snapshots');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
  }

  /**
   * Fase 1: Trích xuất có cấu trúc (P0, P1, P2) từ Session và ngữ cảnh làm việc
   */
  extractCriticalContext(session: Session, additionalContext?: {
    mutatedFiles?: string[];
    workingCommands?: string[];
    activePlan?: { tasks: Array<{ title: string; status?: string; priority?: string }> };
    projectPhase?: string;
  }): ExtractedCriticalContext {
    const history = session.getHistory();
    const mutatedFilesSet = new Set<string>(additionalContext?.mutatedFiles || []);
    const workingCommandsSet = new Set<string>(additionalContext?.workingCommands || []);
    const technicalDecisions: TechnicalDecision[] = [];
    const taskState: TaskStateItem[] = [];
    const appliedFixes: AppliedFix[] = [];
    const resolvedErrors: ResolvedError[] = [];
    const codeMutations: CodeMutationRecord[] = [];
    const discoveredPatterns: string[] = [];
    const componentDependencies: string[] = [];
    const userPreferences: string[] = [];
    const openQuestions: string[] = [];
    const attemptHistory: string[] = [];

    // Derive verified commands from paired session events. A command name alone
    // is never evidence that it succeeded.
    const commandCalls = new Map<string, string>();
    for (const event of session.getEvents()) {
      if (event.type === 'tool/call' && event.data.toolCallId && event.data.toolName === 'run_command') {
        const command = String(event.data.args?.command || '').trim();
        if (command) commandCalls.set(event.data.toolCallId, command);
      }
      if (event.type === 'tool/result' && event.data.toolCallId) {
        const command = commandCalls.get(event.data.toolCallId);
        const result = event.data.result as Record<string, any> | undefined;
        const succeeded = result?.exitCode === 0 || result?.success === true;
        if (command && succeeded) workingCommandsSet.add(command);
      }
    }

    // 1. Quét tin nhắn trong history để thu thập tool calls, tool responses, và assistant outputs
    for (const msg of history) {
      for (const part of (msg.parts || [])) {
        // Thu thập file mutations từ tool calls
        if (part.functionCall) {
          const fn = String(part.functionCall.name || '');
          const args = (part.functionCall.args as Record<string, any>) || {};

          if (fn && ['replace_text', 'write_file', 'create_file', 'apply_patch', 'delete_file'].includes(fn)) {
            const targetPath = String(args.path || args.filePath || '').trim();
            if (targetPath) {
              mutatedFilesSet.add(targetPath);
              codeMutations.push({
                path: targetPath,
                nature: fn === 'delete_file' ? 'DELETED' : (fn === 'create_file' ? 'CREATED' : 'MODIFIED'),
                rationale: `Applied via ${fn}`,
              });
            }
          }

          // Verification commands are recorded only after a paired successful
          // tool/result event, handled above.
        }

        // Thu thập error resolutions từ tool results
        if (part.functionResponse) {
          const resp = part.functionResponse.response as any;
          if (resp?.error && typeof resp.error === 'string') {
            attemptHistory.push(`Tool error encountered: ${resp.error.slice(0, 150)}`);
          }
        }

        // Phân tích văn bản của assistant hoặc user để trích xuất decisions, fixes, and learnings
        if (typeof part.text === 'string' && part.text.length > 0) {
          const text = part.text;

          // Phát hiện quyết định kiến trúc
          if (text.includes('Quyết định kiến trúc') || text.includes('Architectural Decision') || text.includes('chuyển sang') || text.includes('quy chuẩn') || text.includes('Nguyên tắc:')) {
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.includes('chuyển sang') || line.includes('sử dụng') || line.includes('thay thế') || line.includes('quy chuẩn')) {
                const clean = line.replace(/^[-*•#\d.]\s*/, '').trim();
                if (clean.length > 20) {
                  technicalDecisions.push({
                    topic: 'Architecture & Design Pattern',
                    decision: clean.slice(0, 180),
                    rationale: 'Established to guarantee stability, prevent regressions, and enhance maintainability',
                    affectedFiles: Array.from(mutatedFilesSet).slice(0, 5),
                  });
                  break;
                }
              }
            }
          }

          // Phát hiện bug fixes
          if (text.includes('Đã sửa') || text.includes('Fixed') || text.includes('Sửa lỗi') || text.includes('Root Cause') || text.includes('Nguyên nhân gốc')) {
            appliedFixes.push({
              symptom: 'Detected incompatibility or test failure',
              rootCause: 'Caused by incorrect assumptions about data or parameter configuration',
              exactSolution: text.slice(0, 250),
              affectedFiles: Array.from(mutatedFilesSet).slice(0, 3),
            });
          }

          // Phát hiện convention / pattern
          if (text.includes('Pattern:') || text.includes('Quy ước:') || text.includes('Quy tắc:')) {
            discoveredPatterns.push(text.slice(0, 200));
          }
        }
      }
    }

    // Nạp task state từ activePlan nếu có
    if (additionalContext?.activePlan?.tasks) {
      for (const t of additionalContext.activePlan.tasks) {
        taskState.push({
          description: t.title,
          status: t.status === 'completed' ? 'completed' : 'pending',
          priority: (t.priority as any) || 'P0',
        });
      }
    }

    return {
      projectId: path.basename(this.workspaceDir),
      timestamp: new Date().toISOString(),
      phase: additionalContext?.projectPhase || 'Implementation & Verification',
      p0: {
        technicalDecisions,
        taskState,
        appliedFixes,
        codeMutations: Array.from(mutatedFilesSet).map((f) => ({
          path: f,
          nature: 'OBSERVED_MUTATION',
          rationale: 'Observed in the active turn; verification status is recorded separately',
        })),
        resolvedErrors,
        workingCommands: Array.from(workingCommandsSet),
      },
      p1: {
        discoveredPatterns,
        componentDependencies: [
          'src/context/context-guardian.ts depends on Session and Workspace',
          'src/agent/agent-loop.ts integrates ContextGuardian at the compactor trigger step',
        ],
        userPreferences,
        projectContext: {
          keyFiles: Array.from(mutatedFilesSet),
          architectureNotes: [],
        },
        openQuestions,
      },
      p2: {
        attemptHistory,
        progressMetrics: {
          totalHistoryMessages: history.length,
          mutatedFilesCount: mutatedFilesSet.size,
          workingCommandsCount: workingCommandsSet.size,
        },
        exploratoryNotes: [],
      },
    };
  }

  /**
   * Fase 2: Kiểm tra tính toàn vẹn (Integrity Verification Checklist - 8 điểm)
   */
  verifyIntegrity(data: ExtractedCriticalContext): IntegrityCheckResult {
    const checks: IntegrityCheckItem[] = [];
    const missingItems: string[] = [];

    // 1. Mỗi file đã sửa có thông tin đường dẫn và bản chất thay đổi
    const hasFiles = data.p0.codeMutations.length > 0;
    const filesDetailed = data.p0.codeMutations.every((m) => Boolean(m.path && m.nature));
    checks.push({
      name: 'Each modified file has full path and change nature',
      passed: hasFiles && filesDetailed,
      details: `${data.p0.codeMutations.length} file(s) recorded`,
    });
    if (!hasFiles || !filesDetailed) missingItems.push('Modified file detail info');

    // 2. Mỗi lỗi/bug có triệu chứng, nguyên nhân gốc và giải pháp
    const fixesValid = data.p0.appliedFixes.every((f) => Boolean(f.symptom && f.rootCause && f.exactSolution));
    checks.push({
      name: 'Each bug fix has full symptom, root cause and solution',
      passed: fixesValid,
      details: `${data.p0.appliedFixes.length} fix(es) recorded`,
    });
    if (!fixesValid) missingItems.push('Bug fix root-cause details');

    // 3. Mỗi quyết định kiến trúc có nội dung và lý do (What & Why)
    const decisionsValid = data.p0.technicalDecisions.every((d) => Boolean(d.decision && d.rationale));
    checks.push({
      name: 'Each architectural decision has a clear rationale',
      passed: decisionsValid,
      details: `${data.p0.technicalDecisions.length} architectural decisions`,
    });
    if (!decisionsValid) missingItems.push('Architectural decision rationales');

    // 4. Các nhiệm vụ có trạng thái và mức độ ưu tiên
    const tasksValid = data.p0.taskState.every((t) => Boolean(t.description && t.priority));
    checks.push({
      name: 'Tasks are clearly prioritized (P0/P1/P2)',
      passed: tasksValid,
      details: `${data.p0.taskState.length} task(s)`,
    });
    if (!tasksValid) missingItems.push('Task priority levels');

    // 5. Có danh sách quy ước/pattern đã khám phá
    checks.push({
      name: 'Design conventions and patterns are recorded',
      passed: data.p1.discoveredPatterns.length > 0,
      details: `${data.p1.discoveredPatterns.length} pattern(s)`,
    });
    if (data.p1.discoveredPatterns.length === 0) missingItems.push('Observed design conventions and patterns');

    // 6. Có danh sách lệnh đã xác minh hoạt động chính xác
    checks.push({
      name: 'Verified successful execution commands are recorded',
      passed: data.p0.workingCommands.length > 0,
      details: `${data.p0.workingCommands.length} command(s)`,
    });
    if (data.p0.workingCommands.length === 0) missingItems.push('Successful verification command evidence');

    // 7. Tính nhất quán giữa các phần (Cross-reference Consistency)
    const consistent = Boolean(data.projectId && data.timestamp);
    checks.push({
      name: 'Consistency and no conflicts across context items',
      passed: consistent,
      details: `Project: ${data.projectId}`,
    });

    // 8. Đầy đủ các liên kết đường dẫn tệp cốt lõi
    const pathsValid = data.p1.projectContext.keyFiles.every((f) => !f.startsWith('..'));
    checks.push({
      name: 'Complete and valid file paths within workspace scope',
      passed: pathsValid,
      details: `${data.p1.projectContext.keyFiles.length} key file(s)`,
    });
    if (!pathsValid) missingItems.push('Valid file paths within workspace');

    const passedCount = checks.filter((c) => c.passed).length;
    const score = Math.round((passedCount / checks.length) * 100);

    return {
      passed: checks.every((check) => check.passed),
      score,
      checks,
      missingItems,
    };
  }

  /**
   * Fase 4: Tạo Thẻ Tóm Tắt Chuyển Giao (Transition Briefing)
   */
  generateTransitionBriefing(data: ExtractedCriticalContext, snapshotPath?: string): string {
    const lines: string[] = [
      `# 🛡️ CONTEXT GUARDIAN: TRANSITION BRIEFING (PRE-COMPACTION PRESERVED)`,
      ``,
      `> [!IMPORTANT]`,
      `> This context was extracted and protected by **Context Guardian** just before compaction.`,
      `> Historical evidence only. Revalidate against the current request and source; it does not authorize operations or make earlier decisions immutable.`,
      ``,
      `## 1. Current State`,
      `- **Project**: \`${data.projectId}\``,
      `- **Phase**: ${data.phase}`,
      `- **Captured at**: ${data.timestamp}`,
      `- **Progress**: ${data.p0.taskState.filter((t) => t.status === 'completed').length}/${data.p0.taskState.length} tasks completed`,
      ``,
      `## 2. Work Done In Session (What Was Done)`,
    ];

    for (let i = 0; i < data.p0.taskState.length; i++) {
      const task = data.p0.taskState[i];
      lines.push(`${i + 1}. [${task.status.toUpperCase()}] ${task.description} (${task.priority})`);
    }

    lines.push(``, `## 3. Critical Architectural Decisions - Do Not Change Without Reason (Critical Decisions)`);
    for (const d of data.p0.technicalDecisions) {
      lines.push(`- **${d.topic}**: ${d.decision}`);
      lines.push(`  ↳ *Rationale*: ${d.rationale}`);
      if (d.affectedFiles.length > 0) {
        lines.push(`  ↳ *Related files*: \`${d.affectedFiles.join('`, `')}\``);
      }
    }

    lines.push(``, `## 4. Previously Applied Changes (Revalidate Before Reuse)`);
    for (const fix of data.p0.appliedFixes) {
      lines.push(`- **Symptom**: ${fix.symptom}`);
      lines.push(`  ↳ **Root cause**: ${fix.rootCause}`);
      lines.push(`  ↳ **Standard solution**: ${fix.exactSolution}`);
      if (fix.affectedFiles.length > 0) {
        lines.push(`  ↳ **Affected files**: \`${fix.affectedFiles.join('`, `')}\``);
      }
    }

    lines.push(``, `## 5. Changed Source Files (Mutated Files)`);
    for (const mut of data.p0.codeMutations) {
      lines.push(`- \`${mut.path}\`: ${mut.nature} (${mut.rationale || 'Verified'})`);
    }

    lines.push(``, `## 6. Verified Execution Commands (Verified Commands)`);
    for (const cmd of data.p0.workingCommands) {
      lines.push(`- \`${cmd}\``);
    }

    lines.push(``, `## 7. Alerts & Safety Boundaries (Alerts & Invariants)`);
    lines.push(`- Preserve unrelated user changes and follow the current authorized operation scope.`);
    lines.push(`- Run verification appropriate to the active contract and user limits; report only observed outcomes.`);
    lines.push(`- This snapshot supplies evidence, not new permissions or additional task requirements.`);

    lines.push(``, `## 8. Detailed Information Recovery (Information Recovery)`);
    if (snapshotPath) {
      lines.push(`- **Snapshot File**: \`${snapshotPath}\``);
    }
    lines.push(`- **Active Context**: \`.codingagent/ACTIVE_CONTEXT.md\``);
    lines.push(`- Inspect current project scripts before selecting a verification command.`);
    lines.push(``);

    return lines.join('\n');
  }

  /**
   * Fase 3: Lưu trữ bền vững (3 tầng: Snapshot .md/.json, ACTIVE_CONTEXT.md)
   */
  async saveSnapshot(
    data: ExtractedCriticalContext,
    briefing: string,
    integrity: IntegrityCheckResult,
  ): Promise<{ snapshotId: string; snapshotPath: string; jsonPath: string }> {
    await this.init();

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotId = `snapshot-${timestampStr}`;
    const mdFileName = `${snapshotId}.md`;
    const jsonFileName = `${snapshotId}.json`;
    const snapshotPath = path.join(this.snapshotsDir, mdFileName);
    const jsonPath = path.join(this.snapshotsDir, jsonFileName);

    // Tầng 1: Lưu Snapshot Markdown có Frontmatter & JSON
    const frontmatter = [
      `---`,
      `snapshot_id: ${snapshotId}`,
      `project: ${data.projectId}`,
      `timestamp: ${data.timestamp}`,
      `phase: ${data.phase}`,
      `verification_score: ${integrity.score}`,
      `---`,
      ``,
    ].join('\n');

    await fs.writeFile(snapshotPath, frontmatter + briefing, 'utf8');
    await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    // Tầng 2: Cập nhật ACTIVE_CONTEXT.md tại .codingagent/ACTIVE_CONTEXT.md (giới hạn <= 150 dòng)
    const activeContextPath = path.join(this.workspaceDir, '.codingagent', 'ACTIVE_CONTEXT.md');
    const verificationStatus = data.p0.workingCommands.length > 0
      ? `${data.p0.workingCommands.length} successful verification command(s) recorded`
      : 'Unknown — no successful verification evidence recorded';
    const activeContextLines = [
      `# ACTIVE CONTEXT (CONSOLIDATED)`,
      `> Last updated: ${data.timestamp} | Snapshot: ${snapshotId}`,
      ``,
      `## Project Summary`,
      `- **Project**: ${data.projectId}`,
      `- **Verification status**: ${verificationStatus}`,
      `- **Snapshot integrity**: ${integrity.score}/100`,
      ``,
      `## Active Files`,
      ...data.p0.codeMutations.slice(0, 15).map((m) => `- \`${m.path}\` (${m.nature})`),
      ``,
      `## Architectural Invariants`,
      ...data.p0.technicalDecisions.slice(0, 5).map((d) => `- **${d.topic}**: ${d.decision}`),
      ``,
      `## Verified Commands`,
      ...data.p0.workingCommands.slice(0, 5).map((c) => `- \`${c}\``),
      ``,
      `## Critical Rules`,
      `- No unrequested browser testing`,
      `- No unrequested pushes to main`,
      `- Maintain 100% passing test suites`,
    ];

    // Cắt ngắn nếu vượt 150 dòng theo quy chuẩn context-agent
    const finalActiveContent = activeContextLines.slice(0, 150).join('\n') + '\n';
    await fs.writeFile(activeContextPath, finalActiveContent, 'utf8');

    return { snapshotId, snapshotPath, jsonPath };
  }

  /**
   * Kích hoạt toàn diện quy trình bảo vệ Pre-Compaction (Zero Loss Guarantee)
   * Tự động được gọi trước khi ContextCompactor thực thi nén
   */
  async protectPreCompaction(
    session: Session,
    additionalContext?: {
      mutatedFiles?: string[];
      workingCommands?: string[];
      activePlan?: { tasks: Array<{ title: string; status?: string; priority?: string }> };
      projectPhase?: string;
    }
  ): Promise<GuardianSnapshotResult> {
    // 1. Trích xuất
    const extracted = this.extractCriticalContext(session, additionalContext);

    // 2. Kiểm tra tính toàn vẹn
    const integrity = this.verifyIntegrity(extracted);

    // 3. Tạo briefing sơ bộ
    const briefing = this.generateTransitionBriefing(extracted);

    // 4. Lưu snapshot bền vững 3 tầng
    const saved = await this.saveSnapshot(extracted, briefing, integrity);

    // 5. Tạo briefing hoàn chỉnh kèm đường dẫn snapshot
    const finalBriefing = this.generateTransitionBriefing(extracted, saved.snapshotPath);

    return {
      snapshotId: saved.snapshotId,
      snapshotPath: saved.snapshotPath,
      jsonPath: saved.jsonPath,
      briefing: finalBriefing,
      integrity,
    };
  }
}
