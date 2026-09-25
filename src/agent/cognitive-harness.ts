/**
 * CognitiveHarness - Ejentum-Inspired Pre-Execution Cognitive Scaffolding & Branch Pruner
 * 
 * Provides System 2 reasoning scaffolds before action execution:
 * 1. [Negative Gate]: Strict suppression vectors blocking shortcuts, test mocks, and fake passes.
 * 2. [Premise Check / Anti-Deception]: Challenges flawed user frames, authority pressure, and rushed requests.
 * 3. [Falsification Criteria]: Explicit criteria that would prove the current hypothesis wrong before modifying code.
 * 4. [Execution Topology]: Structured discipline (Premise -> Hypothesize -> Falsify -> Surgical Act -> Empirically Verify).
 * 5. [Cognitive Brake / Branch Pruner]: Dynamically detects blind alleys and prunes unproductive branches.
 */

export interface PremiseInversionDirective {
  isLeading: boolean;
  nullHypothesis: string;
  affirmativeHypothesis: string;
  counterfactualProbe: string;
}

export interface CognitiveScaffold {
  category: 'reasoning' | 'code' | 'anti_deception' | 'error_detective' | 'data_parser' | 'context_compression';
  phase?: string;
  negativeGate: string[];
  premiseCheck?: string;
  falsificationCriteria: string;
  executionTopology: string[];
  actionBoundary: string;
  premiseInversion?: PremiseInversionDirective;
}

export interface CognitiveBrakeDecision {
  active: boolean;
  reason?: string;
  prunedBranch?: string;
  recommendedPivot?: string;
}

export interface FileFixationEntry {
  consecutiveFailures: number;
  frozenUntilTurn: number;
  lastFailureReason?: string;
}

/**
 * Anti-Fixation Circuit Breaker (Pillar 3)
 * Tracks consecutive failed mutation/verification attempts on specific files.
 * If >= 2 consecutive failures occur on the same target file, freezes mutations
 * on that file for 1 turn to break tunnel vision and force upstream caller inspection.
 */
