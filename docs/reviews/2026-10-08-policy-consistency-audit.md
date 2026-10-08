# Audit tính nhất quán policy — 2026-10-08

## Phạm vi và phương pháp

Theo yêu cầu, ba subagent phân tích độc lập: (1) quyền, classification, phase; (2) prompt, skills, context; (3) verification, evidence, completion. Agent chính đối chiếu Git workflow, domain contract, loop guards và rollback. Đây là phân tích source, không sửa implementation, không chạy tests hoặc thử thao tác phá hủy.

GitNexus repository `Minus_CLI` chậm một commit. Refresh bằng `.gitnexus/run.cjs analyze --index-only` thất bại ở bước kiểm tra identity của analyzer. Dùng graph để định vị/call paths và CodeGraph để đọc source working tree hiện tại. Vì vậy line numbers bên dưới thuộc working tree tại thời điểm audit, không phải index cũ. Những thay đổi chưa commit có sẵn được giữ nguyên.

P1: ưu tiên sửa vì có thể vượt quyền, mất thay đổi hoặc tạo quyết định hoàn thành sai. P2: sai trạng thái, hướng dẫn mâu thuẫn hoặc tạo vòng lặp không cần thiết. Mức độ chắc chắn phân biệt hành vi source đã xác định và tình huống runtime chưa tái hiện. Không có kết luận rằng mọi policy/helper trong repository đã được chứng minh đúng.

## Kết luận

Có cả nhiễu prompt và bất đồng bộ thực thi. Năm nguyên nhân chính:

1. Nhiều bộ phân loại riêng định nghĩa khác nhau về mutation, verification và authorization.
2. Prompt tuyên bố quyền hoặc thành công mạnh hơn runtime thực sự bảo đảm.
3. State của lượt trước còn tồn tại ở skills và impacted tests.
4. Completion tool và plain-text final không đi qua cùng tập invariants.
5. Recovery/rollback là đường thực thi riêng, chưa dùng cùng scope và evidence với workflow chính.

## A. Quyền, classification và phase

### A1 — P1: `read_only` vẫn có đường chạy script sửa workspace

**Source:** [permission-manager.ts:102](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/security/permission-manager.ts:102), [tool-descriptor-registry.ts:125](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control/tool-descriptor-registry.ts:125), [agent-loop.ts:1546](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:1546), [run-node-script.ts:455](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/run-node-script.ts:455).

Read-only dùng blacklist tên tool thiếu `run_node_script`. Descriptor của script đánh dấu mutating nhưng có capability inspect và cho phép mọi phase; schema mask chỉ loại EDIT_TOOL_NAMES. Script thực thi Node trong workspace, không tự kiểm tra read-only. Scenario: PLAN/read-only bình thường gọi script ghi file. Pre-mutation evidence cho bugfix/refactor/security không bảo vệ mọi yêu cầu planning/exploration. **Confidence cao về đường dispatch**, chưa thử ghi file. Sửa theo effect classification thống nhất; deny mutating/unknown tools trong read-only, hoặc phân tích effects của arguments.

Đường tương tự: [run-test-suite.ts:46](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/run-test-suite.ts:46) luôn chọn sandbox `workspace-write`, không kế thừa PermissionManager read_only. Tool name “test” không chứng minh command/test code không sửa file. Gộp đây vào cùng invariant A1 thay vì đếm như lỗi quyền độc lập.

### A2 — P1: allowlist `enforce` bị bypass cho mọi root tool trong Implement

**Source:** [tool-runner.ts:323](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-runner.ts:323), [this-turn-tool-gate.ts:171](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control/this-turn-tool-gate.ts:171).

`isMutationInImplement` chỉ kiểm tra phase Implement và tool có trong root registry, không kiểm tra mutation/capability/scope. Vì vậy tool ngoài allowlist vẫn dispatch; EDIT_TOOL_NAMES còn có bypass riêng. Các permission chuyên biệt có thể chặn tiếp, nhưng contract “authorized this step” không đúng ở lớp này. **Confidence cao.** Đưa control tools cần thiết vào allowlist rõ ràng; bỏ broad bypass.

### A3 — P2: thất bại verification cũ lấn át success mới

**Source:** [phase-lifecycle.ts:95](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/phase-lifecycle.ts:95), [agent-loop.ts:4191](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4191).

