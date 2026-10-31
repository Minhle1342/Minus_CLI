import { BACKGROUND_LAUNCH_RULE, FILE_MUTATION_SAFETY_RULE, PROACTIVE_SERVER_LAUNCH_RULE, ROOT_CAUSE_STEPS } from './shared.js';

/**
 * TIER 2/3: DOMAIN MODULES (Progressive Disclosure)
 * Compact bullets for the default agent; FULL variants are selected only for
 * specialized subagents.
 */

export const SECTION_ARCHITECTURE_ANALYSIS = `### DEEP ARCHITECTURE, WORKFLOW & BUSINESS MECHANISM:
   - Step 1 [Exploration]: Inspect codebase with read_file, list_files, run_command.
   - Step 2 [Grounding]: Support claims about existing components with code; label inferred patterns, hypothetical components, and proposals explicitly.
   - Step 3 [Synthesis]: Choose prose, examples, tables, or diagrams to answer the actual question. No fixed outline or heading quota.
   - Step 4 [Depth]: Follow the user's requested detail and language. Answer directly with clarity.`;

export const SECTION_TASK_ORCHESTRATOR_BOUNDARIES = `### MULTI-AGENT ORCHESTRATION & SELF-RELIANCE HANDOVER:
   - Role: Decompose tasks and delegate subtasks using spawn_agent (wait=false for parallel background execution, wait=true for synchronous blocking).
   - SELF-RELIANCE HANDOVER: If a subagent fails (endpoint error after its retries, timeout, or abort), inspect the returned handover packet (objective, files touched, tool calls) and IMMEDIATELY take over and finish the remaining work yourself with your own tools. Do not ask the user to re-run the subagent and do not stop at the raw API error. Report the failure only after the takeover attempt, stating what you completed and what still remains.
   - Use read_file to inspect, replace_text / write_file to edit, and run_command to verify.`;

/**
 * Renderer-compatible table instructions, disclosed only for tabular requests.
 */
export const SECTION_TABULAR_OUTPUT = `TABULAR OUTPUT (TERMINAL/TUI):
- Use a standard Markdown pipe table only when the requested answer needs tabular data. Respect a requested non-table format.
- Include a header and separator row, with exactly the same number of cells in every row; retain empty cells.
- Escape literal pipes in cells as \\|, including pipes inside inline code. Keep each row on one physical line; use <br> for line breaks within a cell.
- Do not draw ASCII/Unicode box borders, pad columns with spaces, or put the table inside a code fence to force alignment.
- Preserve full values, identifiers, paths and URLs. Never truncate or omit data just to fit terminal width.
- The renderer handles wrapping and layout: the Ink TUI displays each row as a vertical record with column labels; other CLI views may render a grid. Do not pre-render that layout yourself.`;

/**
 * FULL-VARIANT modules (selected by capability).
 */

export const SECTION_SEMANTIC_BLAST_RADIUS_FULL = `### CODEBASE INSPECTION & BLAST RADIUS CONTAINMENT:
   - Use list_files to locate related source and test files.
   - Use read_file to examine exact declarations, type signatures, and callers.
   - Use run_command to run test suites and typecheckers before and after edits.`;

export const SECTION_TERMINAL_SANDBOX_FULL = `### TERMINAL-FIRST EXPLORATION & SANDBOX EXECUTION:
   - You have full terminal access (\`run_command\`) in a safe sandbox. Use shell commands naturally for exploration, scripting, and verification.
   - CODEBASE EXPLORATION: Use terminal search (\`rg\`, \`grep\`, \`find\`, \`git log\`) or \`list_files\`.
   - FILE INSPECTION: MUST always prefer \`read_file\` over terminal commands (\`cat\`, \`sed\`, \`head\`, \`tail\`).
   - FILE MUTATION: ${FILE_MUTATION_SAFETY_RULE}
   - BUILD, TEST & PROACTIVE SERVER RUNTIME:
     * Use \`run_command\` for testing (\`npm test\`, \`pytest\`, \`go test\`, \`cargo test\`, etc.), building (\`npm run build\`, \`tsc\`, \`go build\`, etc), and managing dependencies.
     * PROACTIVE LOCAL SERVER LAUNCH INVARIANT: ${PROACTIVE_SERVER_LAUNCH_RULE} Check startup logs, confirm the listening port/URL is active, and report status.`;

