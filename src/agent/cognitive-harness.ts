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

export interface CognitiveScaffold {
  category: 'reasoning' | 'code' | 'anti_deception' | 'error_detective';
  negativeGate: string[];
  premiseCheck?: string;
  falsificationCriteria: string;
  executionTopology: string[];
  actionBoundary: string;
}

export interface CognitiveBrakeDecision {
  active: boolean;
  reason?: string;
  prunedBranch?: string;
  recommendedPivot?: string;
}

export class CognitiveHarness {
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
    );

    const isCodingTask = (
      phase === 'implement'
      || phase === 'verify'
      || lowerReq.includes('fix')
      || lowerReq.includes('implement')
      || lowerReq.includes('refactor')
      || lowerReq.includes('bug')
      || lowerReq.includes('error')
      || lowerReq.includes('code')
      || lowerReq.includes('add')
      || lowerReq.includes('update')
      || lowerReq.includes('delete')
    );

    if (isAntiDeception) {
      return {
        category: 'anti_deception',
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

    if (isCodingTask) {
      const negativeGate = [
        'NEVER fabricate mock test data inside production code to force a green test.',
        'NEVER comment out or silence compiler/LSP diagnostics.',
        'NEVER modify code blindly without inspecting actual lines with read_file first.',
        'NEVER declare victory without running empirical verification (e.g. npm run build / test).',
      ];

      if (consecutiveFailures > 1) {
        negativeGate.push(`Anti-Thrashing Gate: You have failed ${consecutiveFailures} times; DO NOT repeat similar edits.`);
      }

      return {
        category: 'code',
        negativeGate,
        premiseCheck: activeTask
          ? `Verify active task focus: "${activeTask}". Ensure current changes align with root cause, not symptoms.`
          : 'Check if the reported issue is an application defect vs environment misconfiguration.',
        falsificationCriteria: 'If verification tests still fail after this mutation, the root-cause hypothesis is INVALID and must be discarded immediately.',
        executionTopology: [
          'Ground Truth Inspection: Read exact target lines and verify line numbers + hashes.',
          'Falsifiable Hypothesis: State the exact causal mechanism of the defect.',
          'Surgical Mutation: Apply the minimal atomic change (replace_text / apply_patch).',
          'Empirical Falsification Test: Run compiler/test commands to validate or falsify the fix.',
        ],
        actionBoundary: 'Touch only the specific files necessary for this fix; leave unrelated files untouched.',
      };
    }

    // Default Analytical / Diagnostic Scaffold
    return {
      category: 'reasoning',
      negativeGate: [
        'NEVER provide generic or speculative explanations detached from the actual codebase.',
        'NEVER hallucinate file paths, function names, or dependencies without reading them.',
        'NEVER assume a design choice is optimal without checking alternatives and tradeoffs.',
      ],
      premiseCheck: 'Check if the user question contains an unstated premise or biased framing.',
      falsificationCriteria: 'If code inspection contradicts the initial assumption, pivot immediately and cite real evidence.',
      executionTopology: [
        'Inspection: Gather ground-truth facts from workspace files.',
        'Premise Validation: Corroborate user question against actual source code.',
        'Tradeoff Analysis: Weigh competing constraints and edge cases.',
        'Structured Synthesis: Provide clear, evidence-backed answer.',
      ],
      actionBoundary: 'Read-only ground-truth inspection before drawing conclusions.',
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

    if (hypothesisFailedCount >= 2) {
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
    const lines: string[] = [
      `🧠 [COGNITIVE SCAFFOLD ACTIVE - ${scaffold.category.toUpperCase()}]:`,
      `1. [NEGATIVE GATE (SUPPRESSION VECTORS)]:`,
      ...scaffold.negativeGate.map((gate) => `   - ⛔ ${gate}`),
    ];

    if (scaffold.premiseCheck) {
      lines.push(`2. [PREMISE & ANTI-SYCOPHANCY CHECK]:\n   - 🔍 ${scaffold.premiseCheck}`);
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
   * Formats scaffold for terminal UI display (human-visible)
   */
  formatScaffoldForUI(scaffold: CognitiveScaffold): string[] {
    return [
      `🧠 [COGNITIVE SCAFFOLD: ${scaffold.category.toUpperCase()}]`,
      `├── [Negative Gate]: ${scaffold.negativeGate[0]}`,
      scaffold.premiseCheck ? `├── [Premise Check]: ${scaffold.premiseCheck}` : '',
      `├── [Falsification]: ${scaffold.falsificationCriteria}`,
      `└── [Topology]: ${scaffold.executionTopology.join(' ➔ ')}`,
    ].filter(Boolean);
  }

  reset(): void {
    this.falsifiedHypothesesCount = 0;
    this.lastBrakeReason = undefined;
  }
}