Authority dùng `.some(phase/verificationFailed)` trên toàn turn để ép Implement. Sau fail → repair → pass, chronological lifecycle có thể đã recover nhưng authority vẫn Implement. Prompt/gate lệch evidence mới; không khẳng định completion luôn bị khóa vì có guard riêng. **Confidence cao.** Fold events theo thứ tự và mutation boundary, dùng failure mới nhất chưa được giải quyết.

### A4 — P2: recovery hướng dẫn cơ chế chuyển phase đã cũ

**Source:** [tool-runner.ts:330](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-runner.ts:330), [phase-lifecycle.ts:75](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/phase-lifecycle.ts:75), [prompt-sections.ts:593](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/llm/prompt-sections.ts:593).

Thông báo deny yêu cầu create_plan/update_plan_task để vào Implement, trong khi durable authority cần `request_phase_transition` được accepted. LLM có thể lặp cập nhật plan mà tool vẫn bị khóa. **Confidence cao.** Dùng chung phase-transition recovery generator và fresh-response fence.

### A5 — P2: `always_ask` có thể tự cho phép khi không có approval channel

**Source:** [permission-manager.ts:152](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/security/permission-manager.ts:152).

Không có prompt handler chỉ deny run_command/CRITICAL; HIGH browser click/type hoặc delete_file có thể allowed, dù mode always_ask. Comment về headless denial không khớp implementation. **Confidence cao.** Khi đã vào nhánh cần approval mà không lấy được approval, trả APPROVAL_REQUIRED; preapproval phải là quyết định tường minh.

### A6 — P2: mixed request bị phân loại read-only

**Source:** [request-intent.ts:19](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control/request-intent.ts:19), [classification-engine.ts:52](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control/classification-engine.ts:52).

Mixed-request exclusion thiếu add/update/remove/rename/build và một số động từ Việt dù mutation classifier nhận diện chúng. Ví dụ “Review and add tests”, “Inspect and update this function”, “Phân tích rồi thêm kiểm tra”. Read-only chạy trước nên chọn Exploration. **Confidence cao về regex; UX suy từ callers.** Dùng một mutation-intent parser cho cả hai policy.

## P. Prompt, skills và context

### P1 — P1: skill của lượt trước tồn tại trong system prompt lượt sau

**Source:** [superpowers-plugin.ts:111](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/kernel/plugins/superpowers-plugin.ts:111), [kernel.ts:367](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/kernel/kernel.ts:367).

Turn-start chỉ unregister/register các skill đang active mới; không gỡ section của skill không còn active. Plugin bật mặc định. Planning/TDD/Git instruction từ task trước có thể tiếp tục điều khiển read-only task sau, còn activation metadata nói inactive. Full text nằm ngoài dynamic arbiter. **Confidence cao.** Atomically replace tập sections do plugin sở hữu mỗi turn; scope assembler theo agent/session.

### P2 — P1: yêu cầu inspect Git có thể kích hoạt finishing workflow

**Source:** [skill-activator.ts:170](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/skill-activator.ts:170), [superpowers-source.ts:181](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/superpowers-source.ts:181).

Tag chung `git` khớp trước intention chuyên biệt. “git diff” có thể kích hoạt finishing-a-development-branch, description yêu cầu full suite → stage → commit → push. Xung đột trực tiếp inspect-only scope và GitWorkflow; runtime deny không loại nhiễu hoặc vòng gọi lỗi. **Confidence cao.** Gate skill Git theo từng operation được phép, không cho tag chung bypass.

### P3 — P1: advice tuyên bố test pass với command chưa hoàn tất hoặc không phải test

**Source:** [tool-synergy-advisor.ts:141](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/tool-synergy-advisor.ts:141).

Fastpath coi exitCode undefined là success và regex test/spec/check/verify khớp mọi vị trí. Background npm test chưa xong, hoặc `echo test` exit0 có thể tạo guidance “empirical proof, submit immediately”. Completion evidence cần terminal outcome thực tế nên sẽ cãi lại advice. **Confidence cao.** Dùng canonical command outcome + verification semantics + freshness.

### P4 — P2: hierarchy CORE và Git prompt mâu thuẫn explicit main push

**Source:** [prompt-sections.ts:267](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/llm/prompt-sections.ts:267), [prompt-sections.ts:374](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/llm/prompt-sections.ts:374).

CORE yêu cầu refuse user pushing main theo L1/L2; Git operations lại cho phép main push khi user yêu cầu rõ. CORE còn ưu tiên repository rules hơn user styling/branch preferences quá rộng. **Confidence cao về xung đột text; kết quả runtime tùy Git authorization.** Viết một hierarchy/scope contract, biểu đạt ngoại lệ explicit authorization nhất quán.

