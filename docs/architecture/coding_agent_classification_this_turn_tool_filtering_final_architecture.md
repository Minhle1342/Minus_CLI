# FINAL ARCHITECTURE SPEC
## Classification Engine + This-Turn Tool Filtering for a Safe, Fast, Token-Efficient Coding Agent

**Version:** 1.0  
**Status:** Implementation-ready architecture specification  
**Primary invariant:** **Hoàn thành Task Không Gây Ra Lỗi Code**  
**Primary optimization goals:**  
1. Hoàn thành task đúng yêu cầu.  
2. Không làm hỏng behavior hiện có.  
3. Giảm tối đa token không cần thiết.  
4. Giảm số tool call, step và turn không cần thiết.  
5. Đi tới final answer nhanh nhất có thể nhưng không đánh đổi correctness.  

---

# 1. Mục tiêu của tài liệu

Tài liệu này đóng gói các cơ chế mạnh nhất đã nghiên cứu từ các Coding Agent hiện đại thành một kiến trúc thống nhất, tập trung giải quyết **hai bài toán độc lập**:

1. **Classification**
   - Hiểu task hiện tại thuộc loại gì.
   - Xác định phase hiện tại.
   - Xác định mức rủi ro.
   - Xác định capability tối thiểu cần thiết.
   - Không trực tiếp quyết định tool cụ thể.

2. **This-Turn Tool Filtering**
   - Từ classification và state hiện tại, chỉ expose đúng subset tool cần thiết cho **turn hiện tại**.
   - Tool được phép ở turn trước không mặc định còn được phép ở turn sau.
   - Tách `tool relevance`, `tool permission`, `tool risk`, `tool execution safety`.

Hai engine này phải **độc lập về trách nhiệm** nhưng giao tiếp bằng một contract nhỏ, deterministic và dễ kiểm tra.

---

# 2. Nguyên tắc kiến trúc bất biến

## 2.1 Safety invariant

Mọi thao tác phải tuân thủ:

```text
Task Completion
        AND
No Regression
        AND
No Unverified Destructive Change
```

Một task chỉ được coi là `DONE` nếu:

```text
requested_behavior == satisfied
AND
relevant_tests == pass
AND
new_errors == 0
AND
unexpected_diff == 0
AND
critical_invariants == preserved
```

Không được đánh dấu hoàn thành chỉ vì:

- Code đã được viết.
- Tool trả về success.
- LLM "tin rằng" solution đúng.
- Test mới pass nhưng test cũ chưa chạy.
- Build chưa được xác minh.
- Diff chứa thay đổi ngoài scope.

---

## 2.2 Least Capability

LLM chỉ được cấp **capability nhỏ nhất cần cho bước hiện tại**.

Không:

```text
Task needs read
→ expose read + write + shell + git + database + network
```

Phải:

```text
Task needs read
→ expose read/search/symbol-navigation only
```

Nếu cần nâng quyền:

```text
READ
→ CODE_EDIT
```

thì phải qua **Capability Escalation**, không mở toàn bộ toolset.

---

## 2.3 Per-turn ephemeral permissions

`AllowedToolSet` là dữ liệu **ephemeral**.

```text
turn N allowed tools
        ↓
used / not used
        ↓
DISCARD
        ↓
reclassify
        ↓
turn N+1 allowed tools
```

Không cache quyền tool theo conversation một cách vô điều kiện.

---

## 2.4 Evidence over assumption

LLM không được sửa code chỉ dựa vào phỏng đoán nếu có thể thu thập bằng chứng rẻ hơn.

Ưu tiên:

```text
Repo Map
→ exact search
→ LSP/symbol graph
→ relevant file read
→ runtime/test evidence
→ implementation
```

Tránh:

```text
read many files
→ guess
→ edit
```

---

## 2.5 Fast-path trước, deep-path khi cần

Không phải task nào cũng cần Planner, Subagent, Repo Graph đầy đủ hay Reflection nhiều vòng.

Sử dụng:

```text
Simple task
→ Fast Path

Ambiguous / multi-file / risky task
→ Standard Path

Architecture / migration / cross-module / high-risk
→ Deep Path
```

Mục tiêu: **không biến safety thành bureaucracy**.

---

# 3. Các cơ chế mạnh nhất được kế thừa

| Coding Agent / System | Cơ chế được lấy | Vai trò trong kiến trúc cuối |
|---|---|---|
| Claude Code / Claude Tooling | Context-isolated subagents, deferred tool loading / tool search | Cô lập noise, không load toàn bộ tool schema |
| Gemini CLI | Priority policy engine, Plan Mode, task tracker/dependencies | Policy deterministic, phase restriction, external task state |
| OpenAI Codex | Sandbox, least-privilege escalation, shell command segmentation | Execution guard cuối cùng |
| Aider | Tree-sitter + graph-ranked Repository Map | Context compression và codebase topology |
| Cursor | Context-isolated Explore/Bash subagents, tool allowlist/disallowlist | Noise isolation, selective tool surface |
| Windsurf Cascade | Continuous planner tách strategic plan khỏi tactical action | Duy trì long-horizon intent khi task phức tạp |
| Cline | Plan/Act separation, per-call approval, checkpoints | Rollback code nhưng giữ learning/reasoning |
| Roo Code | Orchestrator/Boomerang tasks, role/mode specialization | Decomposition có kiểm soát |
| GitHub Copilot | Repository memory có citation và validation | Grounded memory chống stale knowledge |
| Zed | Independent agent threads + Git worktree isolation | Parallel hypothesis khi thật sự có lợi |
| OpenCode | Specialized agents, explicit permissions, LSP, compaction | Agent runtime modular, semantic code navigation |
| MiMo Code | Persistent memory, task progress, checkpoints, memory consolidation | Long-term continuity có kiểm soát |

Không copy nguyên một sản phẩm. Kiến trúc dưới đây lấy **cơ chế tốt nhất cho đúng loại logic mà nó giải quyết**.

---

# 4. Kiến trúc tổng thể

```text
                           USER REQUEST
                                │
                                ▼
                     ┌────────────────────┐
                     │ REQUEST NORMALIZER │
                     └─────────┬──────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │ 1. CLASSIFICATION ENGINE       │
              │                                │
              │ task class                     │
              │ phase                          │
              │ scope                          │
              │ minimum capabilities           │
              │ expected side effects          │
              │ risk                           │
              │ confidence                     │
              └───────────────┬────────────────┘
                              │ Decision Contract
                              ▼
              ┌────────────────────────────────┐
              │ 2. THIS-TURN TOOL FILTER       │
              │                                │
              │ phase gate                     │
              │ deferred tool retrieval        │
              │ deterministic policy           │
              │ risk filtering                 │
              │ redundancy pruning             │
              │ token-cost pruning             │
              └───────────────┬────────────────┘
                              │
                      3-7 exposed tools
                              │
                              ▼
                         ┌─────────┐
                         │ MAIN LLM│
                         └────┬────┘
                              │ concrete call
                              ▼
              ┌────────────────────────────────┐
              │ EXECUTION GUARD                │
              │                                │
              │ argument parser                │
              │ shell segmentation             │
              │ path boundary                  │
              │ sandbox                        │
              │ side-effect validation         │
              │ checkpoint                     │
              └───────────────┬────────────────┘
                              │
                              ▼
                         EXECUTION
                              │
                              ▼
                         OBSERVATION
                              │
                              ▼
                    STATE / EVIDENCE UPDATE
                              │
                ┌─────────────┴─────────────┐
                │                           │
          task complete?               task incomplete?
                │                           │
                ▼                           ▼
        VERIFICATION GATE              RECLASSIFY
                │                           │
                ▼                           └─────► next step
             FINAL
```

---

# 5. Hai engine phải độc lập

## 5.1 Classification Engine không được làm gì

