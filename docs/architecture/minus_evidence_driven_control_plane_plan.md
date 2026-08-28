# Minus Evidence-Driven Control Plane
## Implementation Plan for a Verified Autonomous Software-Engineering System

**Target project:** Minus CLI  
**Primary objective:** Merge the current independent mechanisms—

1. `CriticGate / Evidence-Gated Completion`
2. `Hypothesis → Falsification → Rollback`
3. `Adaptive Reasoning Escalation`
4. `Progress / Loop Guard`

—into a single **Evidence-Driven Control Plane (EDCP)**.

The control plane must make every high-impact decision from the **actual, current workspace state** rather than from LLM self-assessment.

The ultimate transformation is:

> **From:** coding chatbot with tools  
> **To:** verified autonomous software-engineering system

---

# 1. Executive Goal

Minus must stop treating the LLM as the authority that decides whether:

- code should be modified,
- a failed approach should be retried,
- reasoning should be escalated,
- a branch should be rolled back,
- the strategy should be changed,
- verification is sufficient,
- or the task is complete.

The LLM should remain responsible for:

- semantic reasoning,
- hypothesis generation,
- candidate solution generation,
- interpretation of ambiguous requirements,
- proposing experiments,
- proposing code changes.

The **Evidence-Driven Control Plane** becomes responsible for:

- state transitions,
- verification freshness,
- mutation authorization,
- rollback decisions,
- completion authorization,
- retry authorization,
- stagnation detection,
- reasoning-strategy escalation,
- evidence validity,
- workspace invariants,
- blast-radius verification,
- termination.

The core design principle is:

> **Generation may be probabilistic. Acceptance must be deterministic.**

---

# 2. Non-Negotiable System Invariants

The following invariants must be enforced by code, not by prompt instructions.

## 2.1 No unverified completion

A task cannot enter `COMPLETED` unless all required verification contracts are satisfied by evidence generated from the current workspace state.

## 2.2 Evidence becomes stale after relevant mutation

Any evidence generated before a mutation that can affect that evidence must be marked `STALE`.

Example:

```text
M1 modify auth.service.ts
V2 run auth tests -> PASS

M3 modify auth.middleware.ts

V2 must no longer be sufficient evidence
if middleware can affect authentication behavior.
```

## 2.3 Compiler/syntax/import failures are hard blockers

If the current candidate introduces compiler, syntax, unresolved import, or equivalent structural errors:

```text
candidateScore = 0
completionAllowed = false
```

## 2.4 Failed speculative mutations must not accumulate

A rejected experiment must either:

- be repaired within the same authorized transaction, or
- be rolled back to the last known green state.

The system must not allow uncontrolled patch-on-patch drift.

## 2.5 Retry requires new information or a changed strategy

Repeating the same action without meaningful new evidence must be blocked.

## 2.6 Reasoning escalation must be justified

Higher reasoning cost must be triggered by measurable:

- uncertainty,
- risk,
- blast radius,
- repeated falsification,
- verification failure,
- or stagnation.

## 2.7 Completion requires workspace-grounded proof

The final answer is downstream from verified state.

The final answer must never be the source of truth for whether the task succeeded.

---

# 3. Target Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                         USER TASK                           │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  TASK INTAKE / SPEC LAYER                  │
│  Goal • Constraints • Acceptance Criteria • Invariants     │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              EVIDENCE-DRIVEN CONTROL PLANE                 │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Workspace State Manager                               │  │
│  │ Digest • Changed Files • Diagnostics • Git State      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Verification Contract Engine                          │  │
│  │ Required checks • Invariants • Scenario coverage      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Hypothesis Graph Engine                               │  │
│  │ Predictions • Tests • Support • Contradictions        │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Transaction / Green-State Engine                      │  │
│  │ Candidate branch • Checkpoint • Commit/rollback       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Evidence Ledger                                       │  │
│  │ Mutation → Verification → Evidence causal chain       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Progress Controller                                   │  │
│  │ Information Gain • Uncertainty Reduction • Coverage   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Adaptive Compute Controller                           │  │
│  │ Reasoning tier + reasoning strategy                   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Critic / Acceptance Engine                            │  │
│  │ Deterministic gate over current evidence              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────┘
                              │
                   ┌──────────┴──────────┐
                   │                     │
                   ▼                     ▼
          ┌────────────────┐     ┌────────────────┐
          │ LLM Reasoner   │     │ Tool Runtime   │
          │ hypotheses     │     │ inspect/edit   │
          │ plans          │     │ execute/test   │
          │ candidates     │     │ diagnostics    │
          └────────────────┘     └────────────────┘
                   │                     │
                   └──────────┬──────────┘
                              ▼
                     VERIFIED WORKSPACE
```

---

# 4. New Architectural Boundary

Introduce a single central component:

```ts
EvidenceDrivenControlPlane
```

No existing subsystem may independently decide:

- `task complete`,
- `retry same approach`,
- `increase reasoning`,
- `rollback`,
- `continue after failed verification`,
- `accept candidate`.

Existing modules become subordinate engines that report structured state to EDCP.

---

# 5. Core Control-Plane State Machine

Use an explicit deterministic state machine.

```text
INTAKE
  ↓