### P5 — P2: Verify guidance đòi full ladder dù risk playbook cho verify nhẹ

**Source:** [prompt-sections.ts:415](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/llm/prompt-sections.ts:415), [prompt-sections.ts:609](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/llm/prompt-sections.ts:609), [agent-loop.ts:2211](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:2211).

R1 playbook cho diagnostics rồi submit; phase guidance ghép vào mọi bước Verify vẫn yêu cầu diagnostics/build/targeted test/git diff và passing test. “Clean git diff” cũng không phân biệt expected diff với không có thay đổi. **Confidence cao.** Render phase guidance từ cùng risk/evidence decision; yêu cầu reviewed expected diff.

### P6 — P2: `shadow` vẫn thay đổi Git prompt, giữ nguyên legacy noise

**Source:** [step-prompt-policy.ts:156](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/step-prompt-policy.ts:156), [step-prompt-policy.ts:334](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/step-prompt-policy.ts:334).

Default shadow giữ toàn bộ static playbooks/full advice/profile nhưng vẫn nạp selected Git block; chỉ off/fallback tắt nó. Shadow không thuần telemetry, estimated savings không đồng nghĩa actual savings. **Confidence cao.** Tách flag hoặc định nghĩa shadow telemetry-only, thống nhất metric với payload thực.

### P7 — P2: context budget loại plan/evidence trước advice và cắt critical constraints

**Source:** [dynamic-context-arbiter.ts:397](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/dynamic-context-arbiter.ts:397), [dynamic-context-arbiter.ts:443](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/dynamic-context-arbiter.ts:443), [agent-loop.ts:2203](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:2203).

P2 plan và memories bị loại trước nhiều advice/profile/scaffold P≤1.5. Last-resort truncation không tôn trọng allowTruncation:false; exact allowed-tools list ghép cuối phase block có thể bị mất. Main path đặt budget1200/1600, lấn át arbiter env/default2000. **Confidence cao về cơ chế; chưa đo overflow runtime.** Giữ compact authority/active task/evidence bất biến, hạ advice priority, semantic truncation và một config owner.

### P8 — P2: nhiều planning skills cùng active, dependency bỏ qua gate

**Source:** [skill-activator.ts:168](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/skill-activator.ts:168), [skill-activator.ts:235](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/skill-activator.ts:235).

Planning có thể bật writing-plans/planning-with-files/concise-planning/brainstorming cùng lúc; builtin không khai báo conflicts. planning-with-files yêu cầu ghi task_plan/findings/progress trong khi plan-only có DAG khác. Dependency auto-activation không chạy lại disabled/capability/conflict/recursive prerequisites. **Confidence cao.** Một planning owner và một dependency resolver dùng cùng admission rules.

### P9 — P2: strong advisory và Pareto dùng khác verdict evidence

**Source:** [step-prompt-policy.ts:131](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/step-prompt-policy.ts:131).

Advisory thiếu validated hypothesis + score dưới threshold yêu cầu formulate_and_verify_hypothesis, dù Pareto/phase cho small reversible edit với direct causal evidence. Wording “broad edits” làm nhẹ xung đột nhưng vẫn thêm protocol không cùng verdict. **Confidence trung bình/cao.** Shared evidence verdict có risk/scope; formal hypothesis chỉ bắt buộc khi thật sự cần.

### P10 — P2: recovery advice gợi ý rollback ngoài authorization

**Source:** [tool-synergy-advisor.ts:232](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/tool-synergy-advisor.ts:232).

Repair exhausted gợi ý rollback workspace về green checkpoint; Git guidance nói tool failures không tự cấp quyền rollback/stash. Root phát hiện đường automatic rollback bên dưới còn thực thi riêng. **Confidence cao về text conflict.** Chỉ gợi ý rollback agent-owned effects với checkpoint scope đã kiểm tra; mặc định reevaluate/replan.

## C. Verification, evidence và completion

### C1 — P1: tool submit và plain-text final không dùng cùng invariants

**Source:** [submission-readiness.ts:44](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/submission-readiness.ts:44), [agent-loop.ts:4393](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4393), [agent-loop.ts:4608](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4608).