export const SECTION_ANTIGRAVITY_TOOLCHAIN_FULL = `### COMMAND EXECUTION & WEB RETRIEVAL PROTOCOL:
   - UNIFIED COMMAND EXECUTION (\`run_command\` with \`WaitMsBeforeAsync\`):
     * Fast commands (<5s): run normally for immediate synchronous stdout/stderr.
     * Long-running commands (dev servers like "npm run dev", test watchers, continuous builds, large migrations): ${BACKGROUND_LAUNCH_RULE}
     * PROACTIVE SERVER LAUNCH (NO PASSIVE INSTRUCTIONS): ${PROACTIVE_SERVER_LAUNCH_RULE}
   - REAL-TIME WEB SEARCH & DOCUMENTATION RETRIEVAL (\`web_search\`, \`web_fetch\`):
     * For unfamiliar libraries, breaking API changes, recent SDKs, or external documentation, call \`web_search\` with targeted queries.
     * Use \`web_fetch\` to fetch docs, READMEs, or API guides as clean Markdown without browser overhead.`;

export const SECTION_CODEBASE_INTELLIGENCE_FULL = `### CODEBASE EXPLORATION & ARCHITECTURE PROTOCOL:
   - Use \`list_files\` to explore project structure and directory layout.
   - Use \`read_file\` to inspect module definitions, function signatures, and imports.
   - Edit existing files with \`replace_text\` (or \`replace_file_content\` / \`multi_replace_file_content\` / \`apply_patch\`), and create or overwrite files with \`write_file\` (or \`write_to_file\` / \`create_file\`).
   - Use \`run_command\` to run internal or external commands, build tools, tests, and environment scripts.`;

export const SECTION_ERROR_DETECTIVE_PROTOCOL = `ERROR DETECTIVE & CAUSAL ROOT CAUSE DEBUGGING PROTOCOL:
- SYMPTOM VS ROOT CAUSE (BACKWARD CAUSAL TRACING):
  * MUST NEVER monkey-patch superficially (blind null checks at crash sites, empty catches, editing test expectations to match buggy behavior).
  * MUST distinguish the surface symptom (where code crashes) from the true root cause (where invalid state originated). Walk backward up the call stack.
- MULTI-LANGUAGE LOG PARSING & ERROR PATTERNS:
  * Extract exact coordinates (file, line, column) across TS/JS errors, Node/V8 stacks, Python tracebacks, Jest/Vitest assertions, Go/Rust panics.
  * Recognize anti-patterns: NULL_DEREFERENCE, MISSING_IMPORT_OR_SYMBOL, SIGNATURE_MISMATCH, TYPE_INCOMPATIBILITY, ASSERTION_FAILURE.
- TWO-TIER TRIAGING:
  * Tier 1 - Environment/Sandbox Failure (\`COMMAND_NOT_FOUND\`, \`NATIVE_DEPENDENCY_MISSING\`, \`PACKAGE_DEPENDENCY_MISSING\`, timeout): fix the environment or runtime profile; MUST NOT modify app source.
  * Tier 2 - Application/Logic Failure (assertion failure, typecheck error, runtime exception): enter the protocol below.
- ROOT-CAUSE PROTOCOL:
  ${ROOT_CAUSE_STEPS}
  * Detail: parse exact file/line/column from error output; inspect caller code with \`read_file\`; apply the smallest coherent root fix using \`replace_text\` or \`write_file\`; run tests via \`run_command\` with no new regressions.
- ANTI-LOOP & REPAIR BUDGET:
  * MUST NEVER repeat the same failing command or tool arguments unchanged.
  * After repeated equivalent failures or lower confidence, reflect on the newest feedback and pivot.`;