BASELINE
  ↓
INVESTIGATE
  ↓
HYPOTHESIZE
  ↓
PLAN_EXPERIMENT
  ↓
MUTATE
  ↓
VERIFY
  ↓
CRITIQUE
 ┌───────────────┬────────────────┐
 │               │                │
 ▼               ▼                ▼
ACCEPT         FALSIFY         INCONCLUSIVE
 │               │                │
 ▼               ▼                ▼
PROMOTE_GREEN   ROLLBACK       INVESTIGATE
 │               │
 │               ▼
 │          PROGRESS_CHECK
 │          ┌─────┼───────────┐
 │          ▼     ▼           ▼
 │       RETRY  REPLAN     ESCALATE
 │
 ▼
COMPLETION_CHECK
 ├─ incomplete → INVESTIGATE / HYPOTHESIZE
 └─ complete   → FINALIZE
```

No free-form LLM transition is allowed.

The LLM may recommend a transition, but EDCP authorizes it.

---

# 6. Unified Control-Plane Data Model

Create canonical shared state.

```ts
interface ControlPlaneState {
  task: TaskState;
  workspace: WorkspaceState;
  verification: VerificationState;
  hypotheses: HypothesisState;
  evidence: EvidenceState;
  progress: ProgressState;
  reasoning: ReasoningState;
  transaction: TransactionState;
  critic: CriticState;
  lifecycle: LifecycleState;
}
```

---

# 7. Workspace State Manager

## 7.1 Purpose

Make the current workspace state the primary truth source.

## 7.2 Required fields

```ts
interface WorkspaceState {
  workspaceDigest: string;
  gitHead?: string;
  dirty: boolean;

  changedFiles: ChangedFileState[];

  diagnostics: DiagnosticSnapshot;

  activeMutationSeq: number;
  lastVerifiedMutationSeq: number;

  lastGreenCheckpoint?: CheckpointRef;

  fileHashes: Record<string, string>;

  dependencySnapshot?: DependencySnapshot;
}
```

## 7.3 Workspace digest

Compute a reproducible digest over relevant state.

Recommended inputs:

- changed file paths,
- SHA-256 content hashes,
- selected config hashes,
- lockfile/package manifest hashes,
- test configuration hash,
- optional git commit/base ref.

Do not hash the entire repository on every step if it becomes expensive.

Use incremental hash updates.

## 7.4 Dirty-state rules

The control plane must know whether a tool call:

- only observed state,
- mutated state,
- changed runtime state,
- changed dependency state,
- invalidated previous evidence.

---

# 8. Verification Contract Engine

Upgrade `CriticGate` from a late-stage quality scorer into a contract-driven verification system.

## 8.1 Verification contract

At task initialization, derive:

```ts
interface VerificationContract {
  contractId: string;

  taskGoal: string;

  acceptanceCriteria: AcceptanceCriterion[];

  invariants: VerificationInvariant[];

  requiredChecks: VerificationCheck[];

  requiredScenarios: VerificationScenario[];

  regressionScope: RegressionScope;

  prohibitedOutcomes: ProhibitedOutcome[];

  completionPolicy: CompletionPolicy;
}
```

## 8.2 Example

```ts
{
  taskGoal: "Fix login HTTP 500 error",

  acceptanceCriteria: [
    "Valid credentials return success",
    "Invalid credentials remain rejected"
  ],

  invariants: [
    "Project compiles",
    "No new diagnostics",
    "Existing authentication tests remain green"
  ],

  requiredChecks: [
    "targeted diagnostics",
    "auth test suite",
    "git diff inspection"
  ],

  prohibitedOutcomes: [
    "authentication bypass",
    "unrelated file mutations"
  ]
}
```

## 8.3 Contract derivation sources

Use:

1. user request,
2. existing plan/spec,
3. repository test structure,
4. changed symbol blast radius,
5. existing diagnostics,
6. known project commands.

## 8.4 Contract levels

Support:

```text
MINIMAL
STANDARD
HIGH_RISK
CRITICAL
```

Higher risk means broader verification.

---

# 9. Causal Evidence Ledger

Replace simple pass/fail records with causally linked evidence.

## 9.1 Evidence object

```ts
interface EvidenceRecord {
  evidenceId: string;

  type:
    | "diagnostic"
    | "test"
    | "build"
    | "runtime"
    | "diff"
    | "static-analysis"
    | "symbol-impact"
    | "user-assertion"
    | "environment";

  generatedAt: number;

  workspaceDigest: string;

  mutationSeq: number;

  sourceTool: string;

  command?: string;

  target?: string;

  status:
    | "PASS"
    | "FAIL"
    | "INCONCLUSIVE"
    | "STALE";

  freshness: "FRESH" | "STALE";

  supports: string[];

  contradicts: string[];

  artifactRefs?: string[];

  summary: string;
}
```

## 9.2 Evidence freshness

Evidence is valid only when:

```text
evidence.workspaceDigest is compatible with current workspace state
```

Use selective invalidation where possible.

Example:

```text
mutation changes frontend-only file
→ backend unit-test evidence may remain fresh

