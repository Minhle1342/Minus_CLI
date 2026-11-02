import type { PermissionMode } from './permission-manager.js';

/** Một mode permission kèm mô tả ngắn để UI và log đọc từ cùng một nguồn. */
export interface PermissionModeMeta {
  id: PermissionMode;
  label: string;
  detail: string;
  /** Nới quyền so với mặc định — nơi chọn phải xác nhận thêm. */
  expandsPrivileges?: boolean;
}

export const PERMISSION_MODES: readonly PermissionModeMeta[] = [
  { id: 'always_ask', label: 'always_ask', detail: 'Hỏi mọi thao tác ghi / chạy lệnh.' },
  { id: 'ask_sensitive', label: 'ask_sensitive', detail: 'Chỉ hỏi thao tác nhạy cảm; thao tác low-risk tự qua. (mặc định)' },
  { id: 'auto_approve', label: 'auto_approve', detail: 'Tự approve mọi thao tác; các chặn an toàn vẫn còn hiệu lực.' },
  { id: 'read_only', label: 'read_only', detail: 'Chỉ đọc; mọi tool thay đổi trạng thái bị từ chối.' },
  { id: 'full_access', label: 'full_access', detail: 'Mở 7 gate harness (hỏi quyền, phá hệ thống, ranh giới workspace, Docker isolation, phase masking, file protected, scrub env con). Giữ cứng: push main/master, redaction secrets, deny rule .minus/hooks.json, git policy. Cần gõ lại tên mode.', expandsPrivileges: true },
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.some((mode) => mode.id === value);
}

export function permissionModeMeta(id: PermissionMode): PermissionModeMeta {
  return PERMISSION_MODES.find((mode) => mode.id === id) ?? PERMISSION_MODES[1];
}