Classification Engine:

- Không gọi `read_file`.
- Không gọi `shell`.
- Không gọi `git`.
- Không chọn tool cụ thể.
- Không sửa code.
- Không thực thi side effects.

Nó chỉ trả về semantic state.

## 5.2 Tool Filtering Engine không được làm gì

Tool Filtering Engine:

- Không tự diễn giải lại yêu cầu người dùng.
- Không tự quyết định task là bugfix hay feature.
- Không tự chuyển phase nếu không có state transition hợp lệ.
- Không dùng natural-language reasoning để override hard policy.

Nó nhận `ClassificationDecision` và tạo `AllowedToolSet`.

---

# 6. Decision Contract giữa hai engine

```ts
interface ClassificationDecision {
  taskClass:
    | "EXPLAIN"
    | "EXPLORE"
    | "BUGFIX"
    | "FEATURE"
    | "REFACTOR"
    | "TEST"
    | "REVIEW"
    | "MIGRATION"
    | "DEPENDENCY"
    | "CONFIG"
    | "RELEASE";

  phase:
    | "TRIAGE"
    | "EXPLORE"
    | "PLAN"
    | "IMPLEMENT"
    | "DEBUG"
    | "VERIFY"
    | "REVIEW"
    | "RELEASE"
    | "COMPLETE";

  complexity: "TRIVIAL" | "LOW" | "MEDIUM" | "HIGH";

  targetScope: {
    repository?: string;
    modules?: string[];
    files?: string[];
    symbols?: string[];
  };

  minimumCapabilities: Capability[];

  expectedEffects: Effect[];

  externality:
    | "NONE"
    | "WORKSPACE"
    | "LOCAL_SYSTEM"
    | "NETWORK"
    | "REMOTE_SYSTEM"
    | "PRODUCTION";

  reversibility:
    | "NONE"
    | "FULL"
    | "PARTIAL"
    | "UNKNOWN";

  risk:
    | "R0_READ_ONLY"
    | "R1_LOCAL_REVERSIBLE"
    | "R2_STRUCTURAL_LOCAL"
    | "R3_EXTERNAL_REVERSIBLE"
    | "R4_EXTERNAL_MUTATION"
    | "R5_CRITICAL";

  confidence: number;

  evidenceRequired: string[];

  fastPathEligible: boolean;
}
```

Contract này phải nhỏ hơn đáng kể so với conversation history.

---

# 7. Capability ontology

Tool name không được dùng làm capability.

Ví dụ `shell` có thể làm rất nhiều việc khác nhau.

Phải có ontology:

```text
CODE_READ
CODE_SEARCH
CODE_SYMBOL_NAVIGATION
CODE_GRAPH_QUERY

CODE_CREATE
CODE_EDIT
CODE_DELETE
CODE_MOVE

BUILD_RUN
TEST_RUN
LINT_RUN
TYPECHECK_RUN
STATIC_ANALYSIS

DEPENDENCY_READ
DEPENDENCY_INSTALL
DEPENDENCY_REMOVE

GIT_READ
GIT_LOCAL_WRITE
GIT_REMOTE_WRITE

WEB_READ
DOCS_READ

DATABASE_READ
DATABASE_WRITE
DATABASE_SCHEMA_WRITE

EXTERNAL_READ
EXTERNAL_WRITE

PROCESS_START
PROCESS_STOP

TASK_TRACKING
MEMORY_READ
MEMORY_WRITE

CHECKPOINT_CREATE
CHECKPOINT_RESTORE
```

---

# 8. Tool Registry

Mỗi tool phải được khai báo bằng metadata machine-readable.

```ts
interface ToolDescriptor {
  id: string;
  description: string;

  capabilities: Capability[];

  phaseCompatibility: Phase[];

  defaultRisk: RiskLevel;

  effects: Effect[];

  scope: {
    workspace: boolean;
    outsideWorkspace: boolean;
    network: boolean;
    remote: boolean;
  };

  reversible:
    | true
    | false
    | "ARGUMENT_DEPENDENT";

  deferLoading: boolean;

  estimatedSchemaTokens: number;

  estimatedExecutionCost: number;

  typicalLatencyClass:
    | "VERY_LOW"
    | "LOW"
    | "MEDIUM"
    | "HIGH";

  redundantWith?: string[];

  preferredOver?: string[];

  requiresCheckpoint?: boolean;

  requiresVerification?: boolean;
}
```

---

# 9. Classification Engine

# 9.1 Classification không phải một nhãn đơn

Sai:

```json
{
  "intent": "coding"
}
```

Đúng:

```json
{
  "taskClass": "BUGFIX",
  "phase": "EXPLORE",
  "complexity": "MEDIUM",
  "minimumCapabilities": [
    "CODE_READ",
    "CODE_SEARCH",
    "CODE_SYMBOL_NAVIGATION",
    "TEST_RUN"
  ],
  "expectedEffects": ["NONE"],
  "externality": "WORKSPACE",
  "risk": "R0_READ_ONLY",
  "confidence": 0.96,
  "fastPathEligible": false
}
```

---

# 9.2 Classification hierarchy

Classification chạy theo thứ tự rẻ → đắt:

```text
Layer A: Deterministic heuristics
    ↓
Layer B: Lightweight semantic classifier
    ↓ only if ambiguous
Layer C: Main-model semantic classification
```

Không gọi model lớn nếu regex/rules đủ chắc chắn.

## Layer A — deterministic

Dùng:

- explicit user verbs.
- current phase.
- file extension.
- known task state.
- command/result type.
- active diff state.
- test failure state.
- previous validated transition.

Ví dụ:

```text
"explain", "what does"
→ EXPLAIN

"review", "check code"
→ REVIEW

"fix failing test"
→ BUGFIX

state.testsFailed == true
→ DEBUG or VERIFY depending on cause
```

## Layer B — cheap classifier

Dùng model nhỏ/nhanh khi:

- task natural language phức tạp.
- yêu cầu chứa nhiều ý.
- scope chưa rõ.
- cần chọn giữa `FEATURE`, `REFACTOR`, `BUGFIX`.

Output phải là JSON strict schema.

## Layer C — main model

Chỉ dùng khi:

```text
classification_confidence < threshold
AND
classification materially changes allowed capabilities
```

---

# 9.3 Classification confidence

```text
>= 0.90
→ accept

0.75 - 0.89
→ conservative classification

< 0.75
→ do not grant mutation capability automatically
```

Conservative classification nghĩa là:

```text
uncertain BUGFIX vs FEATURE
→ grant EXPLORE capabilities
→ collect cheap evidence
→ classify again
```

Không cần hỏi user nếu hệ thống có thể tự resolve bằng read-only evidence với chi phí thấp.

---

# 10. Phase State Machine

```text
                 ┌────────┐
                 │ TRIAGE │
                 └───┬────┘
                     │
                     ▼
                ┌─────────┐
                │ EXPLORE │
                └────┬────┘
                     │
             enough evidence
                     ▼
                 ┌──────┐
                 │ PLAN │
                 └───┬──┘
                     │
              plan sufficiently
                 validated
                     ▼
              ┌───────────┐
              │ IMPLEMENT │
              └─────┬─────┘
                    │
               patch complete
                    ▼
                ┌────────┐
                │ VERIFY │
                └───┬────┘
                    │
             ┌──────┴──────┐
             │             │
           FAIL           PASS
             │             │
             ▼             ▼
          DEBUG          REVIEW
             │             │
             └────┐        │
                  ▼        ▼
              IMPLEMENT  COMPLETE
```

Không phải task nào cũng đi toàn bộ vòng.

---

# 11. Fast Path

Fast Path là bắt buộc để giảm turn và token.

Ví dụ task:

```text
"Đổi typo trong message error"
```

Nếu:

