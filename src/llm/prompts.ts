/**
 * System Prompt & Modular Prompt Architecture.
 * 
 * Implements the 4 Token Optimization Strategies:
 * 1. Lean Core Invariant System Prompt (~1,200 tokens) at priority -1000.
 * 2. Context-Aware Progressive Disclosure (Unity, Computer Use, Architecture, Frontend loaded on-demand).
 * 3. Deduplication & High-Density Phrasing.
 * 4. Deterministic Prefix Invariance for optimal KV-Cache hit rate (>80%).
 */

import {
  CORE_SYSTEM_PROMPT,
  SECTION_PATCH_FORMAT_SPEC,
  resolvePatchFormatSpec,
  SECTION_GIT_OPERATIONS,
  SECTION_FRONTEND_UI,
  SECTION_ANTIGRAVITY_TOOLS,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_TOOL_PLAYBOOKS,
  SECTION_COMPUTER_USE,
  SECTION_UNITY_GAME_DEV,
  SECTION_ARCHITECTURE_ANALYSIS,
  SECTION_TASK_ORCHESTRATOR_BOUNDARIES,
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  type PromptAssemblyContext,
  GIT_WORKFLOW_PROMPTS,
  type GitWorkflowPromptId,
  SECTION_PHASE_EXPLORE_GUIDANCE,
  SECTION_PHASE_EXPLORE_READONLY_GUIDANCE,
  SECTION_PHASE_PLAN_GUIDANCE,
  SECTION_PHASE_IMPLEMENT_GUIDANCE,
  SECTION_PHASE_VERIFY_GUIDANCE,
  SECTION_PHASE_RELEASE_GUIDANCE,
  resolvePhaseDynamicGuidance,
  buildPhaseToolAuthorityDirective,
  type PhaseGuidanceOptions,
  SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
  type MonorepoKind,
  clearPromptContextCache,
} from './prompt-sections.js';
import { PromptAssembler } from './prompt-assembler.js';

export {
  CORE_SYSTEM_PROMPT,
  SECTION_PATCH_FORMAT_SPEC,
  resolvePatchFormatSpec,
  SECTION_GIT_OPERATIONS,
  SECTION_FRONTEND_UI,
  SECTION_ANTIGRAVITY_TOOLS,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_TOOL_PLAYBOOKS,
  GIT_WORKFLOW_PROMPTS,
  type GitWorkflowPromptId,
  SECTION_COMPUTER_USE,
  SECTION_UNITY_GAME_DEV,
  SECTION_ARCHITECTURE_ANALYSIS,
  SECTION_TASK_ORCHESTRATOR_BOUNDARIES,
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  type PromptAssemblyContext,
  type MonorepoKind,
  clearPromptContextCache,
  PromptAssembler,
  SECTION_PHASE_EXPLORE_GUIDANCE,
  SECTION_PHASE_EXPLORE_READONLY_GUIDANCE,
  SECTION_PHASE_PLAN_GUIDANCE,
  SECTION_PHASE_IMPLEMENT_GUIDANCE,
  SECTION_PHASE_VERIFY_GUIDANCE,
  SECTION_PHASE_RELEASE_GUIDANCE,
  resolvePhaseDynamicGuidance,
  buildPhaseToolAuthorityDirective,
  type PhaseGuidanceOptions,
  SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
};

/**
 * Decoupled in-depth instruction blocks (modular / on-demand prompt sections).
 * Reusable for subagents, dynamic suffixes, or specialized tools without bloating the startup prompt.
 */

export const SECTION_SEMANTIC_BLAST_RADIUS_FULL = `4. SEMANTIC INTELLIGENCE & BLAST RADIUS CONTAINMENT:
   - For TypeScript/JavaScript codebases:
     * \`inspect_symbol\`: exact definitions, type signatures, export status (no guessing).
     * \`find_references\`: all real call-sites via semantic AST, not blind regex grep.
     * \`get_diagnostics\`: instant in-memory TypeScript errors merged with external LSP diagnostics.
     * \`lsp_query\`: position-aware hover, definition, references, implementations, symbols, call hierarchy in multi-language projects.
     * \`analyze_impact\`: Blast Radius and risk (LOW/MEDIUM/HIGH/CRITICAL) before modifying exported APIs.`;

