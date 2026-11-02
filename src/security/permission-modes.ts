/**
 * Nguồn duy nhất cho danh sách mode: union `PermissionMode` suy ra từ mảng này,
 * nên thêm mode không thể lệch với `isPermissionMode`/picker.
 */
export const PERMISSION_MODE_IDS = [
  'always_ask',
  'ask_sensitive',
  'auto_approve',
  'read_only',
  'full_access',
] as const;

export type PermissionMode = (typeof PERMISSION_MODE_IDS)[number];

/** Một mode permission kèm mô tả ngắn để UI và log đọc từ cùng một nguồn. */
export interface PermissionModeMeta {
  id: PermissionMode;
  label: string;
  detail: string;
  /** Nới quyền so với mặc định — nơi chọn phải xác nhận thêm. */
  expandsPrivileges?: boolean;
}

/** Record theo mode ⇒ thiếu mô tả cho mode mới là lỗi compile. */
const MODE_META: Record<PermissionMode, { detail: string; expandsPrivileges?: boolean }> = {
  always_ask: { detail: 'Hỏi mọi thao tác ghi / chạy lệnh.' },
  ask_sensitive: { detail: 'Chỉ hỏi thao tác nhạy cảm; thao tác low-risk tự qua. (mặc định)' },
  auto_approve: { detail: 'Tự approve mọi thao tác; các chặn an toàn vẫn còn hiệu lực.' },
  read_only: { detail: 'Chỉ đọc; mọi tool thay đổi trạng thái bị từ chối.' },
  full_access: { detail: 'Mở 7 gate harness (hỏi quyền, phá hệ thống, ranh giới workspace, Docker isolation, phase masking, file protected, scrub env con). Giữ cứng: push main/master, redaction secrets, deny rule .minus/hooks.json, git policy. Cần gõ lại tên mode.', expandsPrivileges: true },
};

export const PERMISSION_MODES: readonly PermissionModeMeta[] =
  PERMISSION_MODE_IDS.map((id) => ({ id, label: id, ...MODE_META[id] }));

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODE_IDS as readonly string[]).includes(value);
}

export function permissionModeMeta(id: PermissionMode): PermissionModeMeta {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[1];
}