- exact file đã được user chỉ định.
- change <= small diff.
- không ảnh hưởng interface.
- no dependency change.
- no schema change.
- confidence cao.

Thì:

```text
TRIAGE
→ IMPLEMENT
→ VERIFY
→ COMPLETE
```

Bỏ:

```text
EXPLORE
PLAN
SUBAGENT
FULL REPO MAP
```

## Fast Path eligibility

```ts
fastPathEligible =
  confidence >= 0.95
  && targetScope.files.length <= 2
  && risk <= R1
  && noArchitectureChange
  && noPublicContractChange
  && noDependencyMutation
  && noDatabaseSchemaMutation;
```

---

# 12. Standard Path

Dùng cho:

- bug không rõ root cause.
- feature nhỏ/trung bình.
- refactor nhiều file có quan hệ.
- test failure.
- API behavior change.

```text
TRIAGE
→ targeted EXPLORE
→ micro PLAN
→ IMPLEMENT
→ VERIFY
→ REVIEW
→ COMPLETE
```

`micro PLAN` nên là structured state, không cần paragraph dài.

---

# 13. Deep Path

Chỉ dùng khi:

- migration.
- auth/security.
- cross-module architecture.
- schema/database.
- concurrency.
- public API contract.
- package/dependency upgrade lớn.
- nhiều subsystem.

```text
TRIAGE
→ Repo Map
→ Parallel Explore if beneficial
→ Plan
→ Dependency Task Graph
→ Checkpoint
→ Implement
→ Build/Test
→ Independent Verify
→ Review
→ Final
```

---

# 14. Aider-style Repository Map

Repo Map là cơ chế chính để giảm token code context.

Pipeline:

```text
Repository
   ↓
Tree-sitter / parser
   ↓
Symbols
   ↓
Definitions + references
   ↓
Dependency graph
   ↓
Graph ranking
   ↓
Relevant structural map
   ↓
LLM
```

Không gửi full codebase.

Repo Map nên chứa:

```text
file path
class/interface/function names
signatures
important constants
imports
dependencies
references
call relationships
```

Token budget mặc định:

```text
TRIVIAL: 0
LOW: 300-600
MEDIUM: 600-1200
HIGH: 1200-2500
```

Không cố định 1 giá trị.

---

# 15. LSP-first semantic navigation

Khi cần biết quan hệ code:

Ưu tiên:

```text
goToDefinition
findReferences
goToImplementation
documentSymbols
workspaceSymbols
callHierarchy
```

trước khi:

```text
grep everything
read entire directory
```

LSP cho semantic evidence có entropy thấp hơn raw text search.

---

# 16. Context-isolated subagents

Subagent chỉ được spawn nếu lợi ích > overhead.

## Spawn when

```text
expected_noise_tokens_saved
>
subagent_startup_tokens + handoff_tokens
```

Dùng cho:

- codebase exploration lớn.
- shell/log output rất dài.
- independent verification.
- hai hypothesis có thể kiểm tra song song.
- domain tách biệt.

Không dùng cho:

- rename nhỏ.
- single-file edit.
- một command build.
- tác vụ có thể giải bằng 1-2 tool call.

## Context contract của subagent

Parent gửi:

```text
Goal
Known evidence
Scope
Allowed capabilities
Expected output schema
Stop condition
```

Subagent trả:

```text
Findings
Evidence
Affected files/symbols
Confidence
Recommended next step
```

Không trả toàn bộ log nếu không cần.

---

# 17. Continuous Planner

Chỉ bật planner riêng khi `complexity == HIGH`.

Planner giữ:

```text
goal
constraints
dependencies
milestones
critical invariants
remaining work
```

Executor chỉ giữ:

```text
current step
current files
current evidence
current tool output
```

Planner không tham gia từng edit nhỏ.

Re-plan chỉ khi:

```text
new evidence invalidates plan
OR
test failure changes root cause
OR
scope expands materially
```

Không re-plan mỗi turn.

---

# 18. Task Graph

Task Graph dùng cho task nhiều dependency.

```text
T1 Analyze schema
  ↓
T2 Update domain
  ↓
T3 Service change
 ├────────► T4 API
 └────────► T5 tests
                ↓
              T6 verify
```

LLM không phải nhớ trạng thái bằng prose.

Mỗi node:

```ts
interface TaskNode {
  id: string;
  objective: string;
  dependsOn: string[];
  status: "BLOCKED" | "READY" | "ACTIVE" | "DONE" | "FAILED";
  evidence?: string[];
  affectedScope?: string[];
}
```

Task Graph phải nằm ngoài context và chỉ inject phần cần thiết.

---

# 19. Grounded Memory

Memory không được là một file "facts" không kiểm chứng.

Mỗi memory:

```ts
interface GroundedMemory {
  fact: string;
  evidence: EvidenceRef[];
  repositoryRevision?: string;
  createdAt: string;
  lastValidatedAt?: string;
  confidence: number;
  scope: string[];
}
```

Khi retrieve:

```text
memory candidate
    ↓
validate citation / code evidence
    ↓
valid?
 ┌──┴──┐
yes   no
 │     │
use  discard/update
```

Ưu tiên memory:

- coding conventions.
- architecture decisions.
- build/test commands.
- project invariants.
- recurring cross-file constraints.

Không lưu:

- temporary error output.
- transient implementation guess.
- stale task-specific detail.

---

# 20. Classification output → This-Turn Tool Filter

Tool Filter nhận:

```text
ClassificationDecision
+
AgentState
+
PolicySet
+
ToolRegistry
```

và trả:

```ts
interface ThisTurnToolDecision {
  allowedTools: ToolExposure[];
  deniedTools?: string[];
  approvalRequired?: string[];
  maxToolCallsThisTurn: number;
  reasonCodes: string[];
}
```

---

# 21. This-Turn Tool Filtering Pipeline

```text
Registered Tool Universe
       │
       ▼
1. Phase Gate
       │
       ▼
2. Capability Match
       │
       ▼
3. Deferred Tool Retrieval
       │
       ▼
4. Policy Engine
       │
       ▼
5. Risk Filter
       │
       ▼
6. Redundancy Pruning
       │
       ▼
7. Cost/Latency Pruning
       │
       ▼
8. Top-K Selection
       │
       ▼
THIS-TURN TOOL SET
```

---

# 22. Phase Gate

Example:

## EXPLORE

Allow capabilities:

```text
CODE_READ
CODE_SEARCH
CODE_SYMBOL_NAVIGATION
CODE_GRAPH_QUERY
DOCS_READ
GIT_READ
```

Deny by default:

```text
CODE_EDIT
CODE_DELETE
DEPENDENCY_INSTALL
GIT_REMOTE_WRITE
DATABASE_WRITE
```

## IMPLEMENT

```text
CODE_READ
CODE_SEARCH
CODE_SYMBOL_NAVIGATION
CODE_EDIT
BUILD_RUN
TARGETED_TEST_RUN
```

## VERIFY

```text
BUILD_RUN
TEST_RUN
LINT_RUN
TYPECHECK_RUN
STATIC_ANALYSIS
GIT_READ
```

Edit tools có thể tạm remove ở VERIFY để buộc observation trước khi repair.

## RELEASE

```text
GIT_READ
GIT_LOCAL_WRITE
GIT_REMOTE_WRITE
CI
PR
```

High-risk action vẫn cần policy riêng.

---

# 23. Deferred Tool Loading

Tool schema không liên quan không được inject vào model context.

Ví dụ registry 100 tools:

```text
Initial visible:
- read_file
- grep
- find_symbol
- tool_search
```

Nếu cần database:

```text
tool_search(
  capabilities=[
    "DATABASE_READ"
  ]
)
```

mới load schema:

```text
db_query
db_schema
```

Không load:

```text
db_drop
db_migrate
```

nếu classification chỉ yêu cầu read.