Submission preflight chạy VerificationPolicy/evidence/grounding/OCR, không CriticGate. Auto-finalization default true return ngay sau submit, trước final plan/critic checks. Scenario: verification command pass nhưng changed-file diagnostics còn lỗi; direct submit không chạy targeted critic diagnostics còn text final có thể bị chặn. Readiness có kiểm tra planBlocker riêng, nên không khẳng định mọi plan guard đều bị bypass. **Confidence cao.** Một evaluateCompletion cho mọi đường, gồm diagnostics/plan/evidence/pending work/OCR.

### C2 — P1: impacted test obligations rò giữa turns

**Source:** [verification-policy.ts:417](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/verification-policy.ts:417), [verification-policy.ts:331](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/verification-policy.ts:331), [agent-loop.ts:1027](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:1027).

Reset không clear pendingTargetedTests dù clear modified files/history/reproduction. TaskA cancel trước verify; TaskB read-only hoặc sửa file khác vẫn có thể bị yêu cầu suiteA, trái turn-scoped evidence. **Confidence cao.** Reset hoặc scope obligations theo turn/artifact; continuation replay phải rõ.

### C3 — P1: `canComplete` bị diễn đạt thành “ALL UNIT TESTS PASSED”

**Source:** [agent-loop.ts:1627](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:1627), [agent-loop.ts:2082](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:2082).

hasVerifiedTests thực tế = canComplete.allowed && hasMutations. Docs/comment/inert/diagnostics/typecheck exemptions cũng thỏa, nhưng directive nói unit tests Exit0, không được sửa nữa, submit ngay. Harness tự tạo false evidence khiến LLM báo sai hoặc submit sớm. **Confidence cao.** Tên completionVerificationSatisfied và guidance dựa observed kind/command; không dùng “all tests” nếu chưa chạy.

### C4 — P2: completion evidence `off` vẫn bị auditor gọi lại

**Source:** [completion-evidence.ts:175](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/completion-evidence.ts:175), [solution-grounding-auditor.ts:191](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/solution-grounding-auditor.ts:191).

SubmissionReadiness tôn trọng env off nhưng read-only grounding tự new CompletionEvidenceGate vô điều kiện; submit tool audit lần nữa. Log/config “off” và actual veto không cùng nghĩa. **Confidence cao.** Truyền canonical enabled/verdict vào auditor hoặc để evidence ownership ở một lớp.

### C5 — P2: verification tier không có một contract chung

**Source:** [verify-tier-resolver.ts:63](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/verify-tier-resolver.ts:63), [verification-policy.ts:379](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/verification-policy.ts:379), [critic-gate.ts:489](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/critic-gate.ts:489), [completion-evidence.ts:501](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/completion-evidence.ts:501).

Resolver HIGH/CRITICAL says full_test, VerificationPolicy đã bỏ enforcement. Critic dùng hasVerifiedPassingTest nhưng helper chấp nhận verification rộng gồm diagnostics/typecheck. Async critic không có high-impact block như sync. Auditor còn dựa resolutionType/verificationMethod model khai báo. **Confidence cao.** Chọn risk-appropriate hay full_test rõ ràng; shared predicate và sync/async cùng verdict. Không mô tả full-suite requirement đang được hard-enforce.

### C6 — P2: evidence cùng kind có thể chứng minh nhầm plan task

**Source:** [plan-manager.ts:924](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/plan-manager.ts:924), [plan-manager.ts:933](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/plan-manager.ts:933), [plan-manager.ts:650](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/plan-manager.ts:650).

Task không có evidence dùng global success của bất kỳ task cùng kind. git status và git commit đều kind git; một inspection/mutation có thể thỏa task khác target. completeTaskWithEvidence còn mark trực tiếp với supplied outcome default success. **Confidence cao về API behavior; mọi caller/tool path chưa chứng minh.** Key obligation theo task+target+operation+expected outcome; chỉ share khi coverage thật sự trùng.

### C7 — P2: validated hypothesis làm VerificationPolicy ghi failure

**Source:** [agent-loop.ts:3935](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:3935), [verification-policy.ts:249](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/skills/verification-policy.ts:249), [pareto-evidence-policy.ts:130](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/pareto-evidence-policy.ts:130).

Validated hypothesis gọi recordVerification("hypothesis_H",true,...,0), nhưng synthetic command không phải verification command nên effectiveSuccess=false, ghi đè lastVerification. Pareto đồng thời tăng6points/empirical=true. **Confidence cao.** Hypothesis evidence riêng, chỉ actual verification result cập nhật verification ledger.

