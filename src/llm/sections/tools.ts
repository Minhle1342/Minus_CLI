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

export const SECTION_GIT_OPERATIONS = `8. GIT & TESTING RUNTIME OPERATIONS (INDUSTRY STANDARD):
   - Use run_command for read-only Git inspection (git status, git diff, git log, git show) when relevant. Before editing code, inspect existing changes and preserve user work, including staged and untracked files.
   - Change Git state (stage, commit, create/switch branches, push, restore, revert, stash, reset) only when the user requests or approves that exact operation and scope; the run-time approval check must still accept the command. Editing code, passing tests, generated plan steps, or tool failures alone do not authorize it. Never overwrite or discard unrelated user changes.
   - Execute test suites (npm test, npx jest, pytest, cargo test, etc.) directly via run_command.
   - NEVER push to main/master unless explicitly requested by the user.`;

export const SECTION_FRONTEND_UI = `9. FRONTEND & UI DESIGN STANDARD:
   - Inspect existing design tokens, CSS variables, and spacing before adding components.
   - Respect component libraries (Radix, Tailwind, Shadcn/UI), state hooks, and accessibility (aria-*). Verify UI changes with the project's type/build check when one exists (e.g. \`tsc --noEmit\`).`;

export const SECTION_ANTIGRAVITY_TOOLS = `10. COMMAND & WEB RETRIEVAL TOOLCHAIN:
   - run_command: Run fast commands (<5s) synchronously; ${PROACTIVE_SERVER_LAUNCH_RULE}
   - Web retrieval: Use web_search and web_fetch for third-party docs, APIs, and web inspection.`;

export const SECTION_CODEBASE_INTELLIGENCE = `11. CODEBASE ARCHITECTURE & SEMANTIC INTELLIGENCE:
   - Use list_files to inspect directory layouts, search_text for regex/keyword code searches, and read_file to inspect exact implementation lines.
   - Use run_command for build, git, and test verification.`;

export const SECTION_TOOL_PLAYBOOKS = `12. TOOL SYNERGY PLAYBOOKS:
   - Dynamic per-step tool chain: explore with list_files and search_text, inspect with read_file, edit with replace_text or write_file, verify with run_command.`;

/** Small cache-safe tail modules selected by StepPromptPolicy. */
export const TOOL_PLAYBOOK_PROMPTS = {
  architecture: `[TOOL PLAYBOOK A - ARCHITECTURE]\nlist_files -> read_file.`,
  rootCause: `[TOOL PLAYBOOK B - ROOT CAUSE]\nlist_files -> read_file -> run_command.`,
  mutation: `[TOOL PLAYBOOK C - MUTATION]\nread_file -> replace_text / write_file -> run_command.`,
  longTask: `[TOOL PLAYBOOK D - LONG TASK / SERVER]\nrun_command(WaitMsBeforeAsync=5000) -> inspect startup logs.`,
  subagent: `[TOOL PLAYBOOK E - EXECUTION]\nread_file -> replace_text -> run_command.`,
  dagPlan: `[TOOL PLAYBOOK F - PLAN & VERIFY]\nread_file -> replace_text -> run_command.`,
  verifyDiff: `[TOOL PLAYBOOK V - VERIFY & DIFF AUDIT]\nInspect working tree with run_command("git diff") -> execute verification test command.`,
} as const;

export function resolveVerifyPlaybookPrompt(risk?: string): string {
  if (risk === 'R0' || risk === 'R1') {
    return `[TOOL PLAYBOOK V - VERIFY (R1 INSPECTION)]\nread_file -> verify state.`;
  }
  if (risk === 'R2') {
    return `[TOOL PLAYBOOK V - VERIFY (R2 TEST & DIFF)]\nrun_command(npm test) -> run_command("git diff").`;
  }
  return TOOL_PLAYBOOK_PROMPTS.verifyDiff;
}

export type ToolPlaybookPromptId = keyof typeof TOOL_PLAYBOOK_PROMPTS;

/**
 * On-demand Git workflow modules selected strictly by StepPromptPolicy based on phase & intent.
 * Inject only the relevant module; keep detailed Git guidance out of unrelated steps.
 */