mutation changes shared auth model
→ auth integration evidence becomes stale
```

## 9.3 Causal links

Store:

```text
Hypothesis
   ↓
Experiment
   ↓
Mutation
   ↓
Verification
   ↓
Evidence
   ↓
Critic Decision
```

This should be queryable.

---

# 10. Hypothesis Graph Engine

Upgrade the current `HypothesisTracker` from a flat lifecycle to a causal graph.

## 10.1 Hypothesis model

```ts
interface HypothesisNode {
  id: string;

  statement: string;

  parentIds: string[];

  status:
    | "FORMULATED"
    | "TESTING"
    | "SUPPORTED"
    | "VALIDATED"
    | "WEAKENED"
    | "FALSIFIED"
    | "ABANDONED";

  confidence: number;

  predictedObservations: PredictedObservation[];

  falsificationTests: FalsificationTest[];

  supportingEvidenceIds: string[];

  contradictingEvidenceIds: string[];

  targetFiles: string[];

  targetSymbols: string[];

  blastRadius: BlastRadiusEstimate;

  proposedMutation?: MutationProposal;

  estimatedExperimentCost: number;

  rejectionReason?: string;

  learning?: string;
}
```

## 10.2 Mandatory prediction before mutation

For non-trivial debugging, a hypothesis must define:

```text
If this hypothesis is true,
what observable result should we see?
```

The control plane should reject expensive speculative mutation when the hypothesis has no falsifiable prediction.

## 10.3 Hypothesis scoring

Rank candidates using:

```text
Expected Information Gain
× Probability
÷ Experiment Cost
× Safety Modifier
```

The exact implementation may begin heuristic and become learned later.

## 10.4 Prevent repeated falsified approaches

A new hypothesis must be semantically distinct from recently falsified hypotheses unless new evidence explicitly reopens them.

---

# 11. Parallel Hypothesis Search

Add selective parallel experimentation for hard tasks.

## 11.1 Trigger only when

```text
uncertainty >= threshold
AND
candidateHypotheses >= 2
AND
branch isolation available
AND
expected information gain > cost
```

## 11.2 Architecture

```text
Root Green State G0
     │
 ┌───┼───────────────┐
 ▼   ▼               ▼
H1  H2              H3
│    │               │
B1   B2              B3
│    │               │
V1   V2              V3
│    │               │
X   PASS              X
     │
     ▼
promote B2 candidate
```

## 11.3 Requirements

Each branch must have:

- isolated workspace/worktree,
- branch-specific evidence ledger,
- mutation sequence,
- verification results,
- cleanup on rejection.

Do not enable this by default for simple tasks.

---

# 12. Transaction and Last-Known-Green Engine

Upgrade rollback into explicit candidate-state search.

## 12.1 Definitions

```text
GREEN
= verified state satisfying all required invariants so far

CANDIDATE
= speculative state not yet accepted

REJECTED
= candidate proven invalid or unsafe
```

## 12.2 State progression

```text
G0
 ↓ open transaction
C1
 ↓ verify

PASS → promote C1 to G1
FAIL → destroy C1 and restore G0
```

## 12.3 Checkpoint model

```ts
interface GreenCheckpoint {
  checkpointId: string;

  workspaceDigest: string;

  mutationSeq: number;

  evidenceIds: string[];

  gitState?: string;

  createdAt: number;

  verifiedInvariants: string[];
}
```

## 12.4 Mutation transaction

```ts
interface MutationTransaction {
  transactionId: string;

  baseCheckpointId: string;

  status:
    | "OPEN"
    | "VERIFYING"
    | "COMMITTED"
    | "ROLLED_BACK";

  affectedFiles: string[];

  affectedSymbols: string[];

  mutationIds: string[];

  expectedEffects: string[];
}
```

## 12.5 Rollback triggers

Rollback when:

- syntax/compiler integrity is broken,
- hypothesis is falsified and mutation was hypothesis-specific,
- required verification fails,
- progress becomes negative,
- blast radius exceeds authorized scope,
- mutation diverges from intended files,
- timeout or tool failure leaves transaction integrity uncertain.

---

# 13. Critic / Acceptance Engine

The Critic becomes a deterministic decision engine over structured evidence.

## 13.1 Critic inputs

```ts
CriticInput {
  contract;
  currentWorkspaceState;
  currentTransaction;
  freshEvidence;
  currentHypotheses;
  progressState;
  diagnostics;
}
```

## 13.2 Critic output

```ts
interface CriticDecision {
  verdict:
    | "ACCEPT_CANDIDATE"
    | "REJECT_CANDIDATE"
    | "NEED_MORE_EVIDENCE"
    | "ROLLBACK"
    | "REPLAN"
    | "BLOCK_COMPLETION";

  score: number;

  hardBlockers: string[];

  missingEvidence: string[];

  staleEvidence: string[];

  reasons: string[];