### C8 — P2: expected FAIL reproduction bị coi là falsified hypothesis

**Source:** [test-engineering-harness.ts:125](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/testing/test-engineering-harness.ts:125), [hypothesis-tool.ts:262](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/hypothesis-tool.ts:262).

Harness pass→validated, fail→falsified+rollback, không xét expectedOutcome; hypothesis tool lại xét expected FAIL đúng. Pre-fix reproduction FAIL có thể phủ định chính hypothesis cần chứng minh. **Confidence cao về logic; integration active-hypothesis scenario chưa chạy.** So sánh expectedOutcome, tách assertion failure với infrastructure error.

### C9 — P2: reproduction status không gắn command/version/thứ tự

**Source:** [test-engineering-harness.ts:310](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/testing/test-engineering-harness.ts:310), [pareto-evidence-policy.ts:101](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/pareto-evidence-policy.ts:101).

ReproManager dùng any preFail + any postPass, không match test/hypothesis/command hoặc chronological artifact state. TestB postPass cũ + testA preFail mới vẫn verified. Pareto aggregate lịch sử cũng không đồng nghĩa validation sau mutation cuối; score investigation tự nó không phải completion bypass. **Confidence cao.** Bind command+hypothesis+workspace version và FAIL→mutation→PASS có thứ tự.

## G. Git workflow

### G1 — P2: read-only PR commands bị chặn

**Source:** [git-workflow.ts:130](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:130), [git-workflow.ts:290](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:290).

Mọi `gh pr ...` thành stage PR; permitted chỉ publish + pr:create/pr:edit. Khi GitWorkflow active, `gh pr view/list/diff/checks` đều bị outside-scope, ngay cả workflow review/prepare. Mâu thuẫn baseline inspection và nhu cầu đọc PR trước publish/review. **Confidence cao.** Classify PR reads thành Inspect, cho phép đọc xuyên stages; mutation PR gate riêng.

### G2 — P2: Sync gộp fetch/pull/push và luôn nằm sau Implement/Commit

**Source:** [git-workflow.ts:15](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:15), [git-workflow.ts:159](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:159), [git-workflow.ts:294](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:294).

Request “fetch origin, sửa branch dựa trên ref mới, commit rồi push” có explicit quyền fetch nhưng fetch bị stage guard chặn trước Implement/Commit. Branch từ remote ref mới cũng cần fetch trước Branch. **Confidence cao.** Giữ thứ tự release chính nhưng biểu diễn authorized prerequisite fetch/integration trước Branch/Implement, publish push sau Commit; không tự mở rộng quyền pull/rebase.

### G3 — P2: Branch stage chỉ có một action cho toàn request

**Source:** [git-workflow.ts:65](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:65), [git-workflow.ts:231](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:231), [git-workflow.ts:293](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/git-workflow.ts:293).

branchAction là scalar, delete/rename/create/switch có ưu tiên regex và advance sau một success. Request có nhiều authorized branch actions không thể thực thi theo sequence đúng; chẳng hạn tạo branch mới rồi xóa branch tạm chọn delete, chặn create. **Confidence cao về representation/guard.** Scope ordered operations với refs/targets, mỗi obligation cần outcome tương ứng.

## R. Domain, loop và rollback

### R1 — P1: automatic rollback vượt tool authorization và có fallback discard toàn workspace

**Source:** [agent-loop.ts:3953](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:3953), [agent-loop.ts:4002](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4002), [hypothesis-rollback-orchestrator.ts:69](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/hypothesis-rollback-orchestrator.ts:69), [checkpoint.ts:155](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/workspace/checkpoint.ts:155).

Falsified hypothesis/cognitive brake gọi rollback trực tiếp ngoài GitWorkflow/ToolRunner permission. Restore dùng `--worktree .` toàn repository, không giới hạn agent-owned paths/current contents; nếu snapshot restore lỗi còn fallback `git restore .`. User edits sau checkpoint có thể bị ghi đè, fallback còn bỏ tracked uncommitted changes thay vì restore snapshot. Trái preservation guidance và scope yêu cầu rollback. **Confidence cao về đường code; chưa thực thi và chưa khẳng định đã xảy ra mất dữ liệu.** Scoped inverse effects + compare current digest + ownership; không dùng discard fallback; rollback cần authorization rõ và event evidence để invalidate verify/commit state.

Checkpoint không có commitHash hoặc non-Git còn return success dù không restore gì [checkpoint.ts:180](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/workspace/checkpoint.ts:180); orchestrator có thể báo “clean slate restored” sai. Không nên coi success boolean hiện tại là evidence workspace green.

