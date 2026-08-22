import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import type { Session } from '../session/session.js';
import { MemoryCategory, MemoryQueryOptions, MemoryRecord, MemoryScope, MemorySource } from './types.js';

export interface LearnedInsight extends Partial<Omit<MemoryRecord, 'key' | 'insight' | 'category'>> {
  key: string;
  insight: string;
  category?: MemoryCategory;
  recordedAt?: string;
}

export interface ProjectMemoryData {
  projectName: string;
  projectType: string;
  packageManager: string;
  scripts: Record<string, string>;
  keyDirectories: Record<string, string>;
  dependenciesSummary: string[];
  codingConventions: string[];
  learnedInsights: LearnedInsight[];
  lastIndexed: string;
}

/**
 * ProjectMemoryManager - Quản lý Bộ nhớ dài hạn đa tầng (Tier 2: Long-term Project Knowledge Base)
 * 
 * Lưu trữ tại `.codingagent/project-memory.json`:
 * 1. Lưu sơ đồ cấu trúc repo, package scripts, framework conventions.
 * 2. Cung cấp "Project Digest" để "Warm-Start" Agent ngay khi khởi động.
 * 3. Tránh việc LLM phải tốn 5 steps khảo sát lại cấu trúc cơ bản mỗi lần chạy.
 */