  authorizedNextActions: ControlAction[];
}
```

## 13.3 Hard blockers

Examples:

- new compiler error,
- failed required scenario,
- stale required evidence,
- unresolved high-severity diagnostic,
- changed files outside authorized blast radius,
- no verification after latest relevant mutation,
- failed safety invariant.

## 13.4 Completion authorization

Only EDCP may set:

```text
lifecycle.status = COMPLETED
```

The LLM may only request completion.

---

# 14. Adaptive Compute Controller

Replace token-only escalation with strategy-level escalation.

## 14.1 Inputs

```ts
interface ReasoningPressure {
  taskRisk: number;
  uncertainty: number;
  blastRadius: number;
  failureCount: number;
  stagnationScore: number;
  hypothesisEntropy: number;
  verificationFailures: number;
}
```

## 14.2 Reasoning tiers

### Tier 0 — Direct

For:

- factual inspection,
- trivial one-file changes,
- formatting,
- obvious typo-level fixes.

Strategy:

```text
inspect → mutate → verify
```

### Tier 1 — Structured

Adds:

- explicit mini-plan,
- targeted diagnostics,
- targeted verification.

### Tier 2 — Hypothesis

Adds:

- explicit hypothesis,
- predicted observations,
- falsification test,
- blast-radius check.

### Tier 3 — Deep Causal

Adds:

- call graph,
- dependency impact,
- multiple competing hypotheses,
- broader regression tests.

### Tier 4 — Speculative Search

Adds:

- parallel branches,
- multiple hypothesis experiments,
- expanded verification,
- optional critic ensemble.

## 14.3 Escalation rules

Escalate when:

- repeated falsification,
- insufficient information gain,
- contradiction in evidence,
- repeated verification failure,
- unexpectedly expanding blast radius,
- high-risk task,
- persistent uncertainty.

## 14.4 De-escalation

After a stable validated hypothesis:

```text
reasoning tier may decrease
```

Do not keep high-cost reasoning active unnecessarily.

---

# 15. Progress Controller

Upgrade loop detection into measurable progress.

## 15.1 Progress vector

```ts
interface ProgressVector {
  informationGain: number;
  uncertaintyReduction: number;
  hypothesisReduction: number;
  goalCompletionDelta: number;
  verificationCoverageDelta: number;
  workspaceHealthDelta: number;
}
```

## 15.2 Progress score

Initial implementation can use weighted heuristics:

```text
ProgressScore =
  w1 * informationGain
+ w2 * uncertaintyReduction
+ w3 * hypothesisReduction
+ w4 * goalCompletionDelta
+ w5 * verificationCoverageDelta
+ w6 * workspaceHealthDelta
```

Avoid over-optimizing the exact formula initially.

Correct state transitions matter more than mathematical sophistication.

## 15.3 Zero-progress detection

Examples:

```text
same grep query
same read_file
same diagnostic output
same failing test
same hypothesis wording
same mutation pattern
```

A repeated call is allowed only if the underlying state changed enough to make repetition informative.

## 15.4 Strategy switching

After N low-progress steps:

```text
text search
→ symbol inspection
→ call graph
→ isolated reproduction
→ new hypothesis
→ reasoning escalation
```

The control plane chooses from allowed strategy transitions.

---

# 16. Unified Decision Cycle

Every meaningful coding iteration should follow:

```text
1. Read current ControlPlaneState

2. Determine active objective

3. Determine current uncertainty

4. Select hypothesis or investigation target

5. Select authorized strategy

6. Collect observations

7. Update hypothesis graph

8. If mutation justified:
      open transaction

9. Apply bounded mutation

10. Invalidate affected evidence

11. Run required verification

12. Record causal evidence

13. Critic evaluates candidate

14a. PASS:
      promote candidate to green

14b. FAIL:
      falsify/weaken hypothesis
      rollback if required

15. Compute progress gradient

16. Decide:
      continue
      replan
      escalate
      parallelize
      finalize
```

---

# 17. Proposed File Structure

Recommended new structure:

```text
src/control-plane/
├── evidence-driven-control-plane.ts
├── control-plane-state.ts
├── control-plane-events.ts
├── control-plane-policy.ts
├── control-plane-reducer.ts
├── control-plane-state-machine.ts
│
├── workspace/
│   ├── workspace-state-manager.ts
│   ├── workspace-digest.ts
│   ├── mutation-impact.ts
│   └── evidence-invalidation.ts
│
├── verification/
│   ├── verification-contract.ts
│   ├── verification-contract-engine.ts
│   ├── verification-planner.ts
│   └── verification-coverage.ts
│
├── evidence/
│   ├── evidence-ledger.ts
│   ├── evidence-record.ts
│   ├── evidence-freshness.ts
│   └── causal-evidence-graph.ts
│
├── hypothesis/
│   ├── hypothesis-graph.ts
│   ├── hypothesis-ranking.ts
│   ├── falsification-engine.ts
│   └── parallel-hypothesis-controller.ts
│
├── transaction/
│   ├── mutation-transaction.ts
│   ├── green-checkpoint-manager.ts
│   ├── rollback-engine.ts
│   └── speculative-branch-controller.ts
│
├── reasoning/
│   ├── adaptive-compute-controller.ts
│   ├── reasoning-pressure.ts
│   └── strategy-policy.ts
│
├── progress/
│   ├── progress-controller.ts
│   ├── progress-vector.ts
│   ├── stagnation-detector.ts
│   └── strategy-switcher.ts
│
└── critic/
    ├── critic-engine.ts
    ├── acceptance-policy.ts
    ├── completion-gate.ts
    └── critic-decision.ts