### R2 — P2: Domain contract suy quyền test từ từ khóa, không xét phủ định; “BLOCKING” gọi sau execution

**Source:** [domain-intent-guardian.ts:57](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/domain-intent-guardian.ts:57), [domain-intent-guardian.ts:181](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/domain-intent-guardian.ts:181), [agent-loop.ts:4080](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4080).

“Do not modify unit tests” vẫn chứa unit test → allowTestFileModification=true, dù constraint text bảo preserve. “inspect...” chứa spec cũng có thể mở quyền. observeToolCall severity BLOCKING được gọi sau tool execution trong AgentLoop và gắn warning vào result, không tự chặn mutation. Scratch exemption/file-path extraction cũng không phân tích mọi script/patch effect. **Confidence cao về logic/call order; các guard khác có thể chặn riêng.** Parse explicit permission có phủ định, enforce trước effects; phân biệt advisory với blocking.

### R3 — P2: loop detector coi số lần sửa/đọc là evidence thiếu tiến triển

**Source:** [loop-progress-guard.ts:161](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/loop-progress-guard.ts:161), [loop-progress-guard.ts:173](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/loop-progress-guard.ts:173), [loop-progress-guard.ts:261](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/loop-progress-guard.ts:261).

Ping-pong chỉ xét tên file A→B→A→B, không nội dung/progress; lọc bỏ verification markers nên verify ở giữa cũng không loại cảnh báo ping-pong. Bốn edits cùng file đòi test/scratch dù diagnostics hoặc plan có thể cho phép batching. Guidance identical read còn bảo “proceed by creating project files”, không phù hợp read-only request. Non-verification run_command bất kỳ lại clear read-loop history dù chỉ `pwd`/git status, trong khi fingerprint result đầy metadata có thể không ổn định. **Confidence cao về heuristic; tần suất false positive chưa đo.** Progress dựa changed artifact/evidence/active task; advice scope-aware và dùng canonical verification observations.

## Inventory và trạng thái nhất quán