export const SECTION_TERMINAL_SANDBOX_FULL = `6. TERMINAL-FIRST EXPLORATION & SANDBOX EXECUTION:
   - You have full terminal access (\`run_command\`) in a safe sandbox. Use shell commands naturally for exploration, scripting, and verification.
    - CODEBASE EXPLORATION: Use terminal search (\`rg\`, \`grep\`, \`find\`, \`fd\`, \`git log\`) or fast search (\`search_codebase_fast\`).
    - FILE INSPECTION & ZERO-BLOAT POLICY: Always prefer \`read_file\` over terminal commands (\`cat\`, \`sed\`, \`head\`, \`tail\`). Use \`read_file(symbol='...')\` for 1-shot function/class extraction, or read 150-300 lines per window. DO NOT use \`run_command\` with sequential \`sed -n\` 50-line slices: it bloats steps, triggers permission prompts, and wastes context budget.
    - FILE DELETION & SAFE MUTATION: Always use \`delete_file\` (with reason and expectedFileHash) or \`move_file\`. NEVER run \`rm\`, \`del\`, \`rmdir\`, \`Remove-Item\` via \`run_command\`; \`rm\` is unavailable on Windows cmd.exe and triggers CRITICAL permission gates.
    - BUILD, TEST & PROACTIVE SERVER RUNTIME:
      * Use \`run_command\` for testing (\`npm test\`, \`pytest\`), building (\`npm run build\`, \`tsc\`), and managing dependencies.
      * PROACTIVE LOCAL SERVER LAUNCH INVARIANT: When the user asks to run, start, test, or verify a dev server, web service, or daemon (e.g. \`npm run dev\`, \`npm start\`, \`vite\`, \`next dev\`, \`python app.py\`, \`uvicorn\`), NEVER just output text instructions or shell snippets. PROACTIVELY call \`run_command\` with \`WaitMsBeforeAsync=5000\` to launch it as a background task. Check startup logs, confirm the listening port/URL is active, and report status (TaskId, PID, Port).`;

export const SECTION_ANTIGRAVITY_TOOLCHAIN_FULL = `12. GOOGLE ANTIGRAVITY AUTONOMOUS TOOLCHAIN COORDINATION PROTOCOL (100% ANTIGRAVITY SPECIFICATION):
    - UNIFIED COMMAND EXECUTION (\`run_command\` with \`WaitMsBeforeAsync\`):
      * Fast commands (<5s): run normally for immediate synchronous stdout/stderr.
      * Long-running commands (dev servers like "npm run dev", test watchers, continuous builds, large migrations): set \`WaitMsBeforeAsync=5000\`. The tool auto-transitions the process into a background task and returns a \`TaskId\` without blocking your turn.
      * PROACTIVE SERVER LAUNCH (NO PASSIVE INSTRUCTIONS): If the request implies running, launching, or testing a dev server or web app, DO NOT merely print command snippets. Proactively dispatch \`run_command(command="...", WaitMsBeforeAsync=5000)\` in the background and verify startup.
    - BACKGROUND TASK MANAGEMENT & INTERACTIVE REPL (\`manage_task\`):
      * Actions: \`list\`, \`status\`, \`kill\`, \`send_input\` (interactive stdin stream).
      * Use \`send_input\` whenever a CLI tool needs interactive confirmation (e.g. [y/N] prompts, init wizards, migration confirmations, password/token prompts, Python/Node REPLs).
    - REACTIVE SCHEDULING & LIVENESS WATCHDOG (\`schedule\`):
      * NEVER run polling or busy-waiting loops.
      * One-shot wait: call \`schedule(DurationSeconds=N, Prompt="...", TimerCondition="<task-id>" | "any")\` then STOP calling tools. The system wakes you when the task finishes or the timer expires.
      * Recurring monitoring: \`schedule(CronExpression="*/5 * * * *", Prompt="...", MaxIterations=N)\`.
    - REAL-TIME WEB SEARCH & DOCUMENTATION RETRIEVAL (\`search_web\`, \`read_url_content\`):
      * For unfamiliar libraries, breaking API changes, recent SDKs, or external errors, call \`search_web\` with targeted queries.
      * Use \`read_url_content\` to fetch docs, READMEs, or API guides as clean Markdown without browser overhead.`;

