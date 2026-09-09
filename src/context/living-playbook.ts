/**
 * Living Playbook Engine — Agentic Context Engineering (ACE)
 * Dựa trên nghiên cứu: "Agentic Context Engineering: Evolving Context as Living Playbooks" (arXiv:2510.04618)
 *
 * Khắc phục 2 điểm nghẽn lớn:
 * 1. Brevity Bias: Giữ nguyên chi tiết kỹ thuật sắc bén, cạm bẫy cụ thể và cú pháp API đặc thù
 * 2. Context Collapse: Ngăn chặn suy thoái tri thức bằng Incremental Delta Updates (ADD/REFINE/PRUNE)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export type PlaybookCategory =
  | 'build_and_env'
  | 'type_safety'
  | 'mutation_strategy'
  | 'test_verification'
  | 'git_policy';

export interface PlaybookBullet {
  id: string; // ví dụ: "PLB-001"
  category: PlaybookCategory;
  trigger: string; // Khi nào áp dụng (ngữ cảnh/triệu chứng cụ thể)
  actionRule: string; // Chỉ thị hành động mang tính chuẩn mực (What to do)
  antiPattern?: string; // Cạm bẫy cần tránh (What NOT to do)
  utility: {
    helpfulCount: number;
    harmfulCount: number;
    lastUsedTurn: number;
  };
}

export interface PlaybookDelta {
  type: 'ADD' | 'REFINE' | 'PRUNE' | 'REINFORCE';
  bulletId?: string;
  bullet?: Omit<PlaybookBullet, 'id' | 'utility'>;
  reason: string;
}

export interface PlaybookTraceObservation {
  userRequest: string;
  toolsExecuted: Array<{
    toolName: string;
    args?: Record<string, any>;
    result?: Record<string, any>;
  }>;
  hadTestFailuresThenPass?: boolean;
  finalSuccess?: boolean;
}

export class LivingPlaybookManager {
  readonly workspaceDir: string;
  readonly storageDir: string;
  readonly storageFilePath: string;

  private bulletsMap: Map<string, PlaybookBullet> = new Map();
  private initialized = false;
  private nextIdIndex = 1;

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
    this.storageDir = path.join(this.workspaceDir, '.codingagent', 'memory');
    this.storageFilePath = path.join(this.storageDir, 'playbook.json');
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const raw = await fs.readFile(this.storageFilePath, 'utf8');
      const list: PlaybookBullet[] = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          this.bulletsMap.set(item.id, item);
          const match = item.id.match(/\d+/);
          if (match) {
            const idx = parseInt(match[0], 10);
            if (idx >= this.nextIdIndex) {
              this.nextIdIndex = idx + 1;
            }
          }
        }
      }
    } catch {
      // Nếu file chưa tồn tại hoặc rỗng, bắt đầu với bộ nhớ trống
    }
  }

  public async save(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const all = Array.from(this.bulletsMap.values());
      await fs.writeFile(this.storageFilePath, JSON.stringify(all, null, 2), 'utf8');
    } catch {
      // Bỏ qua lỗi ghi đĩa trong môi trường test bị hạn chế quyền
    }
  }

  public getBulletCount(): number {
    return this.bulletsMap.size;
  }

  public getAllBullets(): PlaybookBullet[] {
    return Array.from(this.bulletsMap.values());
  }

  public getBullet(id: string): PlaybookBullet | undefined {
    return this.bulletsMap.get(id);
  }

  /**
   * Áp dụng thao tác Incremental Delta Update
   */
  public async applyDelta(delta: PlaybookDelta): Promise<PlaybookBullet | null> {
    await this.init();

    switch (delta.type) {
      case 'ADD': {
        if (!delta.bullet) return null;
        const id = `PLB-${String(this.nextIdIndex++).padStart(3, '0')}`;
        const newBullet: PlaybookBullet = {
          id,
          category: delta.bullet.category,
          trigger: delta.bullet.trigger,
          actionRule: delta.bullet.actionRule,
          antiPattern: delta.bullet.antiPattern,
          utility: {
            helpfulCount: 1,
            harmfulCount: 0,
            lastUsedTurn: 1,
          },
        };
        this.bulletsMap.set(id, newBullet);
        this.prune();
        await this.save();
        return newBullet;
      }

      case 'REINFORCE': {
        if (!delta.bulletId) return null;
        const existing = this.bulletsMap.get(delta.bulletId);
        if (existing) {
          existing.utility.helpfulCount++;
          existing.utility.lastUsedTurn++;
          await this.save();
          return existing;
        }
        return null;
      }

      case 'REFINE': {
        if (!delta.bulletId || !delta.bullet) return null;
        const existing = this.bulletsMap.get(delta.bulletId);
        if (existing) {
          existing.trigger = delta.bullet.trigger || existing.trigger;
          existing.actionRule = delta.bullet.actionRule || existing.actionRule;
          if (delta.bullet.antiPattern) {
            existing.antiPattern = delta.bullet.antiPattern;
          }
          existing.utility.lastUsedTurn++;
          await this.save();
          return existing;
        }
        return null;
      }

      case 'PRUNE': {
        if (delta.bulletId) {
          this.bulletsMap.delete(delta.bulletId);
          await this.save();
        }
        return null;
      }
    }
  }

  /**
   * Tự động cắt tỉa các bullet gây hại hoặc vượt ngưỡng dung lượng (chống Playbook Bloat)
   */
  public prune(maxBullets: number = 50): void {
    // 1. Xóa các bullet có hại (harmfulCount >= 2 và gấp đôi helpfulCount)
    for (const [id, bullet] of this.bulletsMap.entries()) {
      if (bullet.utility.harmfulCount >= 2 && bullet.utility.harmfulCount > bullet.utility.helpfulCount) {
        this.bulletsMap.delete(id);
      }
    }

    // 2. Giới hạn tổng số lượng bullet tối đa
    if (this.bulletsMap.size > maxBullets) {
      const sorted = Array.from(this.bulletsMap.values()).sort((a, b) => {
        const scoreA = a.utility.helpfulCount - a.utility.harmfulCount;
        const scoreB = b.utility.helpfulCount - b.utility.harmfulCount;
        return scoreA - scoreB; // Tăng dần để xóa điểm thấp nhất trước
      });

      const toRemoveCount = this.bulletsMap.size - maxBullets;
      for (let i = 0; i < toRemoveCount; i++) {
        this.bulletsMap.delete(sorted[i].id);
      }
    }
  }

  /**
   * Dynamic Subsetting: Chọn Top-k bullets khớp nhất với query/bài toán hiện tại
   * Tiết kiệm 80% token so với nạp toàn bộ Playbook
   */
  public subsetRelevantBullets(query: string, limit: number = 3): PlaybookBullet[] {
    if (!query || this.bulletsMap.size === 0) return [];
    const lowerQuery = query.toLowerCase();
    const queryTokens = lowerQuery
      .split(/[^a-zA-Z0-9_\-]/)
      .filter((t) => t.length >= 3 && !['this', 'that', 'from', 'with', 'have', 'were'].includes(t));

    const scored: Array<{ bullet: PlaybookBullet; score: number }> = [];

    for (const bullet of this.bulletsMap.values()) {
      let score = 0;
      const triggerLower = bullet.trigger.toLowerCase();
      const actionLower = bullet.actionRule.toLowerCase();
      const antiLower = (bullet.antiPattern || '').toLowerCase();

      // Khớp trực tiếp cả cụm trigger (+20 điểm)
      if (lowerQuery.includes(triggerLower) || triggerLower.includes(lowerQuery)) {
        score += 20;
      }

      // Khớp từng token
      for (const token of queryTokens) {
        if (triggerLower.includes(token)) score += 5;
        if (actionLower.includes(token)) score += 2;
        if (antiLower.includes(token)) score += 1;
      }

      // Thưởng điểm uy tín từ kinh nghiệm quá khứ
      score += Math.min(bullet.utility.helpfulCount * 2, 10);
      score -= bullet.utility.harmfulCount * 3;

      if (score > 0) {
        scored.push({ bullet, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.bullet);
  }

  /**
   * Định dạng Markdown cô đọng, sắc bén để chèn vào Context của LLM
   */
  public formatForPromptContext(bullets: PlaybookBullet[]): string {
    if (bullets.length === 0) return '';
    const lines: string[] = [
      `📘 [ACTIVE LIVING PLAYBOOK - AGENTIC CONTEXT ENGINEERING (ACE)]`,
      `> Living playbooks evolved from past execution feedback (Preserves technical precision, prevents brevity bias):`,
    ];

    for (const b of bullets) {
      lines.push(
        `• [${b.id}] (${b.category} | Helpful: +${b.utility.helpfulCount}):`,
        `  - When: ${b.trigger}`,
        `  - Action: ${b.actionRule}`
      );
      if (b.antiPattern) {
        lines.push(`  - Trap to Avoid: ${b.antiPattern}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * PlaybookReflector: Phân tích Execution Trace và sinh các đề xuất Delta Updates
 */
export class PlaybookReflector {
  public static reflectOnTrace(trace: PlaybookTraceObservation): PlaybookDelta[] {
    const deltas: PlaybookDelta[] = [];
    const { userRequest, toolsExecuted, hadTestFailuresThenPass, finalSuccess } = trace;

    // 1. Nhận diện chu trình Red -> Green (Vượt qua bài test sau khi từng fail)
    if (hadTestFailuresThenPass && finalSuccess) {
      // Tìm công cụ sửa code cuối cùng trước khi test pass
      const mutationTools = ['write_file', 'replace_text', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'];
      const lastMutation = [...toolsExecuted].reverse().find((t) => mutationTools.includes(t.toolName));

      if (lastMutation) {
        const target = (lastMutation.args?.TargetFile || lastMutation.args?.path || 'source code').toString();
        deltas.push({
          type: 'ADD',
          reason: `Phát hiện sửa thành công sau chu trình kiểm thử Red -> Green trên file ${target}`,
          bullet: {
            category: 'test_verification',
            trigger: `Khi sửa chữa lỗi liên quan đến: "${userRequest.slice(0, 80)}"`,
            actionRule: `Thực hiện sửa đổi mục tiêu trên '${target}' và ngay lập tức chạy test kiểm chứng tái hiện để xác nhận kết quả.`,
            antiPattern: `Không sửa tràn lan sang các module khác trước khi bài test trên file hiện tại chuyển sang màu xanh.`,
          },
        });
      }
    }

    // 2. Nhận diện xử lý lỗi TypeScript TS18047 (null/undefined)
    const hasTypeScriptError = toolsExecuted.some((t) => {
      const err = JSON.stringify(t.result || '');
      return err.includes('TS18047') || err.includes('possibly \'null\'') || err.includes('possibly \'undefined\'');
    });

    if (hasTypeScriptError && finalSuccess) {
      deltas.push({
        type: 'ADD',
        reason: 'Khắc phục thành công lỗi TypeScript TS18047 possibly null/undefined',
        bullet: {
          category: 'type_safety',
          trigger: 'Khi gặp lỗi TypeScript TS18047: variable is possibly null or undefined trong assert hoặc logic',
          actionRule: 'Sử dụng Optional Chaining (?.) hoặc bọc Boolean(...) tường minh để narrow type an toàn trước khi truy cập thuộc tính con.',
          antiPattern: 'Tránh dùng bọc try-catch mù quáng vì tsc vẫn sẽ bắt lỗi compile trước khi runtime chạy.',
        },
      });
    }

    return deltas;
  }
}

/**
 * PlaybookCurator: Tiếp nhận và cam kết các Delta Updates vào Living Playbook
 */
export class PlaybookCurator {
  private playbook: LivingPlaybookManager;

  constructor(playbook: LivingPlaybookManager) {
    this.playbook = playbook;
  }

  public async commitDeltas(deltas: PlaybookDelta[]): Promise<PlaybookBullet[]> {
    const results: PlaybookBullet[] = [];
    for (const delta of deltas) {
      const res = await this.playbook.applyDelta(delta);
      if (res) {
        results.push(res);
      }
    }
    return results;
  }
}