---

# 24. Hybrid Tool Retrieval

Không dùng chỉ embedding search.

Score:

```text
ToolRetrievalScore =
    CapabilityExactMatch
  + SemanticMatch
  + PhaseMatch
  + ScopeMatch
  + HistoricalSuccess
```

Nguồn:

```text
exact capability tags
BM25
embedding retrieval
regex/name matching
usage statistics
```

---

# 25. Tool Ranking

Suggested baseline:

```text
Score(t) =
  0.30 * CapabilityMatch
+ 0.20 * SemanticRelevance
+ 0.15 * PhaseCompatibility
+ 0.10 * ScopeCompatibility
+ 0.10 * HistoricalSuccess
+ 0.05 * LocalityPreference
+ 0.05 * Reversibility
+ 0.05 * TokenEfficiency

- RiskPenalty
- RedundancyPenalty
- LatencyPenalty
```

Hard DENY không đi qua score.

---

# 26. Tool count budget

Mục tiêu:

```text
normal turn: 3-7 tools
simple turn: 1-4 tools
complex turn: <= 10 tools
```

Nếu cần >10:

- tool taxonomy có vấn đề.
- retrieval quá rộng.
- phase classification chưa đủ cụ thể.
- tool abstraction quá nhỏ.

---

# 27. Policy Engine

Policy là deterministic authority.

```text
ADMIN
  >
ORGANIZATION
  >
PROJECT
  >
AGENT ROLE
  >
TASK
  >
TURN
```

Decision:

```text
ALLOW
ASK
DENY_SOFT
DENY_HARD
```

`DENY_HARD` không được semantic classifier override.

---

# 28. Policy matching

Rule có thể match:

```text
tool id
capability
phase
argument pattern
path
repository
environment
network
external target
approval mode
risk
```

Ví dụ:

```toml
[[rule]]
capability = "GIT_REMOTE_WRITE"
decision = "ASK"
priority = 800
```

```toml
[[rule]]
tool = "shell"
argsPattern = "^git status$"
decision = "ALLOW"
priority = 900
```

---

# 29. Argument-aware classification

Không classify:

```text
shell = risky
```

Phải classify concrete call:

```text
shell("git status")
→ R0_READ_ONLY

shell("npm test")
→ R1_LOCAL_REVERSIBLE

shell("npm install x")
→ R2_STRUCTURAL_LOCAL

shell("git push")
→ R4_EXTERNAL_MUTATION
```

---

# 30. Shell command segmentation

Một command:

```bash
git status && npm test && git push
```

phải tách:

```text
segment 1: git status
segment 2: npm test
segment 3: git push
```

Mỗi segment được evaluate riêng.

Không cho một safe prefix che một unsafe suffix.

Parser phải xử lý tối thiểu:

```text
|
&&
||
;
(...)
$()
```

và shell-specific syntax tương ứng.

---

# 31. Semantic Risk Classifier

Chỉ dùng sau hard rules.

Input:

```text
tool
arguments
phase
target paths
git state
network target
workspace boundaries
user intent summary
expected effect
```

Output:

```json
{
  "effect": "LOCAL_MUTATION",
  "risk": "R1_LOCAL_REVERSIBLE",
  "reversible": true,
  "confidence": 0.94
}
```

Không dùng classifier như security authority cuối cùng.

---

# 32. Risk ontology

```text
R0_READ_ONLY
    read/search/status

R1_LOCAL_REVERSIBLE
    source patch inside workspace

R2_STRUCTURAL_LOCAL
    dependency install
    generated migration
    build configuration change

R3_EXTERNAL_REVERSIBLE
    create draft PR
    create remote branch

R4_EXTERNAL_MUTATION
    push
    remote write
    database data update

R5_CRITICAL
    production mutation
    destructive schema change
    irreversible external action
```

---

# 33. Tool Necessity Proof

Trước khi expose capability mutation có risk >= R2:

```text
Why is this capability necessary NOW?
```

Machine-check:

```ts
function capabilityNecessary(
  capability: Capability,
  phase: Phase,
  decision: ClassificationDecision
): boolean
```

Ví dụ:

```text
phase = DEBUG
requested capability = GIT_REMOTE_WRITE

→ not necessary now
→ do not expose
```

Không deny forever. Chỉ `NOT_THIS_TURN`.

---

# 34. Capability Escalation

Nếu LLM cần capability chưa có:

```text
current: CODE_READ
requested: CODE_EDIT
```

Nó phải tạo:

```ts
interface CapabilityEscalationRequest {
  capability: Capability;
  justification: string;
  targetScope: string[];
  expectedEffect: Effect[];
  reversible: boolean;
}
```

Router evaluate:

```text
necessary?
within scope?
policy allows?
risk acceptable?
checkpoint available?
```

Sau đó cấp **capability tối thiểu**.

Ví dụ cấp:

```text
apply_patch scope=src/auth/**
```

thay vì:

```text
shell unrestricted
```

---

# 35. Execution Guard

Tool đã được expose vẫn chưa đồng nghĩa được execute.

```text
LLM tool call
     ↓
Schema validation
     ↓
Argument normalization
     ↓
Policy re-check
     ↓
Path boundary
     ↓
Command segmentation
     ↓
Side-effect inspection
     ↓
Checkpoint requirement
     ↓
Sandbox
     ↓
Execute
```

Đây là defense-in-depth.

---

# 36. Checkpoint strategy

Checkpoint không tạo sau mọi read.

Tạo trước:

```text
multi-file mutation
dependency changes
migration generation
automated refactor
risky command
large patch
```

Không cần cho:

```text
read
grep
git status
test
lint
```

Checkpoint metadata:

```ts
interface Checkpoint {
  id: string;
  gitHead: string;
  dirtyDiffHash: string;
  affectedFiles: string[];
  reason: string;
  createdAt: string;
}
```

---

# 37. Rollback giữ reasoning

Nếu implementation fail:

```text
Conversation/evidence:
KEEP

Bad workspace state:
ROLLBACK
```

Điều này cho phép:

```text
failure information preserved
+
failure state discarded
```

Không mất token để khám phá lại cùng lỗi.

---

# 38. Verification Engine

Verification không chỉ là `run tests`.

Chọn evidence dựa vào diff.

```text
Diff Impact Analysis
      ↓
Verification Plan
```

Ví dụ:

### Single pure function

```text
targeted tests
typecheck if applicable
```

### API endpoint

```text
unit/service tests
controller/integration test
schema/serialization check
```

### shared library/core

```text
targeted tests
affected-module tests
broader regression suite
```

### dependency/config

```text
install/resolve
build
test
startup smoke
```

---

# 39. Verification pyramid tối ưu chi phí

Không chạy full suite đầu tiên.

```text
1. syntax / parse
2. typecheck / compile affected module
3. targeted tests
4. affected regression tests
5. full suite only if impact/risk requires
```

Fail sớm → sửa sớm → ít token/tool call.

---

# 40. Regression invariant

Trước change, thu thập baseline khi cần:

```text
existing test state
existing build state
current git diff
known diagnostics
```

Sau change:

```text
new failures must not exceed baseline
```

Nếu repo vốn đã có lỗi:

```text
do not claim "all tests pass"
```

Phải phân biệt:

```text
pre-existing failures
new failures caused by patch
```

---

# 41. Independent verification

Không luôn dùng reviewer subagent.

Chỉ khi:

```text
risk >= R2
OR
complexity == HIGH
OR
public contract changed
OR
security/auth
OR
large refactor
```

Verifier nhận:

```text
original requirement
final diff
test evidence
critical invariants
```

Không cần toàn conversation.

---

# 42. Review Gate

Review checks:

```text
scope creep
unexpected file changes
dead code
duplicate logic
API compatibility
error handling
tests
security-sensitive paths
performance regressions if relevant
```

