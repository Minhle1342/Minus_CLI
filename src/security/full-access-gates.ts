import type { PermissionMode } from './permission-manager.js';

/**
 * Gate duy nhất liệt kê những cánh cửa `full_access` mở ra. Mọi site bypass trong
 * codebase phải đi qua `isGateOpen`/`GateReader` để `grep 'isGateOpen('` liệt kê
 * được toàn bộ bề mặt của chế độ (design §7).
 */
export type FullAccessGate =
  | 'approval_prompt'
  | 'host_system_risk'
  | 'workspace_boundary'
  | 'docker_isolation'
  | 'phase_masking'
  | 'protected_files'
  | 'child_env_scrub';

/** Cửa người dùng cấm mở bằng mọi giá — không mode, không approval, không env var nào chạm tới. */
export type NonBypassableGate = 'push_to_main' | 'output_redaction' | 'repo_hooks' | 'git_policy';

export const FULL_ACCESS_GATES: readonly FullAccessGate[] = [
  'approval_prompt',
  'host_system_risk',
  'workspace_boundary',
  'docker_isolation',
  'phase_masking',
  'protected_files',
  'child_env_scrub',
];

export const NON_BYPASSABLE_GATES: readonly NonBypassableGate[] = [
  'push_to_main',
  'output_redaction',
  'repo_hooks',
  'git_policy',
];

/**
 * Đọc trạng thái gate. Module thuần (sandbox-policy, env-scrub, workspace) nhận
 * reader qua tham số optional; mặc định là `CLOSED_GATES` ⇒ hành vi y hệt hôm nay.
 */
export type GateReader = (gate: FullAccessGate) => boolean;

export const CLOSED_GATES: GateReader = () => false;

export function isGateOpen(gate: FullAccessGate, mode: PermissionMode): boolean {
  return mode === 'full_access' && FULL_ACCESS_GATES.includes(gate);
}

/** Reader sống: đọc `effectiveMode()` mỗi lần gọi, không cache để state không lệch. */
export function gatesForMode(mode: PermissionMode): GateReader {
  return (gate) => isGateOpen(gate, mode);
}

/**
 * Reader từ thứ có `effectiveMode()` (PermissionManager, hoặc ctx.permissionManager).
 * Thiếu nguồn — hoặc nguồn chỉ implement một phần (`checkPermission`/`hasApprovalChannel`
 * thôi, kiểu stub ở các call site cũ) ⇒ đóng (fail-closed): tool chạy ngoài kernel không
 * tự suy ra full access.
 */
export function gatesFromPermissionManager(source?: { effectiveMode?: () => PermissionMode } | null): GateReader {
  const readMode = source?.effectiveMode;
  return typeof readMode === 'function'
    ? (gate) => isGateOpen(gate, readMode.call(source))
    : CLOSED_GATES;
}

/** Chuỗi trạng thái gate cho log, badge và `/permissions status`. */
export function gateReport(mode: PermissionMode): string {
  if (mode !== 'full_access') return 'full access tắt · mọi gate còn hiệu lực';
  return `FULL ACCESS · mở: ${FULL_ACCESS_GATES.join(', ')} · không bao giờ mở: ${NON_BYPASSABLE_GATES.join(', ')}`;
}