```

---

# 18. Existing Files to Refactor

Refactor responsibilities from current modules.

## `src/agent/critic-gate.ts`

Move from independent gate to adapter around:

```text
control-plane/critic/critic-engine.ts
```

Keep compatibility wrapper temporarily.

## `src/agent/hypothesis-tracker.ts`

Migrate into:

```text
control-plane/hypothesis/hypothesis-graph.ts
```

Preserve existing hypothesis lifecycle data during migration.

## `src/agent/hypothesis-rollback-orchestrator.ts`

Split into:

```text
falsification-engine.ts
rollback-engine.ts
green-checkpoint-manager.ts
```

## `src/agent/adaptive-reasoning-controller.ts`

Replace direct tier escalation with:

```text
adaptive-compute-controller.ts
strategy-policy.ts
```

## `src/agent/loop-progress-guard.ts`

Replace local repetition checks with:

```text
progress-controller.ts
stagnation-detector.ts
```

Keep fingerprint logic as one signal.

## `src/agent/completion-evidence.ts`

Migrate into:

```text
evidence-ledger.ts
evidence-freshness.ts
```

## `src/agent/final-answer-guard.ts`

Reduce responsibility.

It should only validate final-answer formatting/policy.

It must not remain the primary completion authority.

## `src/agent/agent-loop.ts`

Major objective:

> Remove decision ownership from the AgentLoop.

The AgentLoop should become an orchestration shell:

```text
receive control-plane action
→ invoke model/tool
→ report result
→ request next control-plane action
```

Do not let `agent-loop.ts` own acceptance logic.

---

# 19. Required Agent Loop Refactor

Target:

```ts
while (!controlPlane.isTerminal()) {
  const action = await controlPlane.nextAction();

  const result = await executeControlAction(action);

  await controlPlane.ingest(result);
}
```

The current loop should progressively lose direct ownership of:

- reasoning escalation,
- retry decisions,
- completion decisions,
- rollback decisions,
- loop detection,
- verification sufficiency.

---

# 20. Control Actions

Use typed control-plane commands.

```ts
type ControlAction =
  | InspectAction
  | DiagnoseAction
  | FormHypothesisAction
  | RunExperimentAction
  | OpenTransactionAction
  | MutateAction
  | VerifyAction
  | RollbackAction
  | PromoteGreenAction
  | ReplanAction
  | EscalateReasoningAction
  | SpawnHypothesisBranchAction
  | RequestMoreEvidenceAction
  | FinalizeAction;
```

This gives one audit-friendly decision vocabulary.

---

# 21. Event-Sourced State Updates

Prefer event-driven updates.

Example:

```text
TaskAccepted
BaselineCaptured
HypothesisFormulated
EvidenceRecorded
TransactionOpened
MutationApplied
EvidenceInvalidated
VerificationStarted
VerificationPassed
CriticAccepted
CheckpointPromoted
TaskCompleted
```

The control-plane reducer should derive state from events.

Benefits:

- replay,
- debugging,
- postmortem analysis,
- deterministic tests,
- future learning from trajectories.

---

# 22. Observability

Add a control-plane trace visible in CLI debug mode.

Example:

```text
[EDCP] state=VERIFY
[EDCP] workspace=4c9f...
[EDCP] mutationSeq=12
[EDCP] staleEvidence=2
[EDCP] requiredChecks=3
[EDCP] progress=+0.42
[EDCP] reasoningTier=2
[EDCP] strategy=HYPOTHESIS_TEST
```

For rejected completion:

```text
[EDCP] completion blocked
  - auth integration evidence is stale
  - compiler verification missing after mutation #12
```

---

# 23. User-Visible UX Breakthroughs

The following outcomes should become visibly obvious.

## 23.1 Evidence-backed completion

Instead of:

```text
Task completed.
```

show:

```text
✓ Build: PASS
✓ Diagnostics: 0 new errors
✓ Targeted tests: 12/12 PASS
✓ Regression tests: 84/84 PASS
✓ Required scenario: PASS
✓ Diff scope: VALID
✓ Evidence freshness: CURRENT

Verified completion.
```

## 23.2 Stale verification detection

```text
Previous test evidence became stale after the latest mutation.
Re-running affected verification.
```

## 23.3 Explicit hypothesis debugging

```text
H1: JWT parsing bug                FALSIFIED
H2: transaction boundary issue    SUPPORTED
H3: DTO serialization issue       FALSIFIED
```

## 23.4 Clean rollback behavior

```text
Candidate failed invariant checks.
Rolled back to green checkpoint G7.
```

## 23.5 Strategy switching

```text
No meaningful information gain in 3 steps.
Switching from text search to call-graph analysis.
```

## 23.6 Adaptive strategy escalation

```text
Reasoning strategy escalated:
STRUCTURED → DEEP_CAUSAL

