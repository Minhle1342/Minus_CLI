import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomically } from '../memory/atomic-write.js';
import type { ComposeGrillAnswer, ComposeTaskMatrixItem } from './compose-types.js';

export interface ComposeSpecInput {
  id: string;
  featureName: string;
  objective: string;
  grillQnA: ComposeGrillAnswer[];
  architectureContext: string[];
  implementationTasks: string[];
  registeredFiles: string[];
  testMatrix: ComposeTaskMatrixItem[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'feature';
}

export class SpecManager {
  readonly specDir: string;

  constructor(readonly workspaceRoot: string) {
    this.specDir = path.join(path.resolve(workspaceRoot), '.codingagent', 'compose', 'specs');
  }

  getDraftPath(featureName: string, id: string): string {
    return path.join(this.specDir, `${slug(featureName)}-${id.slice(0, 8)}.spec.md`);
  }

  getWorktreeRelativePath(featureName: string, id: string): string {
    return path.posix.join('docs', 'specs', `${slug(featureName)}-${id.slice(0, 8)}.spec.md`);
  }

  async generate(input: ComposeSpecInput): Promise<string> {
    const content = this.render(input, 'DRAFT');
    const specPath = this.getDraftPath(input.featureName, input.id);
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await writeFileAtomically(specPath, content);
    return specPath;
  }

  async lock(specPath: string): Promise<string> {
    const current = await fs.readFile(specPath, 'utf8');
    if (!current.includes('Status: DRAFT') && !current.includes('Status: LOCKED')) {
      throw new Error('Spec has no valid DRAFT/LOCKED status marker.');
    }
    const locked = current.replace('Status: DRAFT', 'Status: LOCKED');
    await writeFileAtomically(specPath, locked);
    const hash = this.hash(locked);
    await writeFileAtomically(`${specPath}.lock.json`, JSON.stringify({ version: 1, hash, lockedAt: new Date().toISOString() }, null, 2));
    return hash;
  }

  async verifyLock(specPath: string, expectedHash: string): Promise<boolean> {
    try {
      const [content, sidecar] = await Promise.all([
        fs.readFile(specPath, 'utf8'),
        fs.readFile(`${specPath}.lock.json`, 'utf8'),
      ]);
      const lock = JSON.parse(sidecar);
      return content.includes('Status: LOCKED') && lock.hash === expectedHash && this.hash(content) === expectedHash;
    } catch {
      return false;
    }
  }

  async read(specPath: string): Promise<string> {
    return fs.readFile(specPath, 'utf8');
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private render(input: ComposeSpecInput, status: 'DRAFT' | 'LOCKED'): string {
    const qna = input.grillQnA.length
      ? input.grillQnA.map((item) => `- **${item.question}**\n  ${item.answer || '_Unanswered_'}`).join('\n')
      : '- Objective was sufficiently explicit; no blocking clarification was generated.';
    const files = input.registeredFiles.length ? input.registeredFiles.map((file) => `- \`${file}\``).join('\n') : '- _No files registered_';
    const tasks = input.implementationTasks.map((task, index) => `${index + 1}. ${task}`).join('\n');
    const tests = input.testMatrix.map((item) => `- [ ] **${item.id}** — ${item.scenario}\n  - Command: \`${item.command}\`\n  - Expected exit: ${item.expectedExitCode}${item.expectedOutput ? `\n  - Expected output: \`${item.expectedOutput}\`` : ''}`).join('\n');
    return `# Compose Spec: ${input.featureName}\n\nStatus: ${status}\nCompose-ID: ${input.id}\n\n## Objective\n\n${input.objective}\n\n## Grill Contract\n\n${qna}\n\n## Codebase Intelligence\n\n${input.architectureContext.map((item) => `- ${item}`).join('\n')}\n\n## Blast Radius\n\n${files}\n\n## Implementation Tasks\n\n${tasks}\n\n## Acceptance Matrix\n\n${tests}\n\n## Invariants\n\n- Mutations are allowed only after this spec is locked and only inside the isolated worktree.\n- Every acceptance command must pass after the last successful mutation.\n- Every changed path must be registered in Blast Radius.\n- Finalization requires a fast-forward merge and successful cleanup.\n`;
  }
}