export function detectLeadingQuery(request: string): { isLeading: boolean } {
  const normalized = (request || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const leadingPatterns = [
    /\b(?:co phai|co dung la|co phai do|tai sao lai do)\b.{0,60}\b(?:khong|phai khong|dung khong)\b/i,
    /\b(?:xac nhan giup toi|dung khong|phai khong|chi can xac nhan rang)\b/i,
    /\b(?:is it true that|confirm for me that|prove that .* is wrong)\b/i,
  ];

  return { isLeading: leadingPatterns.some((p) => p.test(normalized)) };
}

export class FileFixationTracker {
  private fileFailures: Map<string, FileFixationEntry> = new Map();

  private normalizePath(p: string): string {
    return (p || '').trim().replace(/\\/g, '/').toLowerCase();
  }

  recordFailure(filePath: string, currentTurn: number, reason?: string): { frozen: boolean; message?: string } {
    const norm = this.normalizePath(filePath);
    if (!norm) return { frozen: false };
    const current = this.fileFailures.get(norm) || { consecutiveFailures: 0, frozenUntilTurn: 0 };
    current.consecutiveFailures += 1;
    current.lastFailureReason = reason;

    if (current.consecutiveFailures >= 2) {
      current.frozenUntilTurn = currentTurn + 1;
      this.fileFailures.set(norm, current);
      return {
        frozen: true,
        message: `ANTI_FIXATION_CIRCUIT_BREAKER: Target file '${filePath}' has failed verification ${current.consecutiveFailures} consecutive times. Mutations on this file are FROZEN for turn ${currentTurn} to break tunnel vision. Inspect upstream callers, configurations, or schemas before re-attempting modification.`,
      };
    }
    this.fileFailures.set(norm, current);
    return { frozen: false };
  }

  recordSuccess(filePath: string): void {
    const norm = this.normalizePath(filePath);
    if (norm) {
      this.fileFailures.delete(norm);
    }
  }

  isFrozen(filePath: string, currentTurn: number): { frozen: boolean; reason?: string } {
    const norm = this.normalizePath(filePath);
    if (!norm) return { frozen: false };
    const entry = this.fileFailures.get(norm);
    if (!entry) return { frozen: false };
    if (currentTurn <= entry.frozenUntilTurn) {
      return {
        frozen: true,
        reason: `ANTI_FIXATION_CIRCUIT_BREAKER: Target file '${filePath}' is currently FROZEN due to ${entry.consecutiveFailures} consecutive failed mutation/verification attempts. You MUST inspect upstream callers, dependencies, or schemas first before editing this file again.`,
      };
    }
    return { frozen: false };
  }

  getFailures(filePath: string): number {
    const norm = this.normalizePath(filePath);
    return this.fileFailures.get(norm)?.consecutiveFailures || 0;
  }

  reset(): void {
    this.fileFailures.clear();
  }
}

export class CognitiveHarness {
  readonly fileFixationTracker = new FileFixationTracker();
  private falsifiedHypothesesCount: number = 0;
  private lastBrakeReason?: string;

  /**
   * Generates a tailored cognitive scaffold based on prompt semantics and execution context
   */
  createScaffold(params: {
    request: string;
    phase?: string;
    activeTask?: string;
    consecutiveFailures?: number;
  }): CognitiveScaffold {
    const { request, phase = 'explore', activeTask = '', consecutiveFailures = 0 } = params;
    const lowerReq = request.toLowerCase();

    // 1. Detect Anti-Deception / Sycophancy Risk
    const isAntiDeception = (
      lowerReq.includes('just make it work')
      || lowerReq.includes('skip tests')
      || lowerReq.includes('ignore the test')
      || lowerReq.includes('bypass')
      || lowerReq.includes('trust me')
      || lowerReq.includes('don\'t worry about')
      || lowerReq.includes('quick fix')
      || lowerReq.includes('hardcode')
      || lowerReq.includes('asap')
      || lowerReq.includes('urgently')
      || lowerReq.includes('không cần tốn thời gian')
      || lowerReq.includes('không cần đọc file')
      || lowerReq.includes('không cần chạy')
      || lowerReq.includes('xác nhận giúp tôi')
      || lowerReq.includes('sycophancy')
      || lowerReq.includes('gấp để release')
    );

    const hasCodeFileExtension = /\.(ts|js|py|json|rs|go|cs|tsx|jsx|html|css)\b/i.test(request);
    const isCodingTask = (
      phase === 'implement'
      || phase === 'verify'
      || hasCodeFileExtension
      || lowerReq.includes('fix')
      || lowerReq.includes('implement')
      || lowerReq.includes('refactor')
      || lowerReq.includes('bug')
      || lowerReq.includes('error')
      || lowerReq.includes('code')
      || lowerReq.includes('add')
      || lowerReq.includes('update')
      || lowerReq.includes('delete')
      || lowerReq.includes('replace')
      || lowerReq.includes('sửa')
      || lowerReq.includes('sua')
      || lowerReq.includes('lỗi')
      || lowerReq.includes('loi')
      || lowerReq.includes('cập nhật')
      || lowerReq.includes('cap nhat')
      || lowerReq.includes('thay thế')
      || lowerReq.includes('thay the')
      || lowerReq.includes('bổ sung')
      || lowerReq.includes('bo sung')
      || lowerReq.includes('thực thi')
      || lowerReq.includes('thuc thi')
      || lowerReq.includes('hàm')
      || lowerReq.includes('function')
      || lowerReq.includes('method')
      || lowerReq.includes('class')
    );

    if (isAntiDeception) {
      return {
        category: 'anti_deception',
        phase,
        negativeGate: [
          'NEVER bypass failing tests, disable assertions, or delete test cases to claim completion.',
          'NEVER accept user assumptions uncritically if they compromise security, reliability, or architecture.',
          'NEVER apply superficial monkey-patches (e.g. empty catch, null-masking) that hide root causes.',
        ],
        premiseCheck: 'Validate whether the user frame or requested shortcut introduces architectural rot or masking of deeper defects.',
        falsificationCriteria: 'If skipping validation allows broken invariants to enter the codebase, this approach is fundamentally falsified.',
        executionTopology: [
          'Challenge Premise: Identify hidden risks in the requested shortcut.',
          'Formulate Root Cause: Identify why the proper fix is mandatory.',
          'Enforce Verification: Require empirical proof before accepting any change.',
        ],
        actionBoundary: 'Scope changes strictly to robust, verifiable solutions with zero compromises to integrity.',
      };
    }

    const isErrorDetective = (
      lowerReq.includes('error-detective')
      || lowerReq.includes('error_detective')
      || lowerReq.includes('error detective')
      || lowerReq.includes('detective')
      || lowerReq.includes('traceback')
      || lowerReq.includes('root cause')
      || lowerReq.includes('causal trace')
      || lowerReq.includes('nguyên nhân gốc rễ')
    );

    if (isErrorDetective) {
      return {
        category: 'error_detective',
        phase,
        negativeGate: [
          'NEVER patch downstream symptoms (e.g. empty null checks at crash site) without tracing to upstream root cause.',
          'NEVER guess code defects without extracting exact file, line, and column from logs or stack traces.',
          'NEVER modify test assertion expectations to match defective implementation output.',
          'NEVER repeat the same failing tool command or arguments without revising the causal hypothesis.',
        ],
        premiseCheck: 'Distinguish surface symptom (crash/exception frame) from the true root cause (upstream unhandled state or contract drift).',
        falsificationCriteria: 'If a proposed fix resolves the local crash but causes downstream tests or callers to receive corrupted state, the causal hypothesis is FALSIFIED.',
        executionTopology: [
          'Log & Stack Trace Parsing: Extract exact file, line, and column via multi-language error patterns.',
          'Backward Causal Tracing: Walk backward from symptom frame to the origin of invalid state.',
          'Anti-Pattern Classification: Map defect to known pattern (NULL_DEREFERENCE, SIGNATURE_MISMATCH, etc.).',
          'Surgical Root Cause Repair: Fix the invariant at source using minimal targeted mutations.',
          'Empirical Falsification Test: Run build and targeted test suites to confirm complete resolution.',
        ],
        actionBoundary: 'Scope mutations strictly to the root cause locus identified through backward causal tracing.',
      };
    }

    // Specialized Scaffold for Context Compression & Memory Persistence (/context-compression)
    const isContextCompression = (
      lowerReq.includes('context-compression')
      || lowerReq.includes('context_compression')
      || lowerReq.includes('nén ngữ cảnh')
      || lowerReq.includes('tóm tắt lịch sử')
      || lowerReq.includes('history persistence')
      || lowerReq.includes('conversation memory')
      || lowerReq.includes('lưu trữ lịch sử')
      || lowerReq.includes('compact context')
      || lowerReq.includes('context compaction')
      || lowerReq.includes('rolling synopsis')
      || lowerReq.includes('anchored summary')
      || lowerReq.includes('artifact trail')
    );

    if (isContextCompression) {
      return {
        category: 'context_compression',
        phase,
        negativeGate: [
          'NEVER dump raw uncompressed conversation history or multi-thousand-line tool output logs into the context window.',
          'NEVER omit the explicit Artifact Trail (segregating [MODIFIED], [CREATED], and [READ-ONLY] files) when summarizing session context.',
          'NEVER discard past architectural decisions, technical constraints, or unfulfilled user intents across compression cycles.',
          'NEVER fabricate mock test passes or hide failing verification evidence in the Current State summary.',
        ],
        premiseCheck: 'Verify that long-term history is securely persisted to disk (SessionPersistence / JSONL) before applying lossy context window projection.',
        falsificationCriteria: 'If the agent cannot identify modified files, forgets root-cause decisions, or re-fetches unchanged code due to missing details, the compression representation is FALSIFIED.',
        executionTopology: [
          'Audit Disk Event Store: Confirm raw session events are flushed to immutable append-only JSONL storage.',
          'Artifact Trail Classification: Segregate modified files from read-only inspections with change summaries.',
          'Extract Decisions & Invariants: Retain key design choices, constraints, and non-negotiable architectural rules.',
          'State & Verification Extraction: Record exact passing/failing test commands, exit codes, and error traces.',
          'Anchored 5-Section Synthesis: Format into standard Markdown sections (Intent, Artifact Trail, Decisions, State, Next Steps).',
          'Sliding Window Assembly: Keep the last K turns intact for immediate reactive reasoning.',
        ],
        actionBoundary: 'Structured distillation strictly preserving technical identifiers, file paths, and empirical verification states.',
      };
    }

    // Specialized Scaffold for Data Extraction, Parsing, and Normalization Tasks (SWE-bench Rig)
    const isDataParser = (
      lowerReq.includes('trích xuất')
      || lowerReq.includes('chuẩn hóa')
      || lowerReq.includes('extract')
      || lowerReq.includes('normalize')
      || lowerReq.includes('parser')
      || lowerReq.includes('phone')
      || lowerReq.includes('email')
      || lowerReq.includes('validator')
    );

    if (isDataParser && (isCodingTask || lowerReq.includes('hàm') || lowerReq.includes('test'))) {
      const negativeGate = [
        'Do not assume one regex or one normalization rule covers every format in the active specification.',
        'Derive normalization, validity, casing, and deduplication rules from current tests, schemas, or documented contracts (deduplicate entries).',
        'Do not admit malformed or truncated values that violate the observed contract.',
      ];

      if (consecutiveFailures > 1) {
        negativeGate.push(`Anti-Thrashing Gate: You have failed ${consecutiveFailures} times; inspect the exact sample input and assertion lines in test file using read_file before editing.`);
      }

      return {
        category: 'data_parser',
        phase,
        negativeGate,
        premiseCheck: 'Inspect representative inputs, expected outputs, and negative cases before choosing parsing or normalization rules.',
        falsificationCriteria: 'If the implementation misses a valid observed format or accepts a value rejected by the contract, revise the parsing hypothesis.',
        executionTopology: [
          'Ground Truth Spec: Read test file to inspect sample strings, expected outputs, and negative test cases.',
          'Format Normalization: Derive transformations from the active data contract instead of assuming locale-specific rules.',
          'Validation & Deduplication: Apply only constraints supported by tests, schemas, or documentation.',
          'Empirical Falsification: Run test suite to verify both element inclusion and exact array length assertions.',
        ],
        actionBoundary: 'Scope changes strictly to parser/validator functions matching 100% of test specifications.',
      };
    }

    if (isCodingTask) {
      // 1. Phân hóa scaffold chuyên biệt theo từng Phase để triệt tiêu việc gọi nhầm tool (Tool Gating Alignment)
      if (phase === 'plan') {
        const negativeGate = [
          '🔒 [PHASE LOCK: PLAN] NEVER attempt code mutations (DO NOT call replace_text, apply_patch, write_file, write_to_file) during the PLAN phase.',
          'NEVER fabricate mock test data inside production code.',
          'NEVER comment out or silence compiler/LSP diagnostics.',
          'NEVER guess or hallucinate test commands or binary output paths without inspecting project manifests or confirming file existence with list_files.',
        ];

        if (consecutiveFailures > 1) {
          negativeGate.push(`Anti-Thrashing Gate: You have failed ${consecutiveFailures} times; DO NOT attempt code edits while in PLAN phase.`);
        }

        return {
          category: 'code',
          phase: 'plan',
          negativeGate,
          premiseCheck: activeTask
            ? `Verify plan alignment for task: "${activeTask}". Ensure steps decompose root cause resolution.`
            : 'Formulate a comprehensive plan with atomic, ordered, testable steps before unlocking implementation.',
          falsificationCriteria: 'If the plan misses edge cases, architectural invariants, or verification steps, the plan is INCOMPLETE and must be refined with create_plan / update_plan_task.',
          executionTopology: [
            'Step 1 (Architectural Inspection): Inspect relevant files and references using read-only tools (read_file, list_files, grep_search).',
            'Step 2 (Scope & Dependency Mapping): Identify exact file boundaries, caller impact, and technical constraints.',
            'Step 3 (Plan Formalization): Use create_plan to define ordered, atomic subtasks with concrete acceptance criteria.',
            'Step 4 (Phase Transition Readiness): Once plan is accepted and locked, transition to explore or implement phase.',
          ],
          actionBoundary: 'Strictly READ-ONLY and PLANNING actions (read_file, list_files, grep_search, create_plan, update_plan_task). Code editing tools are FORBIDDEN.',
        };
      }

      if (phase === 'explore') {
        const leadingInfo = detectLeadingQuery(request);
        const negativeGate = [
          '🔒 [PHASE LOCK: EXPLORE] NEVER modify production files or run mutations during EXPLORATION.',
          'NEVER assume root cause without reading the exact offending lines with read_file/view_file first.',
          'NEVER guess code defects without extracting exact file, line, and column from logs or stack traces.',
          'NEVER fabricate mock test data inside production code.',
          '🔒 [ANTI-SYCOPHANCY GATE]: Do not uncritically accept user premises or leading questions. Test the Null Hypothesis (H0) against independent code facts.',
          '🔒 [COUNTERFACTUAL PROBE]: When locating a defect, verify whether the symptom could be triggered by caller inputs, configs, or cache rather than local code alone.',
        ];

        if (consecutiveFailures > 1) {
          negativeGate.push(`Anti-Thrashing Gate: You have failed ${consecutiveFailures} times; focus on root cause localization.`);
        }

        return {
          category: 'code',
          phase: 'explore',
          negativeGate,
          premiseCheck: activeTask
            ? `Verify active task focus: "${activeTask}". Confirm whether symptoms match underlying state.`
            : 'Confirm whether the symptom is reproducible and isolate the defect locus before attempting any code fix.',
          falsificationCriteria: 'If gathered facts contradict the initial diagnosis, pivot exploration immediately to alternative components.',
          executionTopology: [
            'Step 1 (Targeted Inspection): Read suspected files, configs, and caller chains with read_file/view_file.',
            'Step 2 (Defect Localization): Pinpoint exact source lines causing incorrect state.',
            'Step 3 (Reproduction Evidence): Verify behavior with safe read/run commands without mutating production code.',
            'Step 4 (Readiness Hand-off): Once root cause is proven with empirical evidence, unlock IMPLEMENT phase.',
          ],
          actionBoundary: 'Gather empirical evidence and locate defect. Modifying production code is LOCKED.',
          premiseInversion: leadingInfo.isLeading ? {
            isLeading: true,
            nullHypothesis: 'H0 (Null Hypothesis): The user\'s suspected cause is secondary or incorrect; the defect locus lies elsewhere or behavior is intentional.',
            affirmativeHypothesis: 'H1 (Affirmative Hypothesis): The user\'s suspected cause is the true root cause.',
            counterfactualProbe: 'Inspect upstream callers, configurations, and related modules before confirming user hypothesis.',
          } : undefined,
        };
      }

      if (phase === 'verify') {
        const negativeGate = [
          '🔒 [PHASE LOCK: VERIFY] NEVER implement new features or refactor unrelated code during VERIFICATION.',
          'NEVER disable, delete, or comment out failing assertions to achieve green test passes.',
          'NEVER declare victory without running empirical verification (e.g. npm run build / test suite).',
        ];

        if (consecutiveFailures > 1) {
          negativeGate.push(`Anti-Thrashing Gate: You have failed ${consecutiveFailures} times; inspect exact test failure output.`);
        }

        return {
          category: 'code',
          phase: 'verify',
          negativeGate,
          premiseCheck: activeTask
            ? `Verify active task completion: "${activeTask}". Ensure verification covers all acceptance criteria.`
            : 'Verify whether the applied changes completely satisfy original requirements without introducing regressions.',
          falsificationCriteria: 'If verification tests, linter, or compiler fail, the fix is INVALID and must be corrected or rolled back.',
          executionTopology: [
            'Step 1 (Targeted Test Execution): Run unit/integration tests directly covering modified loci.',
            'Step 2 (LSP & Build Diagnostics): Inspect compiler, build, and linter feedback.',
            'Step 3 (Regression Sweep): Run broader test suite to ensure zero collateral breakage.',
            'Step 4 (Completion Sign-off): Report verified outcome with concrete test pass artifacts.',
          ],
          actionBoundary: 'Execute verification commands (run_command, test runners). Mutations limited strictly to fixing test discrepancies.',
        };
      }

      // Default for 'implement' phase
      const negativeGate = [
        'NEVER fabricate mock test data inside production code to force a green test.',
        'NEVER comment out or silence compiler/LSP diagnostics.',
        'NEVER modify production code blindly without inspecting actual lines with read_file/view_file first.',
        'NEVER attempt bugfix code changes without writing or running a reproduction test (Agentless reproduction protocol).',
        'NEVER guess or hallucinate test commands or binary output paths without inspecting project manifests or confirming file existence with list_files.',
        'NEVER declare victory without running empirical verification (e.g. npm run build / test).',
      ];

      if (consecutiveFailures > 1) {
        negativeGate.push(`Anti-Thrashing Gate: You have failed ${consecutiveFailures} times; DO NOT repeat similar edits.`);
      }

      return {
        category: 'code',
        phase: 'implement',
        negativeGate,
        premiseCheck: activeTask
          ? `Verify active task focus: "${activeTask}". Ensure current changes align with root cause, not symptoms.`
          : 'Check if the reported issue is an application defect vs environment misconfiguration.',
        falsificationCriteria: 'If verification tests still fail after this mutation, the root-cause hypothesis is INVALID and must be discarded immediately.',
        executionTopology: [
          'Phase 1 (Exploration & Localization): Inspect exact target lines, trace call graph dependencies, and identify root cause.',
          'Phase 2 (Reproduction Gating): Write reproduction test (e.g. scratch/reproduce_*.py) and confirm failing execution.',
          'Phase 3 (Dual-Agent Sufficiency): Verify exploration completeness and blast radius closure before unlocking mutations.',
          'Phase 4 (Surgical Implementation): Apply the minimal atomic change (replace_text / apply_patch).',
          'Phase 5 (Empirical Verification): Re-run reproduction test (must PASS) and full project test suite.',
        ],
        actionBoundary: 'Touch only the specific files necessary for this fix; leave unrelated files untouched.',
      };
    }

    // Default Analytical / Diagnostic Scaffold
    const fallbackLeadingInfo = detectLeadingQuery(request);
    const fallbackNegativeGate = [
      'NEVER provide generic or speculative explanations detached from the actual codebase.',
      'NEVER hallucinate file paths, function names, or dependencies without reading them.',
      'NEVER assume a design choice is optimal without checking alternatives and tradeoffs.',
    ];

    if (fallbackLeadingInfo.isLeading) {
      fallbackNegativeGate.push('🔒 [ANTI-SYCOPHANCY GATE]: Do not uncritically accept user premises or leading questions. Test the Null Hypothesis (H0) against independent code facts.');
      fallbackNegativeGate.push('🔒 [COUNTERFACTUAL PROBE]: When locating a defect, verify whether the symptom could be triggered by caller inputs, configs, or cache rather than local code alone.');
    }

    return {
      category: 'reasoning',
      phase,
      negativeGate: fallbackNegativeGate,
      premiseCheck: 'Check if the user question contains an unstated premise or biased framing.',
      falsificationCriteria: 'If code inspection contradicts the initial assumption, pivot immediately and cite real evidence.',
      executionTopology: [
        'Inspection: Gather ground-truth facts from workspace files.',
        'Premise Validation: Corroborate user question against actual source code.',
        'Tradeoff Analysis: Weigh competing constraints and edge cases.',
        'Structured Synthesis: Provide clear, evidence-backed answer.',
      ],
      actionBoundary: 'Read-only ground-truth inspection before drawing conclusions.',
      premiseInversion: fallbackLeadingInfo.isLeading ? {
        isLeading: true,
        nullHypothesis: 'H0 (Null Hypothesis): The user\'s suspected cause is secondary or incorrect; the defect locus lies elsewhere or behavior is intentional.',
        affirmativeHypothesis: 'H1 (Affirmative Hypothesis): The user\'s suspected cause is the true root cause.',
        counterfactualProbe: 'Inspect upstream callers, configurations, and related modules before confirming user hypothesis.',
      } : undefined,
    };
  }

  /**
   * Evaluates whether a cognitive brake should be triggered to prune a failing branch
   */
  evaluateCognitiveBrake(params: {
    consecutiveFailures: number;
    hypothesisFailedCount: number;
    currentHypothesis?: string;
  }): CognitiveBrakeDecision {
    const { consecutiveFailures, hypothesisFailedCount, currentHypothesis } = params;

    if (hypothesisFailedCount >= 2 && consecutiveFailures >= 1) {
      this.falsifiedHypothesesCount++;
      const reason = `Hypothesis "${currentHypothesis || 'Active Hypothesis'}" failed validation ${hypothesisFailedCount} times.`;
      this.lastBrakeReason = reason;
      return {
        active: true,
        reason,
        prunedBranch: currentHypothesis || 'Current approach',
        recommendedPivot: 'Prune this solution branch. Clear hypothesis, re-inspect error logs from scratch, and adopt an alternative architectural direction.',
      };
    }

    if (consecutiveFailures >= 3) {
      const reason = `Detected ${consecutiveFailures} consecutive tool execution/test failures without progress.`;
      this.lastBrakeReason = reason;
      return {
        active: true,
        reason,
        prunedBranch: 'Current iterative repair loop',
        recommendedPivot: 'Halt repeated mutations. Step back, run LSP diagnostics, inspect git diff, and formulate a fundamentally different hypothesis.',
      };
    }

    return { active: false };
  }

  /**
   * Formats scaffold for prompt injection
   */
  formatScaffoldForPrompt(scaffold: CognitiveScaffold): string {
    const phaseTag = scaffold.phase ? ` - PHASE: ${scaffold.phase.toUpperCase()}` : '';
    const lines: string[] = [
      `🧠 [COGNITIVE SCAFFOLD ACTIVE - ${scaffold.category.toUpperCase()}${phaseTag}]:`,
    ];

    if (scaffold.phase === 'plan') {
      lines.push(`🔒 [PHASE GOVERNANCE]: PLAN MODE ACTIVE. Code mutation tools (replace_text, apply_patch, write_file) are DISABLED. Use create_plan / update_plan_task to outline the execution plan.`);
    } else if (scaffold.phase === 'explore') {
      lines.push(`🔒 [PHASE GOVERNANCE]: EXPLORE MODE ACTIVE. Code mutation tools are LOCKED. Gather empirical evidence and inspect offending lines first.`);
    } else if (scaffold.phase === 'verify') {
      lines.push(`🔒 [PHASE GOVERNANCE]: VERIFY MODE ACTIVE. Run tests and verify diagnostics. Do not introduce new features or unrelated changes.`);
    }

    lines.push(
      `1. [QUALITY GUARDRAILS & GUIDELINES]:`,
      ...scaffold.negativeGate.map((gate) => `   - 💡 ${gate}`),
    );

    if (scaffold.premiseCheck) {
      lines.push(`2. [PREMISE & ANTI-SYCOPHANCY CHECK]:\n   - 🔍 ${scaffold.premiseCheck}`);
    }

    if (scaffold.premiseInversion?.isLeading) {
      lines.push(
        `2b. [PREMISE INVERSION (ANTI-CONFIRMATION BIAS)]:\n` +
        `   - ⚖️ ${scaffold.premiseInversion.nullHypothesis}\n` +
        `   - 🎯 ${scaffold.premiseInversion.affirmativeHypothesis}\n` +
        `   - 🔬 ${scaffold.premiseInversion.counterfactualProbe}`
      );
    }

    lines.push(
      `3. [FALSIFICATION CRITERIA]:\n   - ⚖️ ${scaffold.falsificationCriteria}`,
      `4. [EXECUTION TOPOLOGY]:`,
      ...scaffold.executionTopology.map((step, idx) => `   ${idx + 1}. ${step}`),
      `5. [ACTION BOUNDARY]:\n   - 🎯 ${scaffold.actionBoundary}`,
    );

    return lines.join('\n');
  }

  /**
   * Formats a token-efficient compact scaffold for dynamic prompt injection (~60-90 tokens)
   */
  formatScaffoldForCompactPrompt(scaffold: CognitiveScaffold): string {
    const phaseBanner = scaffold.phase === 'plan'
      ? `   - 🔒 [PHASE GOVERNANCE]: PLAN MODE - Tool mutations (replace_text, apply_patch, write_file) are STRICTLY FORBIDDEN. Outline tasks via create_plan.`
      : scaffold.phase === 'explore'
      ? `   - 🔒 [PHASE GOVERNANCE]: EXPLORE MODE - Mutations locked. Inspect & locate root cause.`
      : scaffold.phase === 'verify'
      ? `   - 🔒 [PHASE GOVERNANCE]: VERIFY MODE - Test execution active. Minimal regression fixes only.`
      : '';

    const gates = scaffold.negativeGate.slice(0, 3).map((gate) => `   - 💡 ${gate}`).join('\n');
    const topo = scaffold.executionTopology.slice(0, 4).map((s, idx) => `${idx + 1}. ${s}`).join(' ➔ ');
    return [
      `🧠 [COGNITIVE SCAFFOLD - ${scaffold.category.toUpperCase()}${scaffold.phase ? ` (${scaffold.phase.toUpperCase()})` : ''}]:`,
      phaseBanner,
      gates,
      `   - ⚖️ Falsification: ${scaffold.falsificationCriteria}`,
      `   - 🧭 Topology: ${topo}`,
      `   - 🎯 Boundary: ${scaffold.actionBoundary}`,
    ].filter(Boolean).join('\n');
  }

  /**
   * Formats scaffold for terminal UI display (human-visible)
   */
  formatScaffoldForUI(scaffold: CognitiveScaffold): string[] {
    const phaseStr = scaffold.phase ? ` (${scaffold.phase.toUpperCase()})` : '';
    return [
      `🧠 [COGNITIVE SCAFFOLD: ${scaffold.category.toUpperCase()}${phaseStr}]`,
      scaffold.phase === 'plan' ? `├── [Phase Governance]: PLAN MODE - Mutations locked (read/plan only)` : '',
      scaffold.phase === 'explore' ? `├── [Phase Governance]: EXPLORE MODE - Evidence gathering active` : '',
      scaffold.phase === 'verify' ? `├── [Phase Governance]: VERIFY MODE - Verification & testing active` : '',
      `├── [Quality Guideline]: ${scaffold.negativeGate[0]}`,
      scaffold.premiseCheck ? `├── [Premise Check]: ${scaffold.premiseCheck}` : '',
      `├── [Falsification]: ${scaffold.falsificationCriteria}`,
      `└── [Topology]: ${scaffold.executionTopology.join(' ➔ ')}`,
    ].filter(Boolean);
  }

  reset(): void {
    this.fileFixationTracker.reset();
    this.falsifiedHypothesesCount = 0;
    this.lastBrakeReason = undefined;
  }
}
