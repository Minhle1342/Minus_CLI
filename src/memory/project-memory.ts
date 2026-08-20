import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';

export interface LearnedInsight {
  key: string;
  insight: string;
  category?: 'convention' | 'architecture' | 'gotcha' | 'rule';
  recordedAt: string;
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
      this.memoryData = JSON.parse(raw);
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
  async saveInsight(key: string, insight: string, category: LearnedInsight['category'] = 'insight' as any): Promise<LearnedInsight> {
    const existingIndex = this.memoryData.learnedInsights.findIndex((i) => i.key === key);
    const item: LearnedInsight = {
      key,
      insight,
      category,
      recordedAt: new Date().toLocaleTimeString('vi-VN') + ' ' + new Date().toLocaleDateString('vi-VN'),
    };

    if (existingIndex >= 0) {
      this.memoryData.learnedInsights[existingIndex] = item;
    } else {
      this.memoryData.learnedInsights.push(item);
    }

    await this.save();
    return item;
  }

  /**
   * Lưu toàn bộ dữ liệu trí nhớ xuống đĩa (.codingagent/project-memory.json)
   */
  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.memoryFilePath), { recursive: true });
      await fs.writeFile(this.memoryFilePath, JSON.stringify(this.memoryData, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('Không thể lưu Project Memory:', err.message);
    }
  }

  /**
   * Tạo bản tóm tắt "Project Knowledge Digest" ngắn gọn (~150 tokens) để nạp sẵn cho LLM
   */
  getProjectDigest(): string {
    const lines: string[] = [
      `[PROJECT KNOWLEDGE BASE - WARM START MEMORY]`,
      `- Dự án: ${this.memoryData.projectName} (${this.memoryData.projectType})`,
    ];

    const scriptKeys = Object.keys(this.memoryData.scripts);
    if (scriptKeys.length > 0) {
      lines.push(`- Lệnh khả dụng: ${scriptKeys.map((k) => `"${k}": npm run ${k}`).slice(0, 5).join(', ')}`);
    }

    const dirKeys = Object.keys(this.memoryData.keyDirectories);
    if (dirKeys.length > 0) {
      lines.push(`- Cấu trúc thư mục: ${dirKeys.join(', ')}`);
    }

    if (this.memoryData.learnedInsights.length > 0) {
      lines.push(`- Kinh nghiệm đã ghi nhớ:`);
      for (const item of this.memoryData.learnedInsights.slice(-4)) {
        lines.push(`  * [${item.key}]: ${item.insight}`);
      }
    }

    return lines.join('\n');
  }

  getMemoryData(): ProjectMemoryData {
    return { ...this.memoryData };
  }
}
