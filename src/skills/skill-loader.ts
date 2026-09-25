import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SkillManifest } from './types.js';

export interface ParseSkillResult {
  manifest?: SkillManifest;
  content: string;
  error?: string;
}

/**
 * SkillLoader - Trích xuất an toàn Metadata & Hướng dẫn Markdown của Skill
 */
export class SkillLoader {
  /**
   * Tính toán SHA-256 hash của nội dung skill
   */
  static computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Phân tích Front Matter YAML cơ bản không dùng eval/exec
   */
  static parseFrontMatter(rawContent: string): { attributes: Record<string, any>; body: string } {
    const trimmed = rawContent.trimStart();
    if (!trimmed.startsWith('---')) {
      return { attributes: {}, body: rawContent };
    }

    const endMarkerIndex = trimmed.indexOf('\n---', 3);
    if (endMarkerIndex === -1) {
      return { attributes: {}, body: rawContent };
    }

    const frontMatterStr = trimmed.slice(3, endMarkerIndex).trim();
    const body = trimmed.slice(endMarkerIndex + 4).trimStart();
    const attributes: Record<string, any> = {};

    const lines = frontMatterStr.split('\n');
    let currentKey = '';
    let isArray = false;

    for (const line of lines) {
      const lineTrim = line.trim();
      if (!lineTrim || lineTrim.startsWith('#')) continue;

      if (lineTrim.startsWith('- ') && currentKey) {
        if (!Array.isArray(attributes[currentKey])) {
          attributes[currentKey] = [];
        }
        attributes[currentKey].push(lineTrim.slice(2).trim());
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        currentKey = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();

        if (value === '') {
          isArray = true;
          attributes[currentKey] = [];
        } else {
          isArray = false;
          if (value === 'true') attributes[currentKey] = true;
          else if (value === 'false') attributes[currentKey] = false;
          else if (!isNaN(Number(value)) && value !== '') attributes[currentKey] = Number(value);
          else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            attributes[currentKey] = value.slice(1, -1);
          } else {
            attributes[currentKey] = value;
          }
        }
      }
    }

    return { attributes, body };
  }

  /**
   * Nạp và xác thực một file SKILL.md
   */
  static loadSkillFile(filePath: string, source: 'builtin' | 'workspace' | 'external' = 'workspace', rootDir?: string): ParseSkillResult {
    const resolvedPath = path.resolve(filePath);

    // Kiểm tra an toàn: Path Traversal
    if (rootDir) {
      const resolvedRoot = path.resolve(rootDir);
      const relative = path.relative(resolvedRoot, resolvedPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { content: '', error: `Path traversal detected: ${filePath} is outside ${rootDir}` };
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return { content: '', error: `Skill file not found: ${filePath}` };
    }

    try {
      const rawContent = fs.readFileSync(resolvedPath, 'utf8');
      const { attributes, body } = this.parseFrontMatter(rawContent);

      const skillId = String(attributes.id || attributes.name || path.basename(path.dirname(resolvedPath)) || path.basename(resolvedPath, '.md')).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const name = String(attributes.name || skillId).trim();
      const description = String(attributes.description || '').trim();
      const version = String(attributes.version || '1.0.0').trim();

      if (!skillId) {
        return { content: body, error: 'Skill ID cannot be blank' };
      }
      if (!description) {
        return { content: body, error: 'Skill description cannot be blank' };
      }

      const contentHash = this.computeHash(rawContent);

      const manifest: SkillManifest = {
        id: skillId,
        name,
        version,
        description,
        source,
        path: resolvedPath,
        requires: Array.isArray(attributes.requires) ? attributes.requires : undefined,
        conflicts: Array.isArray(attributes.conflicts) ? attributes.conflicts : undefined,
        priority: typeof attributes.priority === 'number' ? attributes.priority : 100,
        autoActivate: attributes.autoActivate === true,
        requiredCapabilities: Array.isArray(attributes.requiredCapabilities) ? attributes.requiredCapabilities : undefined,
        contentHash,
        tags: Array.isArray(attributes.tags) ? attributes.tags : undefined,
        author: attributes.author ? String(attributes.author) : undefined,
      };

      return { manifest, content: body };
    } catch (err: any) {
      return { content: '', error: `Failed to read skill file: ${err.message}` };
    }
  }

  /**
   * Quét và nạp tất cả các file SKILL.md trong một thư mục
   */
  static discoverSkills(directory: string, source: 'builtin' | 'workspace' | 'external' = 'workspace'): { manifests: SkillManifest[]; errors: { path: string; error: string }[] } {
    const manifests: SkillManifest[] = [];
    const errors: { path: string; error: string }[] = [];

    const resolvedDir = path.resolve(directory);
    if (!fs.existsSync(resolvedDir)) {
      return { manifests, errors };
    }

    const scanDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            scanDir(fullPath);
          } else if (entry.isFile()) {
            if (entry.name === 'SKILL.md' || entry.name.endsWith('.skill.md')) {
              const res = this.loadSkillFile(fullPath, source, resolvedDir);
              if (res.manifest) {
                manifests.push(res.manifest);
              } else if (res.error) {
                errors.push({ path: fullPath, error: res.error });
              }
            }
          }
        }
      } catch (err: any) {
        errors.push({ path: dir, error: err.message });
      }
    };

    scanDir(resolvedDir);
    return { manifests, errors };
  }
}