Reason:
- high blast radius
- two falsified hypotheses
- integration verification failure
```

---

# 24. Phase-by-Phase Implementation Plan

# Phase 0 — Baseline and Instrumentation

## Goal

Measure current behavior before architecture changes.

## Tasks

- add current mutation sequence tracking,
- add workspace digest,
- add evidence timestamps,
- add retry counters,
- add loop/stagnation telemetry,
- add reasoning-tier telemetry,
- record rollback events,
- record final completion reason.

## Acceptance Criteria

- every mutation has a monotonic sequence ID,
- current workspace digest is queryable,
- current reasoning tier is observable,
- completion can be traced to its current gate decision.

---

# Phase 1 — Canonical ControlPlaneState

## Goal

Create one authoritative state object.

## Tasks

- implement `ControlPlaneState`,
- introduce typed state slices,
- add reducer/event mechanism,
- adapt existing modules to publish state instead of deciding globally,
- create read-only state inspection APIs.

## Acceptance Criteria

- all four existing modules can read the same state snapshot,
- no duplicate mutation/evidence counters exist,
- state can be serialized and replayed.

---

# Phase 2 — Evidence Ledger and Freshness

## Goal

Make evidence mutation-aware.

## Tasks

- create `EvidenceRecord`,
- create `EvidenceLedger`,
- bind evidence to workspace digest,
- implement evidence invalidation,
- classify evidence scope,
- mark evidence fresh/stale after mutation.

## Acceptance Criteria

Test scenario:

```text
run test -> PASS
modify relevant file
attempt completion
```

Expected:

```text
completion blocked because test evidence is stale
```

This phase is mandatory before deeper control-plane integration.

---

# Phase 3 — Verification Contract Engine

## Goal

Convert completion into explicit contract satisfaction.

## Tasks

- derive acceptance criteria,
- derive required checks,
- define invariants,
- define risk profiles,
- compute missing verification,
- integrate with evidence freshness.

## Acceptance Criteria

- completion cannot occur without contract satisfaction,
- hard invariants cannot be overridden by LLM confidence,
- missing evidence produces structured actionable requirements.

---

# Phase 4 — Transactional Green-State Engine

## Goal

Stop failed experiments from polluting the workspace.

## Tasks

- implement candidate transactions,
- capture green checkpoints,
- promote verified candidate,
- rollback rejected candidate,
- integrate workspace digest,
- integrate existing speculative branch manager where appropriate.

## Acceptance Criteria

Given:

```text
G0 green
candidate mutation breaks compilation
```

Expected:

```text
candidate rejected
workspace restored to G0
```

No failed speculative code remains.

---

# Phase 5 — Hypothesis Graph

## Goal

Turn debugging into causal search.

## Tasks

- migrate hypothesis tracker,
- add predictions,
- add falsification tests,
- connect evidence edges,
- track supporting/contradicting evidence,
- prevent equivalent retries,
- rank next experiment.

## Acceptance Criteria

- a falsified hypothesis cannot be retried unchanged,
- every non-trivial debug mutation has an active hypothesis,
- hypothesis state is updated from actual tool evidence.

---

# Phase 6 — Progress Gradient

## Goal

Detect lack of learning, not only repeated tool calls.

## Tasks

- implement progress vector,
- reuse existing call/result fingerprints,
- compute information gain heuristics,
- detect repeated semantic attempts,
- detect stagnant hypothesis space,
- trigger strategy switch.

## Acceptance Criteria

A sequence like:

```text
same grep
same grep
same test
same test
```

must not continue indefinitely.

The system must choose a distinct strategy or stop with a structured blocker.

---

# Phase 7 — Adaptive Compute Strategy

## Goal

Make escalation change the method, not only token budget.

## Tasks

- implement reasoning pressure,
- define tiers 0–4,
- define strategy capabilities by tier,
- connect progress stagnation,
- connect hypothesis entropy,
- connect risk/blast radius,
- allow de-escalation.

## Acceptance Criteria

- trivial task remains Tier 0/1,
- repeated failed debug task escalates to hypothesis mode,
- high-risk cross-cutting refactor can start at Tier 2/3,
- no unconditional maximum-reasoning behavior.

---

# Phase 8 — Unified Critic Engine

## Goal

Make acceptance deterministic.

## Tasks

- replace current critic ownership,
- consume VerificationContract,
- consume fresh EvidenceLedger entries,
- consume workspace state,
- consume hypothesis state,
- consume diagnostics,
- produce structured `CriticDecision`.

## Acceptance Criteria

No completion path can bypass CriticEngine.

---

# Phase 9 — AgentLoop Decomposition

## Goal

Remove God-Orchestrator decision logic.

## Tasks

- move decision rules into EDCP,
- leave AgentLoop as execution coordinator,
- remove direct completion decisions,
- remove direct reasoning escalation,
- remove direct rollback decisions,
- remove direct loop-guard ownership.

## Acceptance Criteria

AgentLoop can be summarized as:

```text
ask control plane → execute → report → repeat
```

---

# Phase 10 — Parallel Hypothesis Search

## Goal

Increase performance on hard ambiguous bugs.

## Tasks

- integrate worktree/speculative branch isolation,
- add branch budgets,
- add branch-specific evidence,
- compare candidates,
- promote strongest validated branch,
- destroy rejected branches.

## Acceptance Criteria

A hard debugging scenario can run multiple independent experiments without polluting the primary workspace.

---

# Phase 11 — Completion Report and Audit Trail

## Goal

Make verification visible and auditable.

## Tasks

Generate:

```ts
interface VerifiedCompletionReport {
  goal: string;
  finalWorkspaceDigest: string;
  acceptedCheckpoint: string;
  satisfiedCriteria: string[];
  verificationEvidence: EvidenceSummary[];
  changedFiles: string[];
  rejectedHypotheses: string[];
  acceptedHypotheses: string[];
  rollbackCount: number;
  reasoningEscalations: ReasoningTransition[];
}
```

## Acceptance Criteria

Every completed coding task can explain:

- what changed,
- why it changed,
- how it was verified,
- which evidence is fresh,
- which failed approaches were rejected.

---

# 25. Testing Strategy

Create dedicated control-plane tests instead of growing the existing monolithic test file.

Recommended:

```text
src/control-plane/__tests__/
├── workspace-state.test.ts
├── evidence-freshness.test.ts
├── verification-contract.test.ts
├── critic-engine.test.ts
├── green-checkpoint.test.ts
├── rollback.test.ts
├── hypothesis-graph.test.ts
├── progress-controller.test.ts
├── adaptive-compute.test.ts
├── parallel-hypothesis.test.ts
├── completion-gate.test.ts
└── end-to-end-control-plane.test.ts
```

---

# 26. Critical Test Scenarios

## Scenario A — Stale evidence

1. modify file,
2. run test → pass,
3. modify relevant file again,
4. attempt completion.

Expected:

```text
completion blocked
evidence marked STALE
```

---

## Scenario B — Compiler regression

1. start from green,
2. candidate mutation introduces type error,
3. diagnostics run.

Expected:

```text
critic score = 0
candidate rejected
rollback
```

---

## Scenario C — Repeated failed hypothesis

1. H1 tested,
2. evidence falsifies H1,
3. LLM proposes semantically equivalent H1.

Expected:

```text
retry rejected
new hypothesis required
```

---

## Scenario D — Stagnation

1. repeated read/grep actions,
2. no new evidence,
3. progress score remains near zero.

Expected:

```text
strategy switch or reasoning escalation
```

---

## Scenario E — Green promotion

1. candidate mutation,
2. diagnostics pass,
3. targeted tests pass,
4. required regression passes,
5. contract satisfied.

Expected:

```text
candidate promoted to new green checkpoint
```

---

## Scenario F — Parallel hypotheses

1. H1/H2/H3 created,
2. isolated branches execute,
3. H1/H3 fail,
4. H2 passes all contract checks.

Expected:

```text
H2 promoted
H1/H3 cleaned
```

---

## Scenario G — Easy task cost control

Task:

```text
rename local variable
```

Expected:

```text
Tier 0/1
no hypothesis graph expansion
no unnecessary parallelism
minimal verification
```

---

## Scenario H — High-risk refactor

Task touches:

- auth middleware,
- service,
- shared model,
- route.

Expected:

```text
higher reasoning tier
blast-radius analysis
broader verification
completion blocked until all required checks pass
```

---

# 27. Performance Requirements

The EDCP must improve reliability without making every task slow.

## 27.1 Fast path

For low-risk changes:

```text
inspect
→ mutate
→ targeted diagnostics
→ targeted verification
→ complete
```

No hypothesis graph expansion unless needed.

## 27.2 Incremental state computation

Use:

- cached file hashes,
- incremental dependency updates,
- scoped evidence invalidation,
- targeted diagnostics,
- targeted tests first.

## 27.3 Escalation budget

Expensive behaviors must be conditional:

- full regression suite,
- deep call graph,
- parallel branches,
- maximum reasoning,
- critic ensemble.

---

# 28. Safety Requirements

The control plane must integrate with existing capability/sandbox policies.

A control-plane authorization must never override:

- sandbox denial,
- workspace jail,
- tool capability policy,
- approval requirements,
- host restrictions,
- immutable paths,
- protected files.

The hierarchy must be:

```text
Security Policy
    ↓
