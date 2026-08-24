/**
 * Architecture & System Engineering Playbooks for AI Coding Agents
 * 
 * Standards synthesized from OpenAI Codex CLI, Anthropic Computer Use, Manus,
 * and Domain-Driven Design / Clean Architecture engineering principles.
 */

export const BUILTIN_ARCHITECTURE_PLAYBOOKS: Record<string, string> = {
  'system-architect': `### ARCHITECTURAL ENGINEERING PROTOCOL (SYSTEM-ARCHITECT)
1. **Clean Architecture & Strict Boundary Separation:**
   - **Domain Core:** Pure business entities, domain types, and value objects with ZERO dependencies on frameworks, databases, or UI.
   - **Application Layer:** Use cases, commands, queries, interactors, and DTOs that orchestrate business workflows.
   - **Infrastructure Layer:** Adapters, persistence drivers, network clients, file system access, and external SDKs.
   - **Presentation/Interface Layer:** CLI commands, controllers, views, event dispatchers.
   - *Dependency Rule:* Dependencies point INWARD only (Infrastructure -> Application -> Domain).

2. **SOLID & Inversion of Control (IoC/DI):**
   - High-level orchestrators must depend on interfaces/abstractions, never direct concrete implementations.
   - Design modules for extension without modification (Open/Closed) via strategy, factory, or plugin registries.
   - Single Responsibility: Each class/service owns one cohesive reason to change.

3. **Blast Radius & Contract Preservation:**
   - Before mutating exported functions, interfaces, or types, inspect all call-sites with \`find_references\` and \`analyze_impact\`.
   - Prefer additive, backward-compatible evolutionary extensions over breaking API mutations.
   - Mark deprecated symbols with clear migration paths before removing them.

4. **Resilience & State Management Invariants:**
   - Enforce immutability for state snapshots and event logs.
   - Guard against race conditions and concurrent mutation conflicts with optimistic locking (\`contentHash\`, ETags, version counters).
   - Implement graceful error recovery, circuit breakers, and bounded resource limits.`,

  'api-design': `### SCALABLE API & PROTOCOL DESIGN PROTOCOL (API-DESIGN)
1. **Strict Contract Validation & Zero-Trust Boundaries:**
   - Validate 100% of external inputs at the boundary using schema validators (Zod, Pydantic, JSON Schema).
   - Never trust raw user/client payload shapes inside business logic services.

2. **Standardized Response Envelopes & Error Contracts:**
   - Success: \`{ "success": true, "data": ..., "meta": { "timestamp": ..., "version": ... } }\`
   - Failure: \`{ "success": false, "error": { "code": "INVALID_ARGUMENT", "message": "...", "details": [...] } }\`
   - Use standard semantic HTTP status codes (200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500).

3. **Idempotency & Safe Network Replays:**
   - State-altering operations (POST/PATCH) should support idempotency keys (\`Idempotency-Key\` / mutation ID) to handle network timeouts safely without duplicate side-effects.

4. **Pagination & Query Efficiency:**
   - Prefer cursor-based pagination (\`limit\`, \`cursor\`, \`hasMore\`, \`nextCursor\`) over offset pagination for scalable datasets.
   - Implement clear sorting and filtering contracts with explicit allowlists of filterable fields.`,

  'backend-patterns': `### PRODUCTION BACKEND & DATA ENGINEERING PROTOCOL (BACKEND-PATTERNS)
1. **Data Modeling & Storage Boundaries:**
   - Define clear transaction boundaries and unit-of-work scopes to ensure ACID consistency.
   - Indexing discipline: Align B-Tree indexes with high-frequency query predicates and equality/range filters.
   - Guard against N+1 query patterns by using batch loaders, eager joining, or DataLoader patterns.

2. **Asynchronous Processing & Worker Queues:**
   - Offload heavy, I/O-intensive, or long-running tasks to background job queues / worker pipelines.
   - Ensure background tasks are idempotent and handle at-least-once message delivery with dead-letter queue (DLQ) support.
   - Use exponential backoff with randomized jitter for external service retries.

3. **Caching Strategy & KV-State Discipline:**
   - Use Cache-Aside pattern with deterministic TTLs and immediate cache invalidation on write.
   - Keep static invariant structures separated from dynamic parameters to maximize KV-cache reuse.

4. **Observability & Health Telemetry:**
   - Log in structured JSON format with distributed correlation IDs (\`traceId\`, \`requestId\`, \`sessionId\`).
   - Provide explicit health check endpoints (\`/healthz\` liveness, \`/readyz\` readiness).`,

  'design-patterns': `### PRAGMATIC DESIGN PATTERNS & ANTI-OVER-ENGINEERING PROTOCOL (DESIGN-PATTERNS)
1. **MANDATORY ANTI-OVER-ENGINEERING GUARDRAILS (FIRST PRINCIPLES):**
   - **KISS & YAGNI Compliance:** NEVER introduce a pattern for trivial or single-use logic. If a simple function or 15-line procedural code is readable, DO NOT construct factories, interfaces, or abstract classes.
   - **Rule of Three:** Apply creational/behavioral patterns (Strategy, Factory, Visitor) ONLY when there are >= 3 distinct concrete variations or proven dynamic extension points.
   - **Composition Over Inheritance:** Prefer object composition, small focused interfaces, and functional pipelines over class inheritance hierarchies (max inheritance depth <= 2).
   - **Zero Speculative Generality:** DO NOT build complex generic abstractions for hypothetical future requirements. Solve the concrete problem at hand with minimal moving parts.

2. **TACTICAL PATTERN SELECTION CATALOG:**
   - **Strategy Pattern:** Replace unwieldy, high-cyclomatic \`switch-case\` or \`if-else\` clusters with interchangeable strategy objects/functions.
   - **Factory / Registry Pattern:** Use for dynamic plugin, tool, or provider resolution via clean Map lookup rather than hardcoded instantiation.
   - **Adapter / Facade Pattern:** Wrap external SDKs, OS binaries, or third-party APIs behind a clean, domain-specific contract to prevent foreign API leakage.
   - **Builder Pattern:** Use when constructing complex configurations with > 4 optional properties or validation invariants.
   - **Decorator / Middleware Pipeline:** Layer cross-cutting concerns (telemetry, caching, auth, error recovery) without mutating core business methods.
   - **Observer / Event Emitter:** Decouple event producers from side-effect consumers (logging, UI updates, metric collection).
   - **Chain of Responsibility:** Sequence discrete validation or verification checkpoints (e.g. Guard rails, Critic gates).

3. **POST-REFACTOR SIMPLICITY CRITIQUE:**
   - After implementing a pattern, ask: "Did this make the code easier to understand and test, or did it just add boilerplate classes?"
   - If complexity or indirection increased without tangible benefit, immediately refactor back to simpler primitives.`,

  'writing-plans': `### IMPLEMENTATION PLANNING & ATOMIC DECOMPOSITION PROTOCOL (WRITING-PLANS)
1. **Scope & Architectural Foundations (Before Touching Code):**
   - Define the primary objective in one sentence, followed by architectural constraints, affected modules, and tech stack.
   - Inspect existing files, interfaces, and dependencies with \`read_file\` / \`search_text\` before proposing any structural changes.
   - Maintain strict non-destructive changes and backward compatibility.

2. **Bite-Sized Atomic Task Granularity (2-5 Minute Execution Steps):**
   - Break down complex requirements into discrete, sequential, testable units of work.
   - For every task in the plan, specify:
     * **Exact Target Files:** Full paths and relevant line ranges (e.g. \`src/services/auth.ts:45-80\`).
     * **Concrete Code Specifications:** Precise functions, type signatures, and logic to modify or create (never use vague placeholders like "implement logic here").
     * **Verification Step:** Exact test/build command (e.g. \`npm test -- tests/auth.test.ts\` or \`npx tsc --noEmit\`) and expected passing criteria.
     * **Commit Point:** Atomic commit message describing the incremental change.

3. **Verification Ladder Enforcement (TDD Red-Green-Refactor):**
   - Step 1: Write or isolate the failing test / diagnostic reproduction.
   - Step 2: Run verification to confirm the expected failure mode.
   - Step 3: Implement minimal surgical solution to make test pass.
   - Step 4: Run static typecheck / unit tests to confirm green status.
   - Step 5: Cleanly refactor without adding speculative complexity.

4. **Execution Handoff:**
   - Present the comprehensive, phased implementation plan directly to the user in their preferred natural language.
   - Use the plan as a guiding contract throughout execution.`,

  'planning-with-files': `### PERSISTENT STATE & WORKING MEMORY ON DISK PROTOCOL (PLANNING-WITH-FILES)
1. **The Core Invariant: Disk is Infinite, Context Window is Volatile:**
   - LLM context window degrades over long, multi-turn interactions ("context rot").
   - Persist critical architectural decisions, task roadmaps, and findings directly to markdown files in the workspace.

2. **The 3-File Working Memory Architecture:**
   - \`task_plan.md\`: Tracks project phases, active milestones, remaining items, and decisions.
   - \`findings.md\`: Records technical discoveries, research insights, API contracts, and schema shapes.
   - \`progress.md\`: Logs session audit trail, test results, and modified file registers.

3. **The 2-Action Rule:**
   - After every 2 search, inspection, or research operations, immediately summarize key discoveries into notes or plan files to avoid lost context.
   - Re-read the plan file before major decisions to keep overall goals in sharp focus.

4. **3-Strike Error Protocol:**
   - Attempt 1: Diagnose root cause from stderr/diagnostics and apply surgical fix.
   - Attempt 2: If the error persists, pivot to an alternative method or library. NEVER repeat the exact same failed tool arguments.
   - Attempt 3: Re-evaluate fundamental assumptions, review plan, or ask user for strategic guidance.`,

  'concise-planning': `### RAPID CHECKLIST & AGILE TASK PLANNING PROTOCOL (CONCISE-PLANNING)
1. **Actionable Atomic Checklist:**
   - Structure plans as clear markdown task lists with checkboxes (\`- [ ]\` and \`- [x]\`).
   - Group tasks by logical phases (e.g. Phase 1: Investigation, Phase 2: Core Implementation, Phase 3: Verification & Integration).

2. **Zero Overhead & Rapid Iteration:**
   - Focus on what needs to be done, which files need edits, and how to verify.
   - Eliminate fluff, boilerplate text, and unnecessary ceremony. Keep steps concise, sharp, and directly executable.`,
};
