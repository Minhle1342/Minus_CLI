import path from 'node:path';
import { PROACTIVE_SERVER_LAUNCH_RULE } from './shared.js';

/**
 * ON-DEMAND MODULE: UNIFIED DIFF FORMAT AND MATCHING SPECIFICATION
 * Split out from the core invariant to avoid bloating the startup prompt (~60 tokens).
 * Supports dynamic few-shot example selection by targetFile language (Python, Go, Rust, JSON, YAML, TypeScript).
 */
export function resolvePatchFormatSpec(targetFile?: string): string {
  const ext = targetFile ? path.extname(targetFile).toLowerCase() : '';

  let oneShotExample = `  --- a/src/example.ts
  +++ b/src/example.ts
  @@ -10,3 +10,3 @@
   const a = 1;
  -const b = 2;
  +const b = 3;
   return a + b;`;

  if (ext === '.py' || ext === '.pyi') {
    oneShotExample = `  --- a/app/calculator.py
  +++ b/app/calculator.py
  @@ -10,3 +10,3 @@
   def compute(a: int, b: int) -> int:
  -    return a - b
  +    return a + b`;
  } else if (ext === '.go') {
    oneShotExample = `  --- a/pkg/calc.go
  +++ b/pkg/calc.go
  @@ -12,3 +12,3 @@
   func Compute(a, b int) int {
  -	return a - b
  +	return a + b
   }`;
  } else if (ext === '.rs') {
    oneShotExample = `  --- a/src/calc.rs
  +++ b/src/calc.rs
  @@ -15,3 +15,3 @@
   pub fn compute(a: i32, b: i32) -> i32 {
  -    a - b
  +    a + b
   }`;
  } else if (ext === '.json') {
    oneShotExample = `  --- a/package.json
  +++ b/package.json
  @@ -5,3 +5,3 @@
     "version": "1.0.0",
  -  "debug": false,
  +  "debug": true,
     "main": "index.js"`;
  } else if (ext === '.yaml' || ext === '.yml') {
    oneShotExample = `  --- a/config.yaml
  +++ b/config.yaml
  @@ -8,3 +8,3 @@
   service:
  -  enabled: false
  +  enabled: true
     timeout: 30`;
  }

  return `UNIFIED DIFF & CODE MODIFICATION SPECIFICATION:
- Header: --- a/<path> followed by +++ b/<path>
- Hunk format: @@ -start,count +start,count @@
- Context lines prefix with ' ', deletions prefix with '-', additions prefix with '+'
- 1-Shot Example:
${oneShotExample}
- Line Matching: Match lines precisely with the target file. Call read_file for exact line matching and contentHash before modifying.
- Optimistic Concurrency: If providing expectedFileHash, pass the exact contentHash string from read_file.`;
}

export const SECTION_PATCH_FORMAT_SPEC = resolvePatchFormatSpec();

/**
 * TIER 1: DOMAIN MODULES (Progressive Disclosure)
 */

export const SECTION_GIT_OPERATIONS = `### GIT & TESTING RUNTIME OPERATIONS:
   - Use run_command for read-only Git inspection (git status, git diff, git log, git show) when relevant. Before editing code, inspect existing changes and preserve user work, including staged and untracked files.
   - Change Git state (stage, commit, create/switch branches, push, restore, revert, stash, reset) only when the user requests or approves that exact operation and scope; the run-time approval check must still accept the command. Editing code, passing tests, generated plan steps, or tool failures alone do not authorize it. Never overwrite or discard unrelated user changes.
   - Execute test suites (npm test, npx jest, pytest, cargo test, etc.) directly via run_command.
   - NEVER push to main/master unless explicitly requested by the user.`;

export const SECTION_FRONTEND_UI = `### FRONTEND & UI DESIGN STANDARD:
   - Inspect existing design tokens, CSS variables, and spacing before adding components.
   - Respect component libraries (Radix, Tailwind, Shadcn/UI), state hooks, and accessibility (aria-*). Verify UI changes with the project's type/build check when one exists (e.g. \`tsc --noEmit\`).`;

export const SECTION_ANTIGRAVITY_TOOLS = `### COMMAND & WEB RETRIEVAL TOOLCHAIN:
   - run_command: Run fast commands (<5s) synchronously; ${PROACTIVE_SERVER_LAUNCH_RULE}
   - Web retrieval: Use web_search and web_fetch for third-party docs, APIs, and web inspection.`;

export const SECTION_CODEBASE_INTELLIGENCE = `### CODEBASE & SYSTEM OPERATIONS:
   - Workspace files: use run_command for directory layouts/globs (\`rg --files\`, \`ls\`, \`dir\`) and to search inside file contents (\`rg -n\`); inspect exact lines with read_file; edit with replace_text or write_file.
   - Runtime, system & databases: use run_command freely for shell commands, container execution, database queries, network tools, build, and test verification at any step.`;

export const SECTION_TOOL_PLAYBOOKS = `### TOOL SYNERGY PLAYBOOKS:
   - Dynamic per-step tool selection: freely select the most appropriate tools for the task — file tools for workspace code, and run_command for runtime environment, databases, and testing.`;

/** Small cache-safe tail modules selected by StepPromptPolicy. */
export const TOOL_PLAYBOOK_PROMPTS = {
  verifyDiff: `[TOOL PLAYBOOK V - VERIFY & DIFF AUDIT (R3+ STRICT)]\nexecute verification test command (verify fail→pass for bugfix/security, tests covering changed code & callers) -> inspect working tree with run_command("git diff") -> report exact command, scope, and outcome.`,
} as const;