Reject final if:

```text
unexpected_diff != 0
```

---

# 43. Token Budget Controller

Token cost phải là first-class signal.

```ts
interface TokenBudget {
  system: number;
  toolSchemas: number;
  repoMap: number;
  activeFiles: number;
  observations: number;
  memory: number;
  reasoningReserve: number;
}
```

Suggested policy:

```text
tool schemas          <= 8-12% context
repo map              <= 5-10%
memory                <= 5%
raw observations      <= 15%
active code/context   dynamic
reasoning reserve     protected
```

Các tỷ lệ là baseline tuning, không phải hard universal constants.

---

# 44. Token-saving mechanisms

## 44.1 Deferred schemas

Không inject tool không dùng.

## 44.2 Repo Map

Không inject full repo.

## 44.3 Observation compression

Command output:

```text
5000 lines
```

không tự động đẩy toàn bộ sang main context.

Giữ:

```text
exit code
relevant errors
top stack frames
failure summary
artifact reference
```

## 44.4 Context-isolated noisy tools

Shell/browser/explore output dài → subagent/context riêng.

## 44.5 Grounded memory

Không giải thích lại architecture mỗi session.

## 44.6 Task state externalization

Không lặp lại todo list bằng prose.

---

# 45. Tool-call budget

Mỗi phase có budget mềm:

```text
TRIAGE:     0-2
EXPLORE:    1-5
PLAN:       0-2
IMPLEMENT:  1-4
VERIFY:     1-4
REVIEW:     0-3
```

Không phải giới hạn tuyệt đối.

Nếu vượt budget:

```text
agent must ask internally:
- am I looping?
- am I reading redundant data?
- should I switch search strategy?
- is the task misclassified?
```

---

# 46. Stop conditions

## EXPLORE stop

Stop khi có đủ:

```text
root cause OR implementation target
+
affected dependency path
+
verification strategy
```

Không đọc thêm "cho chắc" nếu marginal information gain thấp.

## IMPLEMENT stop

Stop khi:

```text
minimal complete patch exists
```

Không refactor ngoài scope.

## VERIFY stop

Stop khi required evidence đã pass.

Không chạy thêm 5 lần cùng test nếu state không đổi.

---

# 47. Information Gain heuristic

Mỗi read/search mới nên ước lượng:

```text
ExpectedInformationGain
/
TokenCost
```

Nếu thấp:

```text
skip
```

Ví dụ đã biết exact symbol + references:

```text
grep entire repo again
→ low gain
```

---

# 48. Search ladder

Luôn dùng search rẻ nhất đủ chính xác:

```text
1. Repo Map
2. exact filename/symbol
3. LSP
4. grep
5. semantic search
6. broader repository exploration
7. subagent exploration
```

Không mặc định semantic/RAG cho mọi query.

---

# 49. Read ladder

```text
symbol range
→ relevant function
→ relevant class
→ relevant file section
→ whole file
→ adjacent files
```

Không đọc whole files trước nếu parser/LSP cho range chính xác.

---

# 50. Minimal Patch Principle

Implementation phải tối thiểu nhưng hoàn chỉnh.

Score patch:

```text
Correctness
+
Requirement Coverage
+
Compatibility
-
Unnecessary Changed Lines
-
Unrelated Refactor
-
New Dependencies
```

Không tối ưu "ít dòng" đến mức hack.

Mục tiêu:

```text
smallest semantically complete change
```

---

# 51. Dependency mutation rule

Không thêm dependency nếu:

```text
existing project capability can solve task
```

Nếu cần dependency mới:

```text
classify R2
→ justify necessity
→ inspect project package policy
→ checkpoint
→ install
→ lockfile review
→ build/test
```

---

# 52. Database/schema rule

Schema mutation luôn:

```text
risk >= R2
```

Phải kiểm tra:

```text
migration strategy
backward compatibility
data preservation
rollback path
application compatibility
tests
```

Production DB write không thuộc normal coding workflow.

---

# 53. Git strategy

Git read:

```text
status
diff
log
show
```

→ low risk.

Git local mutations:

```text
add
commit
checkout local
```

→ policy controlled.

Git remote mutations:

```text
push
PR merge
remote delete
```

→ separate capability and higher risk.

Không gộp `git` thành 1 permission.

---

# 54. Parallelism rule

Parallelism chỉ dùng nếu:

```text
tasks are independent
AND
expected wall-clock saving significant
AND
token overhead acceptable
```

Không spawn 5 agents để đọc 5 file nhỏ.

Nếu nhiều agent có thể edit overlap:

```text
use isolated worktrees
```

---

# 55. Worktree isolation

Dùng khi:

- multiple implementation hypotheses.
- independent refactors.
- parallel agents on adjacent code.
- experimental fixes.

Mỗi agent:

```text
own branch
own workspace
own context
```

Parent merge only after verification.

---

# 56. Reflection / Self-Critique

Reflection phải ngắn và evidence-based.

Không:

```text
"Think deeply about whether solution is correct..."
```

Phải check structured:

```json
{
  "requirementCovered": true,
  "unexpectedDiff": false,
  "testsPassed": true,
  "newDiagnostics": 0,
  "unverifiedAssumptions": [],
  "rollbackNeeded": false
}
```

Chỉ gọi stronger reviewer khi structured checks phát hiện uncertainty.

---

# 57. Reclassification

Sau mỗi **meaningful state transition**, không phải mỗi token:

```text
tool result changes root cause
patch applied
test failed
test passed
scope changed
policy escalation requested
```

Run:

```text
classify(currentState)
→ regenerate allowed tool set
```

---

# 58. Example — bugfix

User:

```text
"Fix endpoint login returning 403."
```

## Step 1 — Classification

```json
{
  "taskClass": "BUGFIX",
  "phase": "EXPLORE",
  "complexity": "MEDIUM",
  "minimumCapabilities": [
    "CODE_READ",
    "CODE_SEARCH",
    "CODE_SYMBOL_NAVIGATION"
  ],
  "risk": "R0_READ_ONLY"
}
```

## Step 2 — Tool Filter

Expose:

```text
repo_map
find_symbol
find_references
read_file_range
```

Do not expose:

```text
edit
git_push
dependency_install
db_write
```

## Step 3 — Evidence

Find:

```text
JwtFilter → UserDetails → DepartmentGuard
```

Root cause confirmed.

## Step 4 — Reclassify

```text
phase = IMPLEMENT
risk = R1
capability += CODE_EDIT
```

Expose:

```text
read_file_range
apply_patch
targeted_test
```

## Step 5

Patch.

## Step 6 — Reclassify VERIFY

Expose:

```text
compile
targeted_test
git_diff
```

Remove normal edit tool temporarily.

## Step 7

If tests pass + diff clean:

```text
COMPLETE
```

If fail:

```text
DEBUG
→ expose diagnostics + edit
```

---

# 59. Example — explain code

User:

```text
"Giải thích AuthService hoạt động thế nào."
```

Classification:

```text
EXPLAIN
EXPLORE
R0
fastPath=true
```

Tool set:

```text
repo_map
find_symbol
read_file_range
find_references
```

No:

```text
edit
test
shell
git write
```

Final after minimal evidence.

---

# 60. Example — rename

User:

```text
"Rename calculateTotalLocketAmount to calculateTotalLockedAmount."
```

If symbol + language server available:

```text
find_symbol
find_references
rename_symbol
typecheck
targeted_test
git_diff
```

Không cần:

```text
planner
web
subagent
repo semantic search
```

---

# 61. Example — architecture migration

User:

```text
"Migrate authentication from custom JWT to OAuth2."
```

Classification:

```text
FEATURE/MIGRATION
HIGH
PLAN
R2+
```

Activate:

```text
repo map
LSP
grounded memory
continuous planner
task graph
explore subagents if beneficial
checkpoint
```

