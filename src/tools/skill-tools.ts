import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import type { SkillRegistry } from '../skills/skill-registry.js';

const MAX_LIST = 50;
const SCAN_LIMITS = { maxDepth: 5, maxDirs: 500, maxManifests: 50 };

// shortcut: only SKILL.md markdown is loaded, never executed code; upgrade to dynamic AgentPlugin import when a trust boundary exists.
export function createSkillTools(registry: SkillRegistry): ToolDefinition[] {
  const listSkills: ToolDefinition = {
    name: 'list_skills',
    description: 'List registered skills/plugins. Call first when a task may need a skill not yet loaded.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filter: {
          type: Type.STRING,
          description: 'Optional keyword to match id, name, description or tags.',
        },
      },
    },
    execute: async (args) => {
      const filter = typeof args.filter === 'string' && args.filter.trim() ? args.filter.trim() : undefined;
      const skills = filter ? registry.findApplicable(filter) : registry.list();
      return {
        count: skills.length,
        truncated: skills.length > MAX_LIST,
        skills: skills.slice(0, MAX_LIST).map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source })),
      };
    },
  };

  const loadSkills: ToolDefinition = {
    name: 'load_workspace_skills',
    description: 'Load SKILL.md skills from a workspace-relative dir or absolute linked-repo dir.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: 'Workspace-relative directory or absolute linked-repo directory containing SKILL.md files.',
        },
      },
      required: ['path'],
    },
    execute: async (args: Record<string, any>, workspace: Workspace) => {
      const rawPath = String(args.path || '').trim();
      if (!rawPath) return { error: 'The "path" parameter is required.', errorCode: 'INVALID_ARGS' };
      let resolved: string;
      let source: 'workspace' | 'external' = 'workspace';
      try {
        resolved = workspace.resolveSafePath(rawPath);
      } catch {
        if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
          resolved = path.resolve(rawPath);
          source = 'external';
        } else {
          return { error: `Path "${rawPath}" is outside the valid workspace scope.`, errorCode: 'PATH_OUT_OF_BOUNDS' };
        }
      }
      if (resolved === path.parse(resolved).root) {
        return { error: 'Refusing to scan a filesystem root directory.', errorCode: 'INVALID_ARGS' };
      }
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return { error: `Directory not found: "${rawPath}".`, errorCode: 'INVALID_ARGS' };
        }
      } catch (err: any) {
        return { error: err.message, errorCode: 'INVALID_ARGS' };
      }
      const diagBefore = registry.getDiagnostics().length;
      const before = new Set(registry.list().map((s) => s.id));
      const loaded = registry.discoverFromDirectory(resolved, source, SCAN_LIMITS);
      const added = registry.list().filter((s) => !before.has(s.id)).map((s) => s.id);
      const diagnostics = registry.getDiagnostics().slice(diagBefore).filter((d) => !/Duplicate skill ID/.test(d.error)).slice(-5);
      return { success: true, loaded, added, totalSkills: registry.list().length, diagnostics };
    },
  };

  return [listSkills, loadSkills];
}