export function resolveVerifyPlaybookPrompt(risk?: string): string {
  if (risk === 'R0' || risk === 'R1') {
    return `[TOOL PLAYBOOK V - VERIFY (R1 INSPECTION)]\nread_file -> verify state.`;
  }
  if (risk === 'R2') {
    return `[TOOL PLAYBOOK V - VERIFY (R2 TEST & DIFF)]\nRun the tests covering the changed code, then run_command("git diff") -> report exact command, scope, and outcome.`;
  }
  return TOOL_PLAYBOOK_PROMPTS.verifyDiff;
}

export type ToolPlaybookPromptId = keyof typeof TOOL_PLAYBOOK_PROMPTS;

/**
 * On-demand Git workflow modules selected strictly by StepPromptPolicy based on phase & user action.
 * Inject only the relevant module; keep detailed Git guidance out of unrelated steps.
 */
export const GIT_WORKFLOW_PROMPTS = {
  gitInspect: `[GIT WORKFLOW - BASELINE INSPECTION]
- Check status: \`run_command "git status -s"\`.
- Inspect changes: \`git diff\` (unstaged), \`git diff --cached\` (staged), or batched \`git status -s && git diff HEAD\`. Scope with \`-- <path>\`.
- Read-only refs: \`git branch -a\`, \`git log -n 3 --oneline\`, \`git blame -L <start>,<end> -- <file>\`, \`git rev-parse HEAD\`, \`git tag --list\`, \`git stash list\`. Read-only inspection needs no extra approval.
- Large output: scope to paths/commit range; use \`--no-pager\`. A clean diff does not prove tests passed.`,

  gitBranch: `[GIT WORKFLOW - BRANCH ISOLATION]
- Check the current branch: \`run_command "git branch --show-current"\`.
- Create a branch only when requested: \`git checkout -b <branch-name>\`. Check existing changes first.
- Resolve the starting ref with \`git rev-parse --verify <ref>\`; do not assume main/master. Switch an existing branch with \`git switch <branch>\` only when requested.
- Rename/delete only when requested. Prefer safe \`git branch -d <branch>\`; never replace a failed safe delete with -D.`,

  gitCommit: `[GIT WORKFLOW - ATOMIC STAGING & COMMIT]
- Staging does not authorize committing, and passing tests authorizes neither. Commit only authorized changes.
- 1. Review changes: \`git diff\` & \`git diff --cached\` (or \`git status -s\`).
- 2. Stage specific files: \`git add <file1> <file2>\`. Use \`git add .\` / \`-A\` only when the user explicitly requested that broad selector.
- 3. Commit: \`git commit -m "<type>(<scope>): <concise summary>"\` (always use -m to avoid interactive vim/nano). Respect repo hooks; commit permission does not imply push permission.
- 4. Confirm with \`git log -1 --oneline\` and \`git status -s\`.`,

  gitPrEnhance: `[GIT WORKFLOW - PULL REQUEST ENHANCEMENT]
- 1. Identify target branch; do not assume origin/main. Compare: \`git diff --stat <base>...HEAD\` & \`git log --oneline <base>..HEAD\`.
- 2. Structured PR Description:
   * Summary: 1-3 bullets on what changed and why.
   * Review Checklist: files and critical functions reviewers should scrutinize.
   * Verification Evidence: exact commands run (tests, build) and exit codes.
   * Risk Assessment: regression blast radius and mitigations.
- 3. Safety Gate: NEVER run git push --force. Push only when explicitly requested; creating or updating a PR requires a matching request.`,

  gitSync: `[GIT WORKFLOW - REMOTE SYNCHRONIZATION]
- Inspect first: \`git status -sb\`, \`git branch -vv\`. Never expose credentials in remote URLs.
- Fetch: \`git fetch <remote>\` updates remote-tracking refs; do not fetch for unrelated read-only queries.
- Pull: prefer \`git pull --ff-only <remote> <branch>\`. On divergence, report it; do not silently rebase/reset.
- Push: inspect outgoing commits first. Use explicit remote/ref: \`git push <remote> HEAD:refs/heads/<branch>\`. NEVER push to main/master without explicit authorization.`,

  gitImplement: `[GIT WORKFLOW - IMPLEMENTATION]
- Complete requested changes on inspected working tree; preserve unrelated user edits.
- Follow the plan. Verify after the most recent edit with \`run_command\`; earlier tests cannot complete this stage.
- Do not stage, commit, sync, or publish a PR while implementation is unverified.`,

  gitIntegrate: `[GIT WORKFLOW - INTEGRATION & CONFLICTS]
- Merge/rebase/cherry-pick only when requested. Inspect status and active merge/rebase first.
- Conflicts: inspect \`git diff --name-only --diff-filter=U\` and conflicted files. Resolve per requested behavior; never blanket-select ours/theirs. Stage only resolved authorized paths and confirm conflict markers are gone.
- Abort only what the user authorized aborting. Do not reset --hard or clean to escape conflicts. Local integration does not authorize pushing.`,

  gitRollback: `[GIT WORKFLOW - SAFE ROLLBACK & STASH]
- Perform only requested undo/stash operation. Inspect status and diff first; preserve unrelated work.
- Discard unstaged changes: \`git restore <path>\`. Unstage: \`git restore --staged -- <path>\`. Undo commit: \`git revert <hash>\`.
- Stash: inspect \`git stash list\` / \`git stash show\` before applying; drop/pop only when requested.
- Safety Gate: NEVER run destructive \`git reset --hard\` without explicit authorization. Never git clean or discard paths as automatic repair.`,
} as const;

export type GitWorkflowPromptId = keyof typeof GIT_WORKFLOW_PROMPTS;
