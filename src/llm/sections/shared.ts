/**
 * Canonical prompt macros.
 * Define a cross-cutting invariant once and interpolate it into the sections
 * that need it, instead of repeating the full syntax in every module.
 */

/** Background-launch rule shared by CORE and the tool/phase modules. */
export const BACKGROUND_LAUNCH_RULE = 'dispatch run_command with WaitMsBeforeAsync=5000 in background.';

/** Proactive server-launch directive: launch in background, never print passive snippets. */
export const PROACTIVE_SERVER_LAUNCH_RULE = 'for servers/watchers/background daemons, NEVER output passive shell snippets; proactively call run_command with WaitMsBeforeAsync=5000 in background and verify startup when asked to run, start, or test a server.';

/** Deletion/rename safety rule: file tools only, never destructive shell rm/del/mv. */
export const FILE_MUTATION_SAFETY_RULE = 'MUST use `write_file` to create or overwrite files and `replace_text` to edit existing files; MUST NEVER run `rm`, `del`, `rmdir`, `Remove-Item`, or `mv` via `run_command` - destructive shell deletes are forbidden and trigger CRITICAL permission gates.';

/**
 * Canonical root-cause protocol. Kept in this leaf module so both the error
 * detective section and ToolSynergyAdvisor share one string without a cycle.
 */
export const ROOT_CAUSE_STEPS = '1.[Extract Coordinates] -> 2.[Backward Causal Trace] -> 3.[Falsifiable Hypothesis] -> 4.[Smallest Coherent Fix] -> 5.[Verify]';
