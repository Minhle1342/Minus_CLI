import fs from 'node:fs';
import { SkillManifest } from './types.js';
import { SkillLoader } from './skill-loader.js';

export interface SkillRegistryOptions {
  workspaceRoot?: string;
  enableBuiltin?: boolean;
}

export class SkillRegistry {
  private skills: Map<string, SkillManifest> = new Map();
  private diagnostics: { id?: string; path?: string; error: string; timestamp: string }[] = [];
  private workspaceRoot?: string;

  constructor(options?: SkillRegistryOptions) {
    this.workspaceRoot = options?.workspaceRoot;
  }

  /**
   * Đăng ký một Skill Manifest vào Registry
   */
  register(manifest: SkillManifest): boolean {
    if (!manifest.id || typeof manifest.id !== 'string') {
      this.diagnostics.push({ error: 'Cannot register skill with invalid or empty ID', timestamp: new Date().toISOString() });
      return false;
    }

    if (!manifest.description) {
      this.diagnostics.push({ id: manifest.id, error: 'Skill description cannot be empty', timestamp: new Date().toISOString() });
      return false;
    }

    if (this.skills.has(manifest.id)) {
      this.diagnostics.push({ id: manifest.id, error: `Duplicate skill ID: ${manifest.id}`, timestamp: new Date().toISOString() });
      return false;
    }

    this.skills.set(manifest.id, manifest);
    return true;
  }

  /**
   * Hủy đăng ký một Skill
   */
  unregister(id: string): boolean {
    return this.skills.delete(id);
  }

  /**
   * Lấy manifest theo ID
   */
  get(id: string): SkillManifest | undefined {
    return this.skills.get(id);
  }

  /**
   * Liệt kê tất cả các skill đã đăng ký
   */
  list(): SkillManifest[] {
    return Array.from(this.skills.values());
  }

  /**
   * Nạp nội dung Markdown hướng dẫn của Skill
   */
  loadContent(id: string): string | null {
    const manifest = this.skills.get(id);
    if (!manifest || !manifest.path) return null;

    if (!fs.existsSync(manifest.path)) {
      this.diagnostics.push({ id, path: manifest.path, error: 'Skill file not found on disk', timestamp: new Date().toISOString() });
      return null;
    }

    try {
      const parsed = SkillLoader.loadSkillFile(manifest.path, manifest.source);
      return parsed.content;
    } catch (err: any) {
      this.diagnostics.push({ id, path: manifest.path, error: err.message, timestamp: new Date().toISOString() });
      return null;
    }
  }

  /**
   * Tìm các Skill phù hợp với bối cảnh / query
   */
  findApplicable(filter: string | { intent?: string; tags?: string[]; capabilities?: string[] }): SkillManifest[] {
    const list = this.list();
    if (!filter) return list;

    if (typeof filter === 'string') {
      const lower = filter.toLowerCase();
      return list.filter((s) =>
        s.id.includes(lower) ||
        s.name.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower) ||
        s.tags?.some((t) => t.toLowerCase().includes(lower))
      );
    }

    return list.filter((s) => {
      if (filter.intent) {
        const lowerIntent = filter.intent.toLowerCase();
        const matchesIntent =
          s.id.includes(lowerIntent) ||
          s.name.toLowerCase().includes(lowerIntent) ||
          s.description.toLowerCase().includes(lowerIntent);
        if (!matchesIntent) return false;
      }

      if (filter.tags && filter.tags.length > 0) {
        const hasTag = filter.tags.some((t) => s.tags?.includes(t));
        if (!hasTag) return false;
      }

      if (filter.capabilities && filter.capabilities.length > 0) {
        if (s.requiredCapabilities && s.requiredCapabilities.length > 0) {
          const hasCapability = s.requiredCapabilities.every((c) => filter.capabilities!.includes(c));
          if (!hasCapability) return false;
        }
      }

      return true;
    });
  }

  /**
   * Quét và đăng ký skills từ một thư mục
   */
  discoverFromDirectory(directory: string, source: 'builtin' | 'workspace' | 'external' = 'workspace'): number {
    const { manifests, errors } = SkillLoader.discoverSkills(directory, source);
    let count = 0;

    for (const manifest of manifests) {
      if (this.register(manifest)) {
        count++;
      }
    }

    for (const err of errors) {
      this.diagnostics.push({ path: err.path, error: err.error, timestamp: new Date().toISOString() });
    }

    return count;
  }

  getDiagnostics(): { id?: string; path?: string; error: string; timestamp: string }[] {
    return [...this.diagnostics];
  }

  clear(): void {
    this.skills.clear();
    this.diagnostics = [];
  }
}
