/**
 * COMPLETION SECTIONS.
 *
 * - SECTION_FINAL_ANSWER_RECEIPT (T2, always-on): shapes the final answer for
 *   every task type, including read-only answers FinalAnswerGuard never checks.
 *   Complements the guard: the guard rejects outcome-free answers after
 *   mutations at runtime, this avoids producing them in the first place.
 * - SECTION_PRE_SUBMIT_EVIDENCE_AUDIT (T3, submit-time only): injected when the
 *   harness is about to submit (ready-to-submit or a read-only submit), so the
 *   claim/evidence mapping costs tokens only on the final step. It complements
 *   the runtime CompletionEvidenceGate instead of duplicating it: the gate
 *   rejects unsupported claims after the fact, this audit avoids producing the
 *   rejected attempt.
 */
export const SECTION_FINAL_ANSWER_RECEIPT = `### FINAL ANSWER RECEIPT:
   - Close every task with a compact receipt of the concrete outcome: what changed (or the direct answer for read-only questions), then the verification actually observed -- never planned, stale, or unexecuted checks.
   - Scale it to the task: one line for a read-only answer, a short list for a multi-file change; do not re-narrate steps already visible in tool output.
   - A deliberately deferred decision is not an outcome: call ask_user before finishing rather than assuming it (SPEC CLARIFICATION POLICY defines when/how). Git-specific reporting follows the active GIT WORKFLOW module; tool selection follows the TOOL PLAYBOOKS.`;

export const SECTION_PRE_SUBMIT_EVIDENCE_AUDIT = `[PRE-SUBMIT EVIDENCE AUDIT]:
- Match claims to THIS turn's observed evidence; drop unverified.
- Name the exact check run and its scope; one pass is not the suite: claim only what ran.
- Report only authorized work.`;