Implementation split by dependency graph.

Independent verify required.

---

# 62. Main Agent Loop

```ts
async function runTask(request: UserRequest) {
  const state = initializeState(request);

  while (!state.complete) {
    const classification = await classify(state);

    const toolSet = await filterTools({
      classification,
      state,
      registry,
      policies
    });

    const action = await mainLLM.nextAction({
      compactContext: buildContext(state),
      allowedTools: toolSet
    });

    if (action.type === "FINAL") {
      if (await completionGate(state, action)) {
        state.complete = true;
        return action;
      }

      state.phase = inferMissingVerificationPhase(state);
      continue;
    }

    const guarded = await executionGuard(action, state, policies);

    if (!guarded.allowed) {
      state.addObservation(guarded.reason);
      continue;
    }

    const result = await execute(guarded.action);
    state.applyObservation(result);

    updateTaskGraph(state);
    updateEvidence(state);
    compactNoise(state);
  }
}
```

---

# 63. Classification pseudocode

```ts
async function classify(
  state: AgentState
): Promise<ClassificationDecision> {

  const deterministic = deterministicClassifier(state);

  if (deterministic.confidence >= 0.95) {
    return deterministic;
  }

  const cheap = await lightweightClassifier(
    buildClassificationContext(state)
  );

  if (cheap.confidence >= 0.90) {
    return mergeConservatively(deterministic, cheap);
  }

  // Mutation must not be granted from low-confidence inference.
  if (cheap.risk >= R1_LOCAL_REVERSIBLE) {
    return downgradeToExplore(cheap);
  }

  return cheap;
}
```

---

# 64. This-Turn Tool Filtering pseudocode

```ts
async function filterTools(input): Promise<ThisTurnToolDecision> {
  const { classification, state, registry, policies } = input;

  let candidates = registry.all();

  // 1. phase
  candidates = phaseGate(candidates, classification.phase);

  // 2. capability
  candidates = candidates.filter(tool =>
    overlaps(tool.capabilities, classification.minimumCapabilities)
  );

  // 3. retrieve deferred
  candidates = await hybridRetrieve(
    candidates,
    classification,
    state
  );

  // 4. deterministic policy
  candidates = applyHardPolicies(candidates, policies, state);

  // 5. necessity
  candidates = candidates.filter(tool =>
    isNecessaryThisTurn(tool, classification, state)
  );

  // 6. risk
  candidates = applyRiskRules(candidates, classification, state);

  // 7. redundancy
  candidates = removeRedundantTools(candidates);

  // 8. rank
  candidates = rankTools(candidates, classification, state);

  // 9. token budget
  candidates = fitToolSchemaBudget(candidates, state.tokenBudget);

  // 10. top-K
  return {
    allowedTools: candidates.slice(
      0,
      chooseK(classification)
    ),
    maxToolCallsThisTurn:
      chooseToolCallBudget(classification)
  };
}
```

---

# 65. Execution Guard pseudocode

```ts
async function executionGuard(action, state, policies) {
  validateSchema(action);

  const normalized = normalizeArguments(action);

  const segments =
    action.tool === "shell"
      ? parseShellIntoSegments(normalized)
      : [normalized];

  for (const segment of segments) {
    const risk = classifyConcreteEffect(segment, state);

    const policy = evaluatePolicy({
      tool: action.tool,
      args: segment,
      risk,
      state
    });

    if (policy === "DENY_HARD") {
      return deny("hard-policy");
    }

    if (policy === "ASK") {
      return requestApproval(segment);
    }

    if (needsCheckpoint(segment, risk)) {
      await ensureCheckpoint(state);
    }

    enforceWorkspaceBoundary(segment);
    enforceSandbox(segment, risk);
  }

  return allow(action);
}
```

---

# 66. Context Builder

Main LLM context nên được build theo priority:

```text
1. Current user goal
2. Critical invariants
3. Current phase + task state
4. Relevant grounded memories
5. Relevant repo map slice
6. Active code snippets
7. Latest useful observations
8. Allowed tool schemas
```

Không ưu tiên chronology.

Context phải là:

```text
relevance-oriented
```

không phải:

```text
conversation-dump-oriented
```

---

# 67. Observation compression

Raw:

```text
npm test
→ 12,000 tokens logs
```

Compressed:

```json
{
  "command": "npm test",
  "exitCode": 1,
  "passed": 184,
  "failed": 2,
  "failures": [
    {
      "test": "AuthServiceTest.loginExpiredToken",
      "error": "Expected 401, got 500",
      "topFrame": "AuthService.java:142"
    }
  ]
}
```

Raw artifact có thể lưu ngoài active context.

---

# 68. Completion Gate

```ts
async function completionGate(state, proposedFinal) {
  return (
    requirementsSatisfied(state) &&
    noUnresolvedCriticalEvidence(state) &&
    noUnexpectedDiff(state) &&
    verificationSufficient(state) &&
    noNewDiagnostics(state) &&
    noPendingRequiredTaskNodes(state)
  );
}
```

Final answer không cần tool call nếu gate đã pass.

---

# 69. No-unnecessary-turn rule

Agent không được hỏi user khi:

```text
missing information can be safely discovered
with low-cost read-only tools
```

Agent nên hỏi khi:

```text
multiple valid product decisions
cannot be inferred from repository
AND
decision changes behavior materially
```

Không dùng clarification để tránh làm việc.

---

# 70. No-unnecessary-step rule

Mỗi step phải thuộc ít nhất một nhóm:

```text
Acquire necessary evidence
Mutate required state
Verify correctness
Protect against regression
```

Nếu không thuộc nhóm nào → bỏ.

---

# 71. Model routing

Không dùng strongest LLM cho mọi logic.

Suggested:

```text
deterministic classifier
→ no LLM

semantic task classifier
→ cheap/fast model

repo exploration
→ fast model/subagent

main implementation
→ strongest coding model

independent verification
→ strong model only for risky/complex task

memory consolidation
→ cheap scheduled model
```

---

# 72. Cost function

Có thể tối ưu agent trajectory theo:

```text
Utility =
    Correctness
  + RequirementCoverage
  + RegressionSafety
  - λ1 * TokenCost
  - λ2 * ToolCalls
  - λ3 * Turns
  - λ4 * Latency
  - λ5 * Risk
```

Nhưng:

```text
Correctness
RegressionSafety
```

là hard constraints, không chỉ weight mềm.

---

# 73. Trajectory optimizer

Trước mỗi optional action:

```ts
if (
  expectedBenefit(action)
  <=
  expectedCost(action)
  && !requiredForSafety(action)
) {
  skip(action);
}
```

Ví dụ:

- Full test suite sau targeted tests pass:
  - chỉ chạy nếu impact yêu cầu.
- Spawn reviewer:
  - chỉ nếu risk/complexity đạt threshold.
- Web search:
  - chỉ khi local repo/docs không đủ hoặc dependency behavior cần verify.

---

# 74. Caching strategy

Cache:

```text
Repo Map by git tree hash
LSP symbol graph by file hash
Tool retrieval index
Build dependency graph
validated project memories
tool policy compilation
```

Invalidate bằng:

```text
changed files
git revision
config/policy changes
dependency lock changes
```

Không recompute mọi turn.

---

# 75. Prompt caching

Tool schema ổn định nên:

- core tools nằm stable prefix.
- deferred tools không nằm prefix.
- project rules/memory được version/hash.
- dynamic state nằm late context.

Mục tiêu:

```text
high cache hit rate
+
low dynamic prompt churn
```

---

# 76. Suggested internal modules

