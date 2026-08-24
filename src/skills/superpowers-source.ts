import path from 'node:path';
import fs from 'node:fs';
import { SkillManifest } from './types.js';
import { SkillRegistry } from './skill-registry.js';
import { SkillLoader } from './skill-loader.js';

/**
 * Superpowers Built-in Skill Definitions
 */
export const SUPERPOWERS_BUILTIN_SKILLS: Omit<SkillManifest, 'path' | 'source'>[] = [
  {
    id: 'using-superpowers',
    name: 'Using Superpowers',
    version: '1.0.0',
    description: 'Bootstrap and guide the agent to discover, select, and follow the Superpowers skills workflow.',
    priority: 10,
    autoActivate: true,
    requiredCapabilities: ['filesystem.read', 'plan.update'],
    tags: ['meta', 'bootstrap', 'superpowers'],
  },
  {
    id: 'brainstorming',
    name: 'Brainstorming',
    version: '1.0.0',
    description: 'Explore problem space, generate alternatives, analyze trade-offs, and align on scope before implementation.',
    priority: 20,
    requiredCapabilities: ['filesystem.read', 'plan.update'],
    tags: ['planning', 'design', 'superpowers'],
  },
  {
    id: 'writing-plans',
    name: 'Writing Plans',
    version: '1.0.0',
    description: 'Decompose high-level goals into phased, testable, atomic task specifications with strict acceptance criteria.',
    priority: 30,
    requires: ['brainstorming'],
    requiredCapabilities: ['plan.update', 'filesystem.read'],
    tags: ['planning', 'decomposition', 'superpowers'],
  },
  {
    id: 'using-git-worktrees',
    name: 'Using Git Worktrees',
    version: '1.0.0',
    description: 'Create and manage isolated Git worktree workspaces for clean feature development without disturbing the main tree.',
    priority: 40,
    requiredCapabilities: ['worktree.create', 'worktree.list', 'worktree.remove'],
    tags: ['git', 'isolation', 'superpowers'],
  },
  {
    id: 'test-driven-development',
    name: 'Test-Driven Development (TDD)',
    version: '1.0.0',
    description: 'Enforce the Red-Green-Refactor cycle: write failing tests first, implement minimal code, and verify before refactoring.',
    priority: 50,
    requiredCapabilities: ['filesystem.read', 'filesystem.edit', 'shell.verify'],
    tags: ['tdd', 'testing', 'quality', 'superpowers'],
  },
  {
    id: 'subagent-driven-development',
    name: 'Subagent-Driven Development',
    version: '1.0.0',
    description: 'Dispatch clean-context subagents for discrete, isolated tasks with explicit briefs, review gates, and result aggregation.',
    priority: 60,
    requires: ['writing-plans'],
    requiredCapabilities: ['agent.spawn', 'agent.wait', 'agent.review'],
    tags: ['subagents', 'orchestration', 'superpowers'],
  },
  {
    id: 'requesting-code-review',
    name: 'Requesting Code Review',
    version: '1.0.0',
    description: 'Prepare concise, diff-focused code review packages with automated verification evidence and clear risk assessments.',
    priority: 70,
    requiredCapabilities: ['git.diff', 'review.request'],
    tags: ['review', 'quality', 'superpowers'],
  },
  {
    id: 'git-operations',
    name: 'Git Operations',
    version: '1.0.0',
    description: 'Discover installed Git subcommands with git_list_commands and execute any Git CLI operation through git_command using separate argv. Prefer dedicated git_status, git_diff, git_add, git_commit, and git_push tools for common flows. Read-only commands are safe to inspect; write, network, and destructive commands must match the explicit current user request. Never route Git through run_command.',
    priority: 75,
    requiredCapabilities: ['git.command', 'git.list', 'git.status', 'git.diff'],
    tags: ['git', 'version-control', 'repository'],
  },
  {
    id: 'frontend-ui-engineering',
    name: 'Frontend & UI Design Engineering',
    version: '1.0.0',
    description: 'Specialized frontend UI design and component engineering following Codex CLI standards: inspect theme/design tokens first, avoid generic design defaults, preserve reactivity hooks and state flow, apply surgical UI diffs, and verify with compiler/linter.',
    priority: 65,
    requiredCapabilities: ['filesystem.read', 'filesystem.edit', 'shell.verify'],
    tags: ['frontend', 'ui', 'design', 'tailwind', 'css', 'react', 'vue', 'svelte', 'component', 'giao diện'],
  },
  {
    id: 'finishing-a-development-branch',
    name: 'Finishing a Development Branch',
    version: '1.0.0',
    description: 'Inspect changes, verify the full test suite, stage atomic commits, and push to the user-requested remote branch. Use git_status, git_diff, git_add, git_commit, then git_push; report credential or branch-protection failures only after observing the tool result.',
    priority: 80,
    requires: ['git-operations'],
    requiredCapabilities: ['git.status', 'git.stage', 'git.commit', 'git.push', 'worktree.remove', 'shell.verify'],
    tags: ['git', 'cleanup', 'release', 'superpowers'],
  },
];

/**
 * SuperpowersSource - Quản lý nạp bộ Superpowers skills từ thư mục hoặc built-in definitions
 */
export class SuperpowersSource {
  static readonly SOURCE_NAME = 'obra/superpowers';

  /**
   * Đăng ký bộ Superpowers Skills vào SkillRegistry
   */
  static registerSuperpowers(registry: SkillRegistry, customRootPath?: string): number {
    let count = 0;

    // 1. Quét từ thư mục cục bộ nếu tồn tại
    const searchPaths = [
      customRootPath,
      path.join(process.cwd(), '.codingagent', 'skills'),
      path.join(process.cwd(), 'skills'),
      path.join(process.cwd(), 'node_modules', 'superpowers', 'skills'),
    ].filter(Boolean) as string[];

    for (const root of searchPaths) {
      if (fs.existsSync(root)) {
        const discovered = registry.discoverFromDirectory(root, 'workspace');
        if (discovered > 0) {
          count += discovered;
        }
      }
    }

    // 2. Nạp Built-in definitions nếu chưa có
    for (const def of SUPERPOWERS_BUILTIN_SKILLS) {
      if (!registry.get(def.id)) {
        const manifest: SkillManifest = {
          ...def,
          source: 'builtin',
          path: `builtin://superpowers/${def.id}`,
          contentHash: SkillLoader.computeHash(def.description),
        };
        if (registry.register(manifest)) {
          count++;
        }
      }
    }

    return count;
  }
}