| Policy / mechanism | Default / authority | Nhận xét |
|---|---|---|
| ClassificationEngine + request intent | Regex deterministic, initial phase | A6; cần parser chung |
| ThisTurnToolGate | Control mode default shadow; enforce tùy config | A2; edit exceptions và bypass làm authority không đồng nhất |
| Tool descriptors / runtime recovery | Capability/effect metadata, model guidance | A1/A4; descriptors và schema mask khác nhau |
| PermissionManager | ask_sensitive mặc định; read_only/always_ask/auto_approve | A1/A5; explicit user rejection kết thúc turn hợp lý |
| PhaseLifecycle / transitions | Durable events + version/fresh response | A3/A4; refs transition chưa kiểm tra sufficiency đầy đủ |
| StepPromptPolicy | off/shadow/enforce, default shadow; confidence fallback | P6/P9 |
| PromptAssembler + CORE | Static tiered system sections | P1/P4; skill text ngoài arbiter |
| DynamicContextArbiter | Default2000; main1200/1600; dedup | P7; advice không dedup như memories |
| RuntimeHarnessProfile | Strict bugfix/security; velocity feature; explore read-only | Risk-proportional wording mới hợp lý; balanced còn nhắc standard TDD |
| ToolSynergyAdvisor | Deterministic advice | P3/P10 |
| SkillActivator / SuperpowersPlugin | Plugin enabled mặc định | P1/P2/P8 |
| SuperpowersWorkflowMap | Initial brainstorming | Chưa thấy transitionTo/getRecommendedSkills ở runtime; không đồng bộ phase/Git thật sự |
| ObservationRetentionPolicy | Unpin duplicate successful payload/args | Không thấy conflict; giữ snapshots có nội dung khác |
| CompletedTurnCompactionPolicy | Bật; giữ4 turns; pressure60%; savings bounds | Không thấy conflict chính; không compact chỉ vì turn count |
| ContextBudgetManager / Compactor | Auto provider-aware, trigger75% | Whole-request overhead, pair preservation/archive hợp lý |
| ContextGuardian / ContextAgent | Persist recovery briefing/context file | Hardcoded passing100%/full-test và deployment/browser instructions là rủi ro nếu được đọc; chưa chứng minh tự inject hiện tại |
| VerificationPolicy | Hard completion; repro observe mặc định | C2/C5/C7 |
| CompletionEvidenceGate | Enabled mặc định; env off | Fresh post-mutation evidence tốt; C4/C5 |
| ParetoEvidencePolicy | Risk thresholds2/3/5/6 | Investigation score hữu ích; P9/C7/C9 về interpretation |
| SubmissionReadiness | Fingerprint scope/artifact/plan/evidence | Artifact hashing tốt; C1 về thiếu shared completion invariants |
| SolutionGroundingAuditor | Hard preflight/execute | Read-only quota đã bỏ hợp lý; C4/C5 |
| submit_solution | Actual summary/language required; auto-final thường bật | C1; no further tools sau success nhất quán |
| FinalAnswerGuard | Hard final + quality guidance | Git recovery text còn yêu cầu dedicated tools trong khi runtime support shell; completion routing cần C1 |
| CriticGate sync/async | Hard invariants + score60 | Chỉ diagnostics changed files tốt; C1/C5 |
| Exploration sufficiency | Observe default / enforce config | Không coi telemetry-only là hard proof |
| VerifyTierResolver | HIGH/CRITICAL full_test trong metadata | C5; consumer contract chưa đồng nhất |
| VerificationCoverage | Insufficient block; partial/unknown không block; line50% | Unknown chưa đồng nghĩa full test coverage |
| PlanManager | DAG/dependencies/evidence obligations | C6; auto reconcile SKIPPED bị UI gọi completed |
| TestEngineeringHarness | Suite result cập nhật hypothesis/rollback | C8/C9 |
| ReproductionVerificationManager | Any preFail+postPass | C9 |
| GrillGate | Compose preflight, keyword questions | Heuristic có thể hỏi thừa; chưa xác định conflict runtime cụ thể |
| Git scope / command authorization | Explicit operations + paths, riêng nhiều parsers | G1–G3/P4; nên canonicalize quyền và refs |
| GitWorkflow | Replay durable outcomes, additional ordering guard | Background task correlation/dry-run exclusion/fresh verify tốt; G1–G3 |
| DomainIntentGuardian | Frozen per-turn contract, thought/tool warnings | R2; từ khóa không chứng minh authorization |
| LoopProgressGuard | Reset turn; repeat3 stop, trajectory advisory | R3 |
| ProcessFailureDetector | Separate exploration/localization/patch phases | Keyword/Jaccard heuristics; khác phase authority và command outcome; không coi suggested pivot là proven cause |
| CognitiveHarness / HypothesisRollback | Automatic branch pruning/restore | R1/C8; bypass canonical scope |
| Circuit breaker recovery | ≤5 retries; cancellation exits; system Continue | Intent preservation hợp lý; runInternal reset obligations cần replay nhất quán |
| EffectLedger / checkpoints | Paired effect events + Git snapshot | Manual undo updates ledger; R1 automatic restore cần ledger/evidence consistency |

## Bổ sung: policy phụ, sandbox và reasoning compute

### S1 — P2: sandbox prefix classifier không bảo đảm strict read-only

**Source:** [sandbox-policy.ts:115](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/sandbox/sandbox-policy.ts:115).

Safe command prefix được allow trước strict/CWD checks. `git branch new-name`, `echo text > file`, hoặc `git status && <mutation>` có thể qua; cwd ngoài workspace cũng không được kiểm tra ở early return. **Confidence cao về API; main run_test_suite hiện chọn workspace-write nên chưa chứng minh strict bật thực tế.** Parse từng shell segment/args/redirection và containment trước allow.

### S2 — P2: sandbox env filter bị host env merge lấn át

**Source:** [isolated-substrate.ts:68](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/execution/isolated-substrate.ts:68), [local-substrate.ts:83](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/execution/local-substrate.ts:83).

Wrapper chỉ sanitize options.env; LocalExecutionSubstrate lại merge process.env nếu isolatedEnv chưa bật. Key bị block trong custom env có thể được kế thừa lại từ host, kể cả NODE_OPTIONS/token. run_test_suite không bật isolatedEnv. **Confidence cao về merge semantics; không đọc hoặc xuất giá trị bí mật.** Sanitize merged environment hoặc dùng isolatedEnv với allowlist đầy đủ.

### S3 — P2: reasoning escalation tuyên bố tăng token budget nhưng chỉ tăng guidance

**Source:** [agent-loop.ts:4719](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4719), [agent-loop.ts:4744](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4744), [adaptive-reasoning-controller.ts:82](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/adaptive-reasoning-controller.ts:82).