```text
agent-core/
├── classifier/
│   ├── deterministic-classifier.ts
│   ├── semantic-classifier.ts
│   ├── confidence.ts
│   └── schemas.ts
│
├── state/
│   ├── phase-machine.ts
│   ├── task-graph.ts
│   └── agent-state.ts
│
├── context/
│   ├── repo-map.ts
│   ├── lsp-context.ts
│   ├── context-builder.ts
│   ├── observation-compressor.ts
│   └── token-budget.ts
│
├── memory/
│   ├── grounded-memory.ts
│   ├── validator.ts
│   └── retriever.ts
│
├── tools/
│   ├── registry.ts
│   ├── ontology.ts
│   ├── retriever.ts
│   ├── ranker.ts
│   └── this-turn-filter.ts
│
├── policy/
│   ├── engine.ts
│   ├── matcher.ts
│   ├── risk.ts
│   └── escalation.ts
│
├── execution/
│   ├── guard.ts
│   ├── shell-parser.ts
│   ├── sandbox.ts
│   ├── checkpoint.ts
│   └── rollback.ts
│
├── verification/
│   ├── impact-analysis.ts
│   ├── test-selector.ts
│   ├── regression-gate.ts
│   └── completion-gate.ts
│
├── agents/
│   ├── orchestrator.ts
│   ├── explorer.ts
│   ├── planner.ts
│   ├── implementer.ts
│   └── verifier.ts
│
└── runtime/
    ├── agent-loop.ts
    ├── trajectory-optimizer.ts
    └── telemetry.ts
```

---

# 77. Suggested configuration

```yaml
classification:
  deterministicConfidence: 0.95
  semanticAcceptConfidence: 0.90
  mutationMinConfidence: 0.90

tools:
  defaultTopK: 5
  maxTopK: 10
  deferredLoading: true
  maxSchemaContextPercent: 10

execution:
  sandbox: true
  workspaceBoundary: true
  segmentShellCommands: true
  checkpointRiskThreshold: R2_STRUCTURAL_LOCAL

verification:
  requireForMutation: true
  targetedFirst: true
  independentVerifierRiskThreshold: R2_STRUCTURAL_LOCAL

optimization:
  fastPath: true
  skipRedundantReads: true
  reuseValidatedEvidence: true
  compressToolOutput: true
  cacheRepoMap: true
```

---

# 78. Telemetry cần đo

Không thể tối ưu nếu không đo.

## Quality

```text
task success rate
regression rate
build-pass-after-final
test-pass-after-final
rollback rate
unexpected diff rate
```

## Cost

```text
input tokens/task
output tokens/task
tool schema tokens/task
tool calls/task
LLM calls/task
subagent calls/task
```

## Speed

```text
time to first useful action
time to root cause
time to verified patch
turns to completion
```

## Classification

```text
phase accuracy
risk accuracy
capability recall
capability overexposure rate
```

## Tool Filter

```text
tool selection accuracy
unused exposed tools
denied dangerous call rate
escalation rate
average visible tools/turn
```

---

# 79. Core optimization KPIs

Target direction:

```text
Regression Rate                → 0
Unexpected Diff Rate           → 0
Unverified Final Rate          → 0

Avg Visible Tools / Turn       ↓
Tool Schema Tokens / Task      ↓
Redundant Reads / Task         ↓
Tool Calls / Task              ↓
Turns / Task                   ↓
Tokens / Successful Task       ↓

First-Pass Verification Rate   ↑
Correct Tool First-Choice      ↑
Fast-Path Completion Rate      ↑
```

---

# 80. Test matrix — Classification

## C1 Explain task

Input:

```text
Explain PaymentService.
```

Expected:

```text
class = EXPLAIN
phase = EXPLORE
risk = R0
no mutation capability
```

## C2 Exact typo

Input:

```text
Change "recieve" to "receive" in X.ts.
```

Expected:

```text
fastPath=true
phase=IMPLEMENT
risk=R1
```

## C3 Unknown bug

Expected start:

```text
BUGFIX
EXPLORE
R0
```

not immediate broad write access.

## C4 Migration

Expected:

```text
HIGH
PLAN
R2+
fastPath=false
```

---

# 81. Test matrix — Tool Filtering

## T1 Read-only turn

Must not expose:

```text
delete_file
git_push
db_write
dependency_install
```

## T2 Verify turn

Prefer:

```text
test
build
lint
diff
```

over edit tools.

## T3 Deferred MCP

100 MCP tools registered.

Expected visible:

```text
<= 7 relevant tools
```

not 100.

## T4 Tool redundancy

If:

```text
LSP.findReferences
grep
semanticSearch
```

all available for exact symbol reference query:

Prefer:

```text
LSP.findReferences
```

with backups only if evidence insufficient.

---

# 82. Test matrix — Execution Guard

## E1 Composite shell

```bash
git status && npm test && git push
```

Must evaluate 3 segments independently.

## E2 Workspace escape

```text
write ../../outside/file
```

Must block unless explicit allowed scope.

## E3 Destructive command

Must require appropriate policy/escalation regardless of model classification.

---

# 83. Test matrix — Regression

## R1 Existing failing tests

Pre-existing:

```text
2 failures
```

After patch:

```text
same 2 failures
```

Agent must state:

```text
no new failure observed
```

not:

```text
all tests pass
```

## R2 New failure

Before:

```text
0
```

After:

```text
1
```

Completion gate must fail.

---

# 84. Acceptance Criteria

Architecture is accepted only if:

- [ ] Classification and This-Turn Tool Filtering are separate modules.
- [ ] Classification output uses strict structured schema.
- [ ] Tool permissions are regenerated per turn/meaningful state transition.
- [ ] Mutation tools are absent in read-only phases unless explicit exception.
- [ ] Deferred tool schemas are supported.
- [ ] Average tool surface is configurable and bounded.
- [ ] Deterministic policy overrides semantic classifier.
- [ ] Shell commands are parsed/segmented before execution.
- [ ] Sandbox/workspace boundaries exist.
- [ ] Checkpoints exist for risky local mutations.
- [ ] Failed implementation can rollback without losing reasoning/evidence.
- [ ] Repo Map or equivalent structural compression exists.
- [ ] LSP/symbol navigation is preferred for semantic relations.
- [ ] Grounded memory validates evidence before use.
- [ ] Verification is mandatory for code mutation.
- [ ] Completion gate prevents unverified final answers.
- [ ] Fast Path skips unnecessary planning/subagents for trivial tasks.
- [ ] Tool output compression prevents raw logs from polluting context.
- [ ] Task state is externalized for complex jobs.
- [ ] Telemetry measures token cost, steps, turns, regressions and tool exposure.
- [ ] No task is declared done with a known new regression.

---

# 85. Non-goals

Không xây:

- Một agent luôn spawn nhiều subagent.
- Một planner luôn hoạt động.
- Một giant system prompt.
- Một tool registry luôn inject toàn bộ.
- Một policy hoàn toàn dựa vào LLM.
- Một full test suite chạy sau mọi edit.
- Một memory tự do không provenance.
- Một approval dialog sau mọi action.
- Một workflow nhiều phase cứng nhắc cho mọi task.

---

# 86. Anti-patterns phải cấm

## 86.1 All-tools-visible

```text
registered tools == model-visible tools
```

Cấm.

## 86.2 LLM-as-policy-engine

```text
LLM says safe → run
```

Cấm.

## 86.3 Premature editing

```text
unknown root cause
→ broad edit
```

Cấm trừ trivial fast-path có certainty cao.

## 86.4 Context dumping

```text
entire repo
entire logs
entire history
```

Cấm khi có structural compression.

## 86.5 Review theater

Không chạy reviewer chỉ để tạo thêm prose.

Reviewer phải có objective evidence task.

## 86.6 Endless exploration

Nếu root cause/target/verification đã đủ thì dừng đọc.

## 86.7 Tool-call loop

Không retry cùng action với state y hệt.

Retry phải có:

```text
changed arguments
new evidence
changed permissions
or changed hypothesis
```