Control Plane
    ↓
Tool Execution
```

Never:

```text
Control Plane
    ↓
bypass security
```

---

# 29. Anti-Patterns to Avoid

## 29.1 Do not create four stronger independent modules

That recreates coordination conflicts.

## 29.2 Do not make EDCP one giant God Object

EDCP should orchestrate specialized engines through typed interfaces.

## 29.3 Do not let LLM text control state directly

Use structured tool/control outputs.

## 29.4 Do not equate more tokens with better reasoning

Escalation must change strategy.

## 29.5 Do not verify everything on every mutation

Use blast-radius-aware invalidation and targeted verification.

## 29.6 Do not let rollback depend on LLM memory

Checkpoint state must be explicit.

## 29.7 Do not rely on regex for core completion truth

Completion authority must use structured state.

## 29.8 Do not allow evidence without provenance

Every evidence record must identify:

- workspace state,
- mutation sequence,
- source,
- target,
- result.

---

# 30. Migration Strategy

Use compatibility adapters.

Temporary structure:

```text
old CriticGate
     ↓
EDCP CriticEngine

old HypothesisTracker
     ↓
EDCP HypothesisGraph

old AdaptiveReasoningController
     ↓
EDCP AdaptiveComputeController

old LoopProgressGuard
     ↓
EDCP ProgressController
```

After all call sites migrate:

```text
delete compatibility wrappers
```

Avoid big-bang replacement.

---

# 31. Recommended Implementation Order

Highest-value sequence:

```text
1. Workspace State
2. Evidence Freshness
3. Verification Contract
4. Green Checkpoints
5. Critic Engine
6. Hypothesis Graph
7. Progress Gradient
8. Strategy-Level Adaptive Reasoning
9. AgentLoop decomposition
10. Parallel hypothesis search
```

Do not implement parallel hypotheses before evidence freshness and transaction isolation are proven.

---

# 32. Success Metrics

Track before/after.

## Reliability

- completion-with-regression rate,
- stale-evidence completion rate,
- compiler-error completion rate,
- rollback success rate.

## Efficiency

- tool calls per completed task,
- repeated tool-call rate,
- average reasoning tier,
- unnecessary full-test rate,
- average tokens per successful task.

## Debugging quality

- average hypotheses per resolved bug,
- repeated falsified hypothesis rate,
- information-gain per investigation step,
- average failed mutation count before validated fix.

## Workspace quality

- unrelated changed-file count,
- rejected candidate residue count,
- post-task dirty-state anomalies.

---

# 33. Target Breakthroughs

When this plan succeeds, users should visibly observe:

1. **No fake completion**  
   Completion always includes current verification evidence.

2. **No stale-test claims**  
   A mutation automatically invalidates affected evidence.

3. **Cleaner diffs**  
   Failed speculative changes are rolled back.

4. **Less repetitive tool usage**  
   Zero-progress behavior triggers strategy switching.

5. **More disciplined debugging**  
   The agent tests explicit competing hypotheses.

6. **Adaptive intelligence**  
   Easy tasks stay cheap; difficult tasks change reasoning strategy.

7. **Lower regression rate**  
   Verification scope follows blast radius.

8. **Long-task stability**  
   Workspace truth, hypotheses, checkpoints, and evidence survive many turns.

9. **Auditable reasoning outcome**  
   The agent can show what evidence caused acceptance or rejection.

10. **Verified autonomous behavior**  
    The agent no longer trusts its own textual confidence.

---

# 34. Final Target Architecture Principle

The final Minus architecture should satisfy:

```text
LLM proposes.
Tools observe and act.
Workspace provides truth.
Evidence proves.
Critic decides.
Control Plane governs.
```

The desired end state is:

```text
              ┌────────────────────┐
              │        LLM         │
              │ hypothesis/candidate│
              └─────────┬──────────┘
                        │
                        ▼
         ┌───────────────────────────────┐
         │ Evidence-Driven Control Plane │
         │                               │
         │ Workspace State               │
         │ Verification Contracts        │
         │ Hypothesis Graph              │
         │ Evidence Ledger               │
         │ Green-State Transactions      │
         │ Progress Gradient             │
         │ Adaptive Compute              │
         │ Critic / Completion Authority │
         └───────────────┬───────────────┘
                         │
                         ▼
                VERIFIED WORKSPACE