AdaptiveReasoningController đang dùng default medium8192; escalation nạp message nói đã tăng16384/32768tokens, nhưng không tìm thấy getBudget được main loop dùng để set provider thinkingBudget/reasoningEffort. Provider vẫn dùng config riêng. **Confidence cao về wiring; actual provider payload chưa đo.** Ghi actual applied budget hoặc bỏ claim allocation khi chỉ đổi guidance.

### S4 — P2: completion rejection read-only vẫn bị ép deep debugging

**Source:** [agent-loop.ts:4722](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts:4722), [adaptive-reasoning-controller.ts:82](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/adaptive-reasoning-controller.ts:82).

Recovery riêng read-only yêu cầu sửa unsupported claim/submit, nhưng ghép deep-causal guidance chung yêu cầu diagnose/logs/rigorous verify. Rejection thiếu submit hoặc format không chứng minh technical failure. **Confidence cao về text; tác động mở investigation không cần thiết là scenario chưa chạy.** Escalation theo rejection reason; submission/format không tự nâng investigation scope.

| Policy phụ | Wiring hiện tại | Kết luận |
|---|---|---|
| CapabilityPolicy | SuperpowersPlugin tạo/gắn context; chỉ tìm thấy evaluate trong tests | Không phải live dispatch gate; không dùng deny của API này làm bằng chứng quyền đang được bảo vệ |
| SandboxPolicyEngine | Active qua IsolatedExecutionSubstrate của run_test_suite | S1/S2; wrapper screening không phải OS/filesystem isolation chung |
| ExecutionSubstrateFactory | Default sandboxed/workspace-write; chưa thấy production create caller | Env factory không chứng minh run_command/run_node_script được sandbox |
| EvidenceDrivenControlPlane (EDCP) | Export/API/tests; chưa thấy AgentLoop/kernel instantiate | Chưa phải central governor runtime dù comment gọi như vậy |
| AcceptancePolicy / EDCP CompletionGate | Chỉ qua EDCP | Reject whole-snapshot diagnostics; khác changed-files critic live. Readonly early return ở completion-gate.ts:35 bỏ contract/hypothesis/submission checks; là integration risk, chưa phải live regression |
| EDCP VerificationContractFactory | STANDARD diagnostics+test; HIGH/CRITICAL regression | Khác live risk-appropriate verification/exemptions; không tích hợp nguyên trạng |
| StrategyPolicyEvaluator / AdaptiveComputeController | Chỉ qua EDCP; pressure evaluation chưa thấy runtime caller | Declarative tiers0–4, budgets0–32768; flags hypothesis/parallel/deep causal chưa inject hiện tại |
| EDCP reasoning state | getState hardcoded pressure; reset không clear transitions | Debt API: high-risk reevaluation có thể nâng tier khi không có evidence mới; không gán thành live noise |

Nguồn API phụ: [evidence-driven-control-plane.ts:43](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control-plane/evidence-driven-control-plane.ts:43), [completion-gate.ts:35](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control-plane/critic/completion-gate.ts:35), [strategy-policy.ts:13](C:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/control-plane/reasoning/strategy-policy.ts:13). Connectivity được subagent kiểm tra bằng graph và text corroboration current source; không lấy comment “central governor” làm bằng chứng runtime integration.

## Thứ tự xử lý đề xuất

1. Đóng authority bypass A1/A2/A5 và automatic discard R1. Shared tool effects/scope phải là dispatch authority.
2. Thống nhất completion entry point C1; sửa state leak C2/P1 và false-success guidance C3/P3.
3. Canonical evidence record: tool call ID, terminal outcome, command/target, expected result, mutation version, turn/task scope; mọi verifier/critic/hypothesis/Git consumer dùng nó.
4. Canonical authorized scope + phase decision; render CORE/skills/recovery/playbooks từ verdict đó, sửa A3/A4/A6/P2/P4/P5/P9.
5. Điều chỉnh Git prerequisites/PR reads/multiple branch actions G1–G3; giữ explicit permission cho từng mutation.
6. Prompt budget giữ authority/active task/evidence, hạ và dedup advice; hoàn thiện shadow/config semantics.

Các hướng sửa ở đây là đề xuất sau audit; chưa triển khai. Một đợt sửa nên chia nhỏ theo nhóm, dùng impact trước symbol edit, rồi chạy các scenario regression khi người dùng yêu cầu kiểm tra.