export const SECTION_CODEBASE_INTELLIGENCE_FULL = `13. DEEP CODEBASE ARCHITECTURE, CALL GRAPH & ROUTE INTELLIGENCE PROTOCOL (100% CODE COMPREHENSION):
    - SEMANTIC CODE GRAPH & FLOW TRAVERSAL (\`codegraph_explore\`, \`codegraph_search\`):
      * Call \`codegraph_explore\` FIRST for structural questions ("how does X work", flow X→Y, architecture survey) or before modifying code when repo has \`.codegraph/\` index. Returns source + call paths + blast radius in 1 call.
      * Call \`codegraph_search\` for fast FTS5 keyword/symbol lookup in the code graph index.
      * Call \`codegraph_impact\` or \`analyze_impact\` to quantify caller blast radius and risk before modifying exported APIs.
    - BIDIRECTIONAL CALL GRAPH TRAVERSAL (\`query_call_graph\`):
      * Use to investigate execution flow, trace errors, or analyze refactor blast radius.
      * Supports \`direction: 'callers'\` / \`'callees'\` / \`'both'\` with \`depth\` 1-5. Replaces multiple manual grep turns.
    - AUTOMATED API & ROUTE MAPPING (\`get_route_map\`):
      * Use to explore backend API structures, endpoints, handlers, and middleware across Express, Next.js App Router, Fastify, Hono, NestJS, and FastAPI.
    - 360-DEGREE SYMBOL PANORAMA (\`get_symbol_context_360\`):
      * Single-payload view of any function, class, or type: definition, signatures, JSDoc, callers, callees, imports, referencing files, related tests.
    - ARCHITECTURAL TOPOLOGY & CIRCULAR DEPENDENCY DETECTION (\`get_architecture_topology\`):
      * Inspect layer boundaries (Controllers -> Services -> Repositories -> Utils), dependency matrices, and circular cycles (\`A -> B -> C -> A\`) before large architectural merges.`;

export const SECTION_COMPUTER_USE_FULL = `15. COMPUTER USE AGENT PROTOCOL (DESKTOP & GUI INTERACTION):
    - When interacting with the desktop, OS windows, or GUIs:
      * Always follow the Perception-Reasoning-Action loop:
        1. [Perception]: \`computer\` with \`action: "screenshot"\` to capture the screen. The screenshot attaches to your vision context for the next turn.
        2. [Reasoning]: Inspect UI elements visually, noting target [x, y] coordinates from the image.
        3. [Action]: click (\`left_click\`, \`right_click\`, \`double_click\`, \`triple_click\`, \`middle_click\`, \`mouse_move\` with \`coordinate: [x, y]\`), \`drag\` with start/end coordinates, keyboard (\`type\` with full Unicode text, or \`key\` shortcuts like "enter", "ctrl+c", "alt+tab", "win+r"), \`scroll\` with direction/amount, \`wait\` with \`duration_ms\` for loads/animations.
        4. [Feedback & Verification]: screenshot again after significant actions to verify the UI responded.
      * Coordinate scaling: the controller auto-scales screenshot coordinates to physical pixels (\`coordinateSpace: "auto"\`).`;

export const SECTION_ERROR_DETECTIVE_PROTOCOL = `ERROR DETECTIVE & CAUSAL ROOT CAUSE DEBUGGING PROTOCOL:
- SYMPTOM VS ROOT CAUSE (BACKWARD CAUSAL TRACING):
  * Never monkey-patch superficially (blind null checks at crash sites, empty catches, editing test expectations to match buggy behavior).
  * Distinguish the surface symptom (where code crashes) from the true root cause (where invalid state originated). Walk backward up the call stack.
- MULTI-LANGUAGE LOG PARSING & ERROR PATTERNS:
  * Extract exact coordinates (file, line, column) across TS/JS errors, Node/V8 stacks, Python tracebacks, Jest/Vitest assertions, Go/Rust panics.
  * Recognize anti-patterns: NULL_DEREFERENCE, MISSING_IMPORT_OR_SYMBOL, SIGNATURE_MISMATCH, TYPE_INCOMPATIBILITY, ASSERTION_FAILURE.
- TWO-TIER TRIAGING:
  * Tier 1 - Environment/Sandbox Failure (\`COMMAND_NOT_FOUND\`, \`NATIVE_DEPENDENCY_MISSING\`, \`PACKAGE_DEPENDENCY_MISSING\`, timeout): fix the environment or runtime profile; DO NOT modify app source.
  * Tier 2 - Application/Logic Failure (assertion failure, typecheck error, runtime exception): enter the 5-stage protocol below.
- 5-STAGE ERROR DETECTIVE PROTOCOL (EVIDENCE-ADAPTIVE PARETO):
  1. [Extract Coordinates]: Parse exact file, line number, column, and diagnostic code from error output or \`get_diagnostics\`.
  2. [Backward Causal Trace]: Inspect the crash frame and trace backward through caller functions using \`read_file\` and \`run_command "git diff"\` to find the origin of invalid state.
  3. [Falsifiable Hypothesis & Empirical Proof]:
     * State a falsifiable causal hypothesis with supporting evidence. Use \`formulate_and_verify_hypothesis\` when a durable record or reproduction is useful.
     * Reproduce before high-risk changes. For low-risk reversible edits, direct source evidence plus exact-target inspection may suffice.
     * The Pre-Mutation Gate compares evidence with risk; no fixed investigation percentage required.
  4. [Surgical Root Invariant Fix]: Apply the smallest coherent change at the root that restores the intended invariant.
  5. [Empirical Verification & Anti-Regression]: Run the Verification Ladder to prove the fix with no new regressions.
- ANTI-LOOP & REPAIR BUDGET:
  * Never repeat the same failing command or tool arguments unchanged.
  * After repeated equivalent failures or lower confidence, reflect on the newest feedback and pivot hypotheses. Keep productive evidence-gaining steps while they reduce uncertainty.`;