export class ProjectMemoryManager {
  private workspaceDir: string;
  private memoryFilePath: string;
  private memoryData: ProjectMemoryData;
  private session?: Session;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.memoryFilePath = path.join(this.workspaceDir, '.codingagent', 'project-memory.json');
    this.memoryData = this.getDefaultMemory();
  }

  private getDefaultMemory(): ProjectMemoryData {
    return {
      projectName: path.basename(this.workspaceDir),
      projectType: 'Unknown',
      packageManager: 'npm',
      scripts: {},
      keyDirectories: {},
      dependenciesSummary: [],
      codingConventions: [
        'TypeScript strict mode',
        'Surgical edits with replace_text',
        'Run test verification before concluding',
      ],
      learnedInsights: [],
      lastIndexed: new Date().toISOString(),
    };
  }

  /**
   * Khởi tạo bộ nhớ: Nạp từ đĩa hoặc tự động index nếu chưa tồn tại
   */
  async init(workspace?: Workspace): Promise<ProjectMemoryData> {
    try {
      await fs.mkdir(path.dirname(this.memoryFilePath), { recursive: true });
      const raw = await fs.readFile(this.memoryFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.memoryData = {
        ...this.getDefaultMemory(),
        ...parsed,
        learnedInsights: (parsed.learnedInsights || []).map((item: LearnedInsight) => this.normalizeInsight(item)),
      };
    } catch {
      // Chưa có file -> Tự động quét và index workspace lần đầu
      await this.autoIndexWorkspace(workspace ?? new Workspace(this.workspaceDir));
      await this.save();
    }
    return this.memoryData;
  }

  /**
   * Tự động quét cấu trúc repo để lập chỉ mục trí nhớ
   */
  async autoIndexWorkspace(workspace: Workspace): Promise<void> {
    const rootDir = workspace.rootDir;

    let projectType = 'Generic';
    let packageManager = 'npm';
    const scripts: Record<string, string> = {};
    const dependenciesSummary: string[] = [];
    const keyDirectories: Record<string, string> = {};

    // 1. Quét package.json (Node / TypeScript)
    try {
      const pkgPath = path.join(rootDir, 'package.json');
      const rawPkg = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(rawPkg);

      this.memoryData.projectName = pkg.name || path.basename(rootDir);
      projectType = pkg.devDependencies?.typescript || pkg.dependencies?.typescript ? 'Node.js / TypeScript' : 'Node.js / JavaScript';

      if (pkg.scripts && typeof pkg.scripts === 'object') {
        Object.assign(scripts, pkg.scripts);
      }

      if (pkg.dependencies) {
        dependenciesSummary.push(...Object.keys(pkg.dependencies).slice(0, 10));
      }
      if (pkg.devDependencies) {
        dependenciesSummary.push(...Object.keys(pkg.devDependencies).slice(0, 10));
      }
    } catch {}

    // 2. Quét các thư mục chính trong repo
    try {
      const entries = await fs.readdir(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !['node_modules', '.git', 'dist', '.codingagent'].includes(entry.name)) {
          if (entry.name === 'src') keyDirectories['src/'] = 'Mã nguồn chính của dự án';
          else if (entry.name === 'test' || entry.name === 'tests') keyDirectories[entry.name + '/'] = 'Thư mục kiểm thử';
          else if (entry.name === 'docs') keyDirectories['docs/'] = 'Tài liệu hướng dẫn';
          else keyDirectories[entry.name + '/'] = 'Thư mục module';
        }
      }
    } catch {}

    this.memoryData.projectType = projectType;
    this.memoryData.packageManager = packageManager;
    this.memoryData.scripts = scripts;
    this.memoryData.keyDirectories = keyDirectories;
    this.memoryData.dependenciesSummary = dependenciesSummary;
    this.memoryData.lastIndexed = new Date().toISOString();
  }

  /**
   * Lưu một hiểu biết hoặc kinh nghiệm mới vào bộ nhớ dài hạn
   */
  bindSession(session: Session): void {
    this.session = session;
  }

  setWorkspace(workspaceDir: string): void {
    this.workspaceDir = path.resolve(workspaceDir);
    this.memoryFilePath = path.join(this.workspaceDir, '.codingagent', 'project-memory.json');
    this.memoryData = this.getDefaultMemory();
    this.session = undefined;
  }

  async saveInsight(
    key: string,
    insight: string,
    category: LearnedInsight['category'] = 'insight',
    options: {
      scope?: MemoryScope;
      source?: MemorySource;
      confidence?: number;
      goalId?: string;
      tags?: string[];
      expiresAt?: string;
    } = {},
  ): Promise<MemoryRecord> {
    const scope = options.scope || 'project';
    if (scope !== 'project' && !this.session) {
      throw new Error(`Cannot save ${scope}-scoped memory without a bound session.`);
    }

    const now = new Date().toISOString();
    const existingRecords = scope === 'project'
      ? this.memoryData.learnedInsights
      : (this.session?.getMemoryRecords() || []);
    const sameKeyRecords = existingRecords.filter((item) => item.key === key);
    const existing = [...sameKeyRecords].reverse().find((item) => this.normalizeInsight(item).trustStatus === 'active')
      || sameKeyRecords.at(-1);
    const source = options.source || 'manual';
    const latestObservedResult = this.session?.getEvents()
      .filter((event) => event.type === 'tool/result')
      .at(-1);
    if (options.confidence !== undefined && (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1)) {
      throw new Error('Memory confidence must be a finite number between 0 and 1.');
    }
    if (options.expiresAt && !Number.isFinite(Date.parse(options.expiresAt))) {
      throw new Error('Memory expiresAt must be a valid ISO-8601 timestamp.');
    }
    const requestedConfidence = options.confidence ?? (source === 'model' ? 0.5 : 1);
    const normalizedExistingInsight = existing?.insight.trim().toLowerCase();
    const hasConflict = Boolean(existing && normalizedExistingInsight !== insight.trim().toLowerCase());
    const lacksModelProvenance = source === 'model' && !latestObservedResult;
    const existingIsUntrusted = Boolean(existing && this.normalizeInsight(existing).trustStatus !== 'active');
    const trustStatus = source === 'model' && (hasConflict || lacksModelProvenance || existingIsUntrusted)
      ? 'contested'
      : 'active';
    const modelExpiry = source === 'model'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
    const item: LearnedInsight = {
      id: trustStatus === 'contested'
        ? `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : existing?.id || `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      insight,
      category: category || 'insight',
      scope,
      source,
      confidence: Math.max(0, Math.min(1, trustStatus === 'contested'
        ? Math.min(requestedConfidence, 0.35)
        : requestedConfidence)),
      trustStatus,
      createdAt: trustStatus === 'contested' ? now : existing?.createdAt || now,
      updatedAt: now,
      sessionId: scope === 'project' ? undefined : this.session?.id,
      goalId: options.goalId,
      tags: options.tags,
      sourceEventSeq: latestObservedResult?.seq,
      sourceToolCallId: latestObservedResult?.data.toolCallId,
      expiresAt: options.expiresAt || modelExpiry,
      ...(trustStatus === 'contested'
        ? {
            conflictReason: hasConflict
              ? `Model-authored value conflicts with the previous value for key "${key}".`
              : `Model-authored value for key "${key}" has no supporting tool-result provenance.`,
          }
        : {}),
      recordedAt: now,
    };

    const record = this.normalizeInsight(item) as MemoryRecord;
    if (scope === 'project') {
      const existingIndex = trustStatus === 'contested'
        ? -1
        : this.memoryData.learnedInsights.findIndex((i) => i.id === record.id);
      if (existingIndex >= 0) {
        this.memoryData.learnedInsights[existingIndex] = record;
      } else {
        this.memoryData.learnedInsights.push(record);
      }
      await this.save();
    } else {
      this.session!.addMemoryRecord(record);
    }

    return record;
  }

  /**
   * Lưu toàn bộ dữ liệu trí nhớ xuống đĩa (.codingagent/project-memory.json)
   */
  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.memoryFilePath), { recursive: true });
    await fs.writeFile(this.memoryFilePath, JSON.stringify(this.memoryData, null, 2), 'utf-8');
  }

  /**
   * Tạo bản tóm tắt "Project Knowledge Digest" ngắn gọn (~150 tokens) để nạp sẵn cho LLM.
   * Áp dụng KV-Cache Prefix Alignment: Đảm bảo thứ tự xuất dữ liệu luôn cố định để tăng tỷ lệ Cache Hit.
   */
  getProjectDigest(): string {
    const lines: string[] = [
      `[PROJECT KNOWLEDGE BASE - WARM START MEMORY]`,
      `- Dự án: ${this.memoryData.projectName} (${this.memoryData.projectType})`,
    ];

    const scriptKeys = Object.keys(this.memoryData.scripts).sort();
    if (scriptKeys.length > 0) {
      lines.push(`- Lệnh khả dụng: ${scriptKeys.map((k) => `"${k}": npm run ${k}`).slice(0, 5).join(', ')}`);
    }

    const dirKeys = Object.keys(this.memoryData.keyDirectories).sort();
    if (dirKeys.length > 0) {
      lines.push(`- Cấu trúc thư mục: ${dirKeys.join(', ')}`);
    }

    const trustedInsights = this.memoryData.learnedInsights
      .map((item) => this.normalizeInsight(item))
      .filter((item) => this.isTrustedForAutomaticContext(item, 0.65))
      .slice(-4);
    if (trustedInsights.length > 0) {
      lines.push(`- Kinh nghiệm đã ghi nhớ:`);
      for (const item of trustedInsights) {
        lines.push(`  * [${item.key}; source=${item.source || 'manual'}; confidence=${(item.confidence ?? 1).toFixed(2)}]: ${item.insight}`);
      }
    }

    return lines.join('\n');
  }

  retrieve(query = '', options: MemoryQueryOptions = {}): MemoryRecord[] {
    const scopes = options.scopes || ['project', 'session', 'goal'];
    const minConfidence = options.minConfidence ?? 0;
    const now = Date.now();
    const candidates = [
      ...this.memoryData.learnedInsights.map((item) => this.normalizeInsight(item) as MemoryRecord),
      ...(this.session?.getMemoryRecords() || []),
    ].filter((item) => {
      if (!scopes.includes(item.scope)) return false;
      if (options.sessionId && item.sessionId !== options.sessionId) return false;
      if (options.goalId && item.goalId !== options.goalId) return false;
      if (item.confidence < minConfidence) return false;
      if (!options.includeContested && item.trustStatus !== 'active') return false;
      if (!options.includeExpired && item.expiresAt && Date.parse(item.expiresAt) <= now) return false;
      return true;
    });

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = candidates.map((item) => {
      const haystack = [item.key, item.insight, item.category, ...(item.tags || [])].join(' ').toLowerCase();
      const score = terms.length === 0
        ? 0
        : terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { item, score };
    });

    return scored
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
      .slice(0, options.limit ?? 8)
      .map(({ item }) => ({ ...item }));
  }

  getRelevantMemory(query: string, session?: Session, limit = 4): MemoryRecord[] {
    if (session) this.bindSession(session);
    return this.retrieve(query, { limit, minConfidence: 0.55 });
  }

  getMemoryData(): ProjectMemoryData {
    return {
      ...this.memoryData,
      learnedInsights: this.memoryData.learnedInsights.map((item) => ({ ...item })),
    };
  }

  private normalizeInsight(item: LearnedInsight): LearnedInsight {
    const now = new Date().toISOString();
    const source = item.source || 'manual';
    const rawConfidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? item.confidence
      : source === 'model' ? 0.5 : 1;
    const validTrustStatuses = new Set(['active', 'contested', 'superseded']);
    const invalidExpiry = Boolean(item.expiresAt && !Number.isFinite(Date.parse(item.expiresAt)));
    const inferredTrustStatus = source === 'model' && !item.sourceEventSeq ? 'contested' : 'active';
    const trustStatus = invalidExpiry
      ? 'contested'
      : validTrustStatuses.has(String(item.trustStatus))
        ? item.trustStatus!
        : inferredTrustStatus;
    return {
      ...item,
      id: item.id || `memory-${item.key}`,
      category: item.category || 'insight',
      scope: item.scope || 'project',
      source,
      confidence: Math.max(0, Math.min(1, rawConfidence)),
      trustStatus,
      ...(invalidExpiry ? { conflictReason: 'Memory contains an invalid expiration timestamp.' } : {}),
      createdAt: item.createdAt || item.recordedAt || now,
      updatedAt: item.updatedAt || item.recordedAt || now,
      recordedAt: item.recordedAt || item.updatedAt || now,
    };
  }

  private isTrustedForAutomaticContext(item: LearnedInsight, minConfidence: number): boolean {
    return (item.trustStatus || 'active') === 'active'
      && (item.confidence ?? 0) >= minConfidence
      && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now());
  }
}