export const GIT_WORKFLOW_PROMPTS = {
  gitInspect: `[GIT WORKFLOW - BASELINE INSPECTION]
- Check working tree status: \`run_command "git status -s"\`.
- Inspect uncommitted changes or recent commit context: \`run_command "git diff"\` or \`git log -n 3 --oneline\`. Never overwrite active user work.
- Inspect any commit in full: \`run_command "git show <hash> --stat"\` (append \`-- <path>\` to scope it to one file).
- Map refs and authorship without mutating: \`run_command "git branch -a"\`, \`git blame -L <start>,<end> -- <file>\`, \`git rev-parse HEAD\`, \`git tag --list\`, or \`git stash list\`. Read-only inspection needs no extra approval.
- Distinguish unstaged changes (\`git diff -- <path>\`), staged changes (\`git diff --cached -- <path>\`), and untracked files (\`git ls-files --others --exclude-standard\`). Inspect file contents before including an untracked file. Use \`git diff --name-status\` for renames/deletions and \`git diff --check\` for whitespace issues.
- Scope large output to paths or a commit range. Use \`git --no-pager\` when paging would block run_command. Report findings without claiming that a clean diff proves tests passed.`,

  gitBranch: `[GIT WORKFLOW - BRANCH ISOLATION]
- Check current branch: \`run_command "git branch --show-current"\`.
- Only when the user requests branch creation, use \`run_command "git checkout -b <branch-name>"\`. Check existing changes first and preserve user work; a feature/refactor alone does not authorize creating or switching branches.
- Resolve the requested starting ref with \`git rev-parse --verify <ref>\`; do not assume main/master. For an existing branch, use \`git switch <branch>\` only when switching is requested. Never force checkout to bypass local changes.
- Rename/delete branches only when requested. Prefer \`git branch -d <branch>\` after checking merged state; do not replace a failed safe deletion with -D. Report the final branch and any preserved local changes.`,

  gitCommit: `[GIT WORKFLOW - ATOMIC STAGING & COMMIT]
- Execute only the staging/commit operation requested by the user. A staging-only request does not authorize committing; passing tests does not authorize either operation. Preserve pre-existing staged changes and include only authorized changes in a commit.
- 1. Review exact changes: \`run_command "git diff"\` and \`git diff --cached\`. Inspect existing staged changes before adding anything; a normal commit includes the whole index, not just newly staged files.
- 2. Stage specific modified files: \`run_command "git add <file1> <file2>"\`. Use \`git add .\`/\`-A\` only when the user explicitly requested that broad selector; the run-time approval check still applies.
- 3. Review \`git diff --cached --stat\` and the staged diff before committing. If the index contains unrelated user work, preserve it and isolate only authorized changes; do not silently commit or unstage their work. Mixed changes within a file require selective staging, not staging the entire file.
- 4. Conventional Commit: \`run_command "git commit -m \\"<type>(<scope>): <concise summary>\\""\` (always include -m to prevent interactive vim/nano hang). Respect repository hooks; do not bypass them or retry by amending unless requested.
- 5. Confirm the resulting hash and changed paths with \`git log -1 --oneline\` and \`git show --stat HEAD\`, then inspect status. Report hooks/tests actually executed and remaining changes. Never infer push permission from commit permission.`,

  gitPrEnhance: `[GIT WORKFLOW - PULL REQUEST ENHANCEMENT]
- 1. Identify the actual target branch from the request or repository configuration; do not assume origin/main. Use \`git diff --stat <base>...HEAD\`, \`git diff <base>...HEAD\`, and \`git log --oneline <base>..HEAD\`. If the base is unavailable, report that limitation rather than fetching without authorization.
- 2. Structured PR Description:
   * Summary: 1-3 bullet points of what changed and why.
   * Review Checklist: Specific files and critical functions reviewers should scrutinize.
   * Verification Evidence: Exact commands executed (e.g. tests, build) and exit codes.
   * Risk Assessment: Potential regression blast radius and mitigations.
- 3. Safety Gate: NEVER run git push --force. Push only when the user explicitly requests it; preparing or reviewing a PR does not authorize pushing. The run-time approval prompt is the only confirmation; do not ask again in prose.
- Creating or updating a PR requires a matching user request and an available PR tool/CLI. Review title, base/head branches, and description before submission; report the actual PR URL only after creation succeeds. A review-only request authorizes inspection and findings.`,

  gitSync: `[GIT WORKFLOW - REMOTE SYNCHRONIZATION]
- Execute only the requested fetch, pull, or push and its authorized remote/ref scope. Inspect \`git status --short --branch\`, \`git branch -vv\`, and the configured remote first; do not expose credentials embedded in remote URLs.
- Fetch updates local remote-tracking refs; it requires a matching request or authorization as a necessary step of the requested synchronization. Do not fetch for unrelated read-only questions.
- Before pull, preserve local changes and identify upstream. Prefer \`git pull --ff-only <remote> <branch>\` when no integration strategy was requested. On divergence, report it; do not silently choose rebase, merge, reset, or autostash.
- Before push, inspect outgoing commits and confirm destination. Use an explicit remote/ref, e.g. \`git push <remote> HEAD:refs/heads/<branch>\`; set upstream only when appropriate to the requested publication. Never push all branches/tags or force push as a fallback.
- A rejected push is not permission to rewrite remote history. Report the rejection and requested next action. Confirm success from command output; report branch/remote without claiming publication succeeded after a failed command.`,

  gitImplement: `[GIT WORKFLOW - IMPLEMENTATION]
- Complete the requested code changes on the inspected working tree and authorized branch. Preserve unrelated and pre-existing edits. Branch/commit/push permission does not grant permission for unrelated code changes.
- Follow the implementation plan. Record actual successful edit results, then obtain successful relevant verification after the most recent edit; a test result from before that edit cannot complete this stage. If no changes are needed, report the evidence and the scope adjustment needed rather than making an artificial edit to advance the workflow.
- Do not stage, commit, sync, or publish a PR while the current implementation is incomplete. Report failed verification or missing evidence and remain in this stage. This guidance is advisory; the run-time Git policy still decides whether a command runs.`,

  gitIntegrate: `[GIT WORKFLOW - INTEGRATION & CONFLICTS]
- Merge, rebase, and cherry-pick only when requested, using the specified refs and strategy. Inspect status, starting HEAD, target history, and existing merge/rebase state first. Preserve user changes; do not start another integration while one is active.
- For conflicts, inspect \`git diff --name-only --diff-filter=U\` and each conflicted file. Resolve according to the requested behavior and both sides' intent; do not blanket-select ours/theirs. Stage only resolved authorized paths and check that conflict markers are removed.
- Continue an active merge/rebase/cherry-pick only when resolving/completing that operation is authorized. Respect hooks and repository verification requirements; report verification actually performed.
- Abort only the operation the user authorized aborting. Do not reset --hard, clean files, auto-stash, or rewrite shared history to escape conflicts. If the intended resolution is ambiguous, report the concrete conflicting alternatives.
- Inspect final history/status and summarize resulting commits, unresolved conflicts, and preserved user changes. Local integration does not authorize pushing.`,

  gitRollback: `[GIT WORKFLOW - SAFE ROLLBACK & STASH]
- Only perform the undo/stash operation and paths the user requested. Inspect status and diff first; restore/checkout can discard uncommitted work, so preserve unrelated and pre-existing user edits. Prefer reversing only your own edits when they share a file with user work.
- Use \`run_command "git restore <path>"\` only when discarding all unstaged changes in that path is authorized. Stash only authorized paths; applying/popping a stash also requires a matching request. Tool failures alone never authorize rollback or stash.
- To unstage only requested paths, use \`git restore --staged -- <path>\`; this retains working-tree content. For a committed change, prefer \`git revert <hash>\` when the user requests a new undo commit rather than rewriting history. Confirm the exact commit and handle conflicts within the authorized scope.
- Inspect \`git stash list\`/\`git stash show\` before selecting a stash. Prefer apply when recovery should retain the stash; drop/pop only when requested. Keep unrelated untracked files; do not add -u/-a implicitly.
- Safety Gate: NEVER execute destructive \`git reset --hard\` without explicit user authorization. Never run git clean, discard paths, or delete a stash as an automatic repair. Inspect final status and report exactly what was restored, reverted, unstaged, or retained.`,
} as const;

export type GitWorkflowPromptId = keyof typeof GIT_WORKFLOW_PROMPTS;