```

At that point Minus is no longer primarily a chatbot that can modify code.

It becomes a **stateful, evidence-governed, self-correcting autonomous software-engineering system** whose accepted output is constrained by the actual state of the repository.

---

# 35. Definition of Done

The Evidence-Driven Control Plane project is complete only when all of the following are true:

- [ ] No final completion path bypasses EDCP.
- [ ] Every mutation increments a canonical mutation sequence.
- [ ] Every relevant mutation invalidates affected evidence.
- [ ] Every required verification result is bound to workspace state.
- [ ] Critic decisions consume structured evidence, not free-form confidence.
- [ ] Failed candidates can automatically return to the last green state.
- [ ] Falsified hypotheses cannot be blindly repeated.
- [ ] Stagnation causes strategy change.
- [ ] Reasoning escalation changes strategy, not only token budget.
- [ ] Low-risk tasks retain a fast path.
- [ ] High-risk tasks receive broader verification.
- [ ] AgentLoop no longer owns completion, rollback, escalation, and retry policy.
- [ ] Control-plane state is replayable and auditable.
- [ ] Completed tasks emit a verified completion report.
- [ ] End-to-end tests prove stale evidence cannot authorize completion.
- [ ] End-to-end tests prove broken candidates cannot replace a green checkpoint.
- [ ] End-to-end tests prove repeated zero-progress behavior is interrupted.
- [ ] End-to-end tests prove task completion is grounded in the current workspace state.

---

## Final Engineering Directive

Do not optimize this project around making the LLM appear more intelligent.

Optimize it around making the system **harder to fool, harder to derail, easier to verify, and safer to trust**.

The strongest form of Minus is not an LLM that says:

> "I believe the code is correct."

It is a system that can prove:

> **"The current workspace satisfies the required contract, the evidence is fresh, the candidate passed verification, and the repository is in a known green state."**