---

# 87. Recommended implementation phases

## Phase 1 — Core safety

Build:

```text
Classification schema
Phase machine
Capability ontology
Tool registry
Hard policy engine
Execution guard
Verification gate
```

## Phase 2 — This-turn optimization

Add:

```text
deferred loading
tool retrieval
ranking
top-K
token budget
```

## Phase 3 — Code context intelligence

Add:

```text
Repo Map
LSP
impact graph
targeted read
```

## Phase 4 — Resilience

Add:

```text
checkpoint
rollback
baseline comparison
observation compression
```

## Phase 5 — Complex-task cognition

Add:

```text
task graph
planner
subagents
worktrees
```

Only after simple path is stable.

## Phase 6 — Long-term intelligence

Add:

```text
grounded memory
memory citation validation
memory consolidation
```

## Phase 7 — Trajectory optimization

Tune:

```text
model routing
tool-call budget
token budget
fast-path thresholds
parallelism thresholds
```

---

# 88. Priority order nếu nâng cấp hệ thống hiện có

Nếu Coding Agent hiện tại đã có CRUD code tools và basic safety, ưu tiên:

```text
P0
ClassificationDecision contract

P0
Per-turn Tool Gate

P0
Execution Guard

P0
Verification Completion Gate

P1
Capability ontology

P1
Deferred Tool Loading

P1
Repo Map + LSP

P1
Checkpoint/Rollback

P2
Observation compression

P2
Task graph

P2
Grounded memory

P3
Subagents

P3
Continuous planner

P3
Parallel worktrees
```

Lý do: P0/P1 mang lại phần lớn cải thiện safety + token efficiency mà chưa tạo multi-agent overhead.

---

# 89. Kiến trúc cuối rút gọn

```text
                     ┌───────────────────┐
                     │ USER REQUIREMENT  │
                     └─────────┬─────────┘
                               ▼
                     ┌───────────────────┐
                     │ CLASSIFICATION    │
                     │                   │
                     │ What is the task? │
                     │ What phase?       │
                     │ What capability?  │
                     │ What risk?        │
                     └─────────┬─────────┘
                               │
                     Decision Contract
                               │
                               ▼
                   ┌──────────────────────┐
                   │ THIS-TURN TOOL GATE │
                   │                      │
                   │ What can LLM see     │
                   │ and use NOW?         │
                   └──────────┬───────────┘
                              │
                        minimal tools
                              ▼
                         ┌─────────┐
                         │   LLM   │
                         └────┬────┘
                              │
                         concrete action
                              ▼
                   ┌──────────────────────┐
                   │ EXECUTION GUARD      │
                   │                      │
                   │ policy               │
                   │ args                 │
                   │ sandbox              │
                   │ checkpoint           │
                   └──────────┬───────────┘
                              ▼
                          REAL STATE
                              │
                              ▼
                          EVIDENCE
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
              RECLASSIFY             VERIFY
                   │                     │
                   └─────────┬───────────┘
                             ▼
                    COMPLETION GATE
                             │
                             ▼
                           FINAL
```

---

# 90. Tôn chỉ vận hành cuối

Coding Agent phải hành xử theo thứ tự ưu tiên:

```text
1. Correctness
2. No Regression
3. Evidence
4. Minimum Necessary Change
5. Minimum Necessary Capability
6. Minimum Necessary Context
7. Minimum Necessary Tool Calls
8. Minimum Necessary Turns
9. Fast Final Answer
```

Điều quan trọng là thứ tự này.

Không được tối ưu token bằng cách bỏ verification bắt buộc.

Không được tối ưu tốc độ bằng cách edit trước khi có đủ evidence.

Nhưng cũng không được dùng safety làm lý do để:

- đọc toàn repository.
- lập plan dài cho task trivial.
- spawn nhiều agent.
- chạy full suite vô điều kiện.
- hỏi user những điều agent tự kiểm tra được.

---

# 91. Định nghĩa "tối ưu"

Một trajectory tốt không phải trajectory ít bước nhất tuyệt đối.

Nó là:

```text
Shortest Verified Correct Trajectory
```

hay:

> **Chuỗi hành động ngắn nhất có đủ bằng chứng để hoàn thành yêu cầu mà không tạo regression mới.**

Đây phải là objective function trung tâm của Agent Core.

---

# 92. Nguồn nghiên cứu chính thức

Các nguồn dưới đây là cơ sở để đối chiếu cơ chế gốc. Kiến trúc cuối trong tài liệu là phần tổng hợp và thiết kế mới, không phải copy nguyên kiến trúc của bất kỳ sản phẩm nào.

## Anthropic / Claude

- Tool reference / deferred loading:  
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- Tool search:  
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool

## Google Gemini CLI

- Policy engine:  
  https://geminicli.com/docs/reference/policy-engine/
- Plan Mode:  
  https://geminicli.com/docs/cli/plan-mode/
- Tools / task tracking:  
  https://geminicli.com/docs/reference/tools/

## OpenAI Codex

- Codex repository / sandbox & permission architecture:  
  https://github.com/openai/codex
- Command-segment approval policy implementation reference:  
  https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md

## Aider

- Repository Map:  
  https://aider.chat/docs/repomap.html
- Tree-sitter repo map design:  
  https://aider.chat/2023/10/22/repomap.html

## Cursor

- Subagents:  
  https://cursor.com/docs/subagents
- SDK tool restrictions:  
  https://cursor.com/docs/sdk/python

## Windsurf / Cascade

- Cascade architecture / planning / checkpoints / tool calling:  
  https://docs.windsurf.com/windsurf/cascade/cascade

## Cline

- Plan & Act:  
  https://docs.cline.bot/core-workflows/plan-and-act
- Checkpoints:  
  https://docs.cline.bot/core-workflows/checkpoints
- Auto Approve:  
  https://docs.cline.bot/features/auto-approve

## Roo Code

- Boomerang Tasks:  
  https://docs.roocode.com/features/boomerang-tasks

## GitHub Copilot

- Copilot Memory:  
  https://docs.github.com/en/copilot/concepts/agents/copilot-memory
- Repository indexing:  
  https://docs.github.com/en/copilot/concepts/context/repository-indexing

## Zed

- Agent Panel:  
  https://zed.dev/docs/ai/agent-panel
- Parallel Agents:  
  https://zed.dev/docs/ai/parallel-agents

## OpenCode

- Agents:  
  https://opencode.ai/docs/agents/
- Permissions:  
  https://opencode.ai/docs/permissions/
- Tools:  
  https://opencode.ai/docs/tools/

## MiMo Code

- MiMo Code architecture/news documentation:  
  https://mimo.mi.com/docs/en-US/news/latest/mimocode

---

# 93. Final implementation directive for the Coding Agent

Khi dùng tài liệu này để nâng cấp hệ thống, Coding Agent phải:

1. Đọc toàn bộ kiến trúc trước khi thay đổi code.
2. Mapping kiến trúc hiện tại của project vào từng module trong spec.
3. Không rewrite toàn hệ thống nếu có thể nâng cấp incremental.
4. Ưu tiên P0 → P1 trước.
5. Giữ backward compatibility với workflow hiện tại.
6. Viết unit tests cho Classifier, Tool Filter, Policy và Execution Guard.
7. Viết integration tests cho state transitions.
8. Đo baseline token/tool-call/turn trước khi nâng cấp.
9. Đo lại sau nâng cấp.
10. Không tuyên bố hoàn thành nếu acceptance criteria chưa đạt.
11. Không thêm subagent/planner phức tạp trước khi fast path và tool gate ổn định.
12. Mọi optimization phải giữ invariant:

```text
Hoàn thành Task Không Gây Ra Lỗi Code
```

và objective:

```text
Shortest Verified Correct Trajectory
```

---

# END OF SPEC
