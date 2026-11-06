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
  verifyDiff: `[TOOL PLAYBOOK V - VERIFY & DIFF AUDIT]\nInspect working tree with run_command("git diff") -> execute verification test command.`,
} as const;

export function resolveVerifyPlaybookPrompt(risk?: string): string {
  if (risk === 'R0' || risk === 'R1') {
    return `[TOOL PLAYBOOK V - VERIFY (R1 INSPECTION)]\nread_file -> verify state.`;
  }
  if (risk === 'R2') {
    return `[TOOL PLAYBOOK V - VERIFY (R2 TEST & DIFF)]\nRun the tests covering the changed code, then run_command("git diff").`;
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
- Inspect changes or recent context: \`git diff\`, \`git log -n 3 --oneline\`, or \`git show <hash> --stat\` (append \`-- <path>\` to scope). Never overwrite active user work.
- Read-only refs/authorship: \`git branch -a\`, \`git blame -L <start>,<end> -- <file>\`, \`git rev-parse HEAD\`, \`git tag --list\`, \`git stash list\`. Read-only inspection needs no extra approval.
- Separate unstaged (\`git diff -- <path>\`), staged (\`git diff --cached -- <path>\`), and untracked (\`git ls-files --others --exclude-standard\`) changes; read an untracked file before including it. Use \`git diff --name-status\` for renames/deletions and \`git diff --check\` for whitespace.
- Scope large output to paths or a commit range; use \`git --no-pager\` when paging would block run_command. A clean diff does not prove tests passed.`,

  gitBranch: `[GIT WORKFLOW - BRANCH ISOLATION]
- Check the current branch: \`run_command "git branch --show-current"\`.
- Create a branch only when requested: \`git checkout -b <branch-name>\`. Check existing changes first; a feature/refactor alone does not authorize creating or switching branches.
- Resolve the starting ref with \`git rev-parse --verify <ref>\`; do not assume main/master. Switch an existing branch with \`git switch <branch>\` only when requested; never force checkout to bypass local changes.
- Rename/delete only when requested. Prefer \`git branch -d <branch>\` after checking merged state; never replace a failed safe delete with -D. Report the final branch and preserved local changes.`,

  gitCommit: `[GIT WORKFLOW - ATOMIC STAGING & COMMIT]
- Execute only the requested staging/commit operation; staging does not authorize committing, and passing tests authorizes neither. Preserve pre-existing staged changes and commit only authorized changes.
- 1. Review \`git diff\` and \`git diff --cached\`; a normal commit includes the whole index, not just newly staged files.
- 2. Stage specific files: \`git add <file1> <file2>\`. Use \`git add .\` / \`-A\` only when the user explicitly requested that broad selector; run-time approval still applies.
- 3. Review \`git diff --cached --stat\` and the staged diff before committing. Preserve unrelated user work; isolate authorized changes and stage selectively within mixed files.
- 4. Commit: \`git commit -m \\"<type>(<scope>): <concise summary>\\"\` (always use -m to avoid interactive vim/nano). Respect repository hooks; do not bypass or amend unless requested.
- 5. Confirm with \`git log -1 --oneline\` and \`git show --stat HEAD\`, then inspect status. Report hooks/tests actually run and remaining changes. Commit permission does not imply push permission.`,

  gitPrEnhance: `[GIT WORKFLOW - PULL REQUEST ENHANCEMENT]
- 1. Identify the actual target branch from the request or repo config; do not assume origin/main. Use \`git diff --stat <base>...HEAD\`, \`git diff <base>...HEAD\`, and \`git log --oneline <base>..HEAD\`. If the base is unavailable, report that instead of fetching without authorization.
- 2. Structured PR Description:
   * Summary: 1-3 bullets on what changed and why.
   * Review Checklist: files and critical functions reviewers should scrutinize.
   * Verification Evidence: exact commands run (tests, build) and exit codes.
   * Risk Assessment: regression blast radius and mitigations.
- 3. Safety Gate: NEVER run git push --force. Push only when explicitly requested; preparing or reviewing a PR does not authorize it. The run-time approval prompt is the only confirmation; do not ask again in prose.
- Creating or updating a PR requires a matching request and an available PR tool/CLI. Review title, base/head, and description before submission; report the actual URL only after success. A review-only request authorizes inspection and findings.`,

  gitSync: `[GIT WORKFLOW - REMOTE SYNCHRONIZATION]
- Execute only the requested fetch, pull, or push within its authorized remote/ref scope. Inspect \`git status --short --branch\`, \`git branch -vv\`, and the configured remote first; never expose credentials in remote URLs.
- Fetch updates remote-tracking refs and needs a matching request or authorization as part of the requested sync. Do not fetch for unrelated read-only questions.
- Before pull, preserve local changes and identify upstream; prefer \`git pull --ff-only <remote> <branch>\` when no strategy was requested. On divergence, report it rather than silently choosing rebase, merge, reset, or autostash.
- Before push, inspect outgoing commits and confirm destination. Use an explicit remote/ref, e.g. \`git push <remote> HEAD:refs/heads/<branch>\`; set upstream only when appropriate. Never push all branches/tags or force push as a fallback.
- A rejected push is not permission to rewrite remote history. Report the rejection and the requested next action; confirm success from command output.`,

  gitImplement: `[GIT WORKFLOW - IMPLEMENTATION]
- Complete the requested changes on the inspected working tree and authorized branch; preserve unrelated and pre-existing edits. Git permissions do not authorize unrelated code changes.
- Follow the plan. Record actual edit results, then obtain successful relevant verification after the most recent edit; earlier test results cannot complete this stage. If no changes are needed, report the evidence and scope adjustment instead of making an artificial edit.
- Do not stage, commit, sync, or publish a PR while implementation is incomplete; report failed verification or missing evidence. This guidance is advisory; run-time Git policy still decides.`,

  gitIntegrate: `[GIT WORKFLOW - INTEGRATION & CONFLICTS]
- Merge, rebase, and cherry-pick only when requested, using the specified refs and strategy. Inspect status, starting HEAD, target history, and any active merge/rebase first; preserve user changes and never start a second integration.
- For conflicts, inspect \`git diff --name-only --diff-filter=U\` and each conflicted file. Resolve per the requested behavior and both branches' purpose; never blanket-select ours/theirs. Stage only resolved authorized paths and confirm conflict markers are gone.
- Continue an active operation only when completing it is authorized. Respect hooks and verification requirements; report verification actually performed.
- Abort only what the user authorized aborting. Do not reset --hard, clean, autostash, or rewrite shared history to escape conflicts. If the resolution is ambiguous, report the concrete alternatives.
- Inspect final history/status and summarize resulting commits, unresolved conflicts, and preserved changes. Local integration does not authorize pushing.`,

  gitRollback: `[GIT WORKFLOW - SAFE ROLLBACK & STASH]
- Perform only the requested undo/stash operation and paths. Inspect status and diff first; restore/checkout can discard uncommitted work, so preserve unrelated and pre-existing edits. Prefer reversing only your own edits in a shared file.
- Use \`git restore <path>\` only when discarding all unstaged changes there is authorized. Stash only authorized paths; applying/popping a stash also needs a matching request. Tool failures never authorize rollback or stash.
- To unstage requested paths, use \`git restore --staged -- <path>\` (keeps working-tree content). For a committed change, prefer \`git revert <hash>\` when the user wants an undo commit rather than rewritten history. Confirm the commit and handle conflicts within scope.
- Inspect \`git stash list\`/\`git stash show\` before selecting a stash; prefer apply when recovery should retain it, and drop/pop only when requested. Keep unrelated untracked files; never add -u/-a implicitly.
- Safety Gate: NEVER run destructive \`git reset --hard\` without explicit authorization. Never git clean, discard paths, or delete a stash as automatic repair. Inspect final status and report exactly what was restored, reverted, unstaged, or retained.`,
} as const;

export type GitWorkflowPromptId = keyof typeof GIT_WORKFLOW_PROMPTS;