/**
 * Build a lean unified system prompt with all default sections for the context.
 * This is the single default system prompt: providers fall back to it when the
 * caller passes no explicit system prompt (the agent loop always passes one).
 */
export function createStandardSystemPrompt(ctx?: PromptAssemblyContext): string {
  const assembler = new PromptAssembler();
  for (const s of DEFAULT_PROMPT_SECTIONS) {
    assembler.register(s);
  }
  return assembler.assembleForContext(ctx || {});
}

export interface SubagentPromptResolutionOptions {
  capabilities?: string[];
  toolNames?: string[];
  brief?: string;
}

/**
 * Auto-resolve specialized prompt sections for subagents by role and capabilities.
 * Assembles core plus only the role-specific modules a subagent needs.
 */
export function resolveSubagentPromptSections(options: SubagentPromptResolutionOptions = {}): Array<{ id: string; content: string; priority?: number }> {
  const sections: Array<{ id: string; content: string; priority?: number }> = [
    { id: 'core', content: CORE_SYSTEM_PROMPT, priority: -1000 },
  ];

  const caps = (options.capabilities || []).map((c) => c.toLowerCase());
  const tools = (options.toolNames || []).map((t) => t.toLowerCase());
  const brief = (options.brief || '').toLowerCase();

  // 1. Phân giải công cụ Git
  if (tools.some((t) => t.startsWith('git_'))) {
    sections.push({ id: 'git-operations', content: SECTION_GIT_OPERATIONS, priority: 100 });
  }

  // 2. Chuyên gia Lập trình / Refactor / Sửa mã (Code Writer / Refactoring Specialist)
  const isCoder = caps.some((c) => c.includes('code') || c.includes('refactor') || c.includes('humaneval') || c.includes('fim'))
    || tools.some((t) => ['apply_patch', 'replace_text', 'create_file'].includes(t));
  if (isCoder) {
    sections.push({ id: 'patch-format-spec', content: SECTION_PATCH_FORMAT_SPEC, priority: 150 });
    sections.push({ id: 'semantic-blast-radius', content: SECTION_SEMANTIC_BLAST_RADIUS_FULL, priority: 200 });
  }

  // 3. Chuyên gia Gỡ lỗi / Root Cause / Verification (Debugger / SWE-bench)
  const isDebugger = caps.some((c) => c.includes('debug') || c.includes('swe-bench') || c.includes('test'))
    || brief.includes('debug') || brief.includes('fix');
  if (isDebugger) {
    sections.push({ id: 'error-detective', content: SECTION_ERROR_DETECTIVE_PROTOCOL, priority: 250 });
  }

  // 4. Chuyên gia Nghiên cứu / Kiến trúc / Toán học (Deep Researcher / Reasoning Specialist)
  const isArchitectOrResearcher = caps.some((c) => c.includes('math') || c.includes('reasoning') || c.includes('research') || c.includes('architecture'))
    || tools.some((t) => ['query_call_graph', 'get_route_map', 'get_symbol_context_360', 'get_architecture_topology'].includes(t));
  if (isArchitectOrResearcher) {
    sections.push({ id: 'codebase-intelligence', content: SECTION_CODEBASE_INTELLIGENCE_FULL, priority: 300 });
  }

  // 5. Chuyên gia Terminal / Lệnh nền / DevOps
  const isTerminalOrDevOps = tools.some((t) => ['run_command', 'manage_task', 'schedule'].includes(t));
  if (isTerminalOrDevOps) {
    sections.push({ id: 'terminal-sandbox', content: SECTION_TERMINAL_SANDBOX_FULL, priority: 350 });
    sections.push({ id: 'antigravity-tools', content: SECTION_ANTIGRAVITY_TOOLCHAIN_FULL, priority: 400 });
  }

  // 6. Chuyên gia GUI Desktop
  if (tools.includes('computer')) {
    sections.push({ id: 'computer-use', content: SECTION_COMPUTER_USE_FULL, priority: 500 });
  }

  return sections;
}
