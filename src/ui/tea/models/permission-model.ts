import type { KeyMsg, PermissionChoice, PermissionPickerModel, PermissionTier, RootModel, Cmd } from '../types.js';
import { color, fit, lipGlossTheme, tokyoNight, wrap } from '../styles/theme.js';
import { PERMISSION_MODES, permissionModeMeta } from '../../../security/permission-modes.js';

export function createPermissionModel(): PermissionPickerModel {
  return {
    open: false,
    tier: 'actions',
    selected: 0,
    globalMode: 'ask_sensitive',
    projectMode: null,
    effectiveMode: 'ask_sensitive',
    planModeActive: false,
    approvalCount: 0,
  };
}

export interface PermissionRow {
  id: string;
  label: string;
  detail?: string;
  /** dấu ● — giá trị đang áp dụng, để không chọn lại cái đang bật mà tưởng vừa đổi. */
  current?: boolean;
  danger?: boolean;
  /** điều hướng xuống tầng con thay vì chốt lựa chọn. */
  goto?: PermissionTier;
  choice?: PermissionChoice;
}

/** Hàng đang hiển thị của tầng hiện tại — nguồn duy nhất cho cả render lẫn key routing. */
export function permissionRows(picker: PermissionPickerModel): PermissionRow[] {
  if (picker.tier === 'global') {
    return PERMISSION_MODES.map((mode) => ({
      id: `global:${mode.id}`,
      label: mode.id,
      detail: picker.planModeActive ? `${mode.detail} · PLAN đang bật: áp khi exit` : mode.detail,
      current: picker.globalMode === mode.id,
      danger: mode.expandsPrivileges,
      choice: { action: 'set-global', mode: mode.id },
    }));
  }
  if (picker.tier === 'project') {
    const rows: PermissionRow[] = PERMISSION_MODES.map((mode) => ({
      id: `project:${mode.id}`,
      label: mode.id,
      detail: mode.detail,
      current: picker.projectMode === mode.id,
      danger: mode.expandsPrivileges,
      choice: { action: 'set-project', mode: mode.id },
    }));
    rows.push({
      id: 'project:clear',
      label: '(none — global mode applies)',
      detail: 'Xóa override của project này.',
      current: picker.projectMode === null,
      choice: { action: 'clear-project' },
    });
    return rows;
  }
  if (picker.tier === 'reset') {
    return [
      {
        id: 'reset:confirm',
        label: `Xóa ${picker.approvalCount} category đã auto-approve`,
        detail: picker.approvalCount === 0
          ? 'Session này chưa có category nào được auto-approve.'
          : 'Chỉ ảnh hưởng session hiện tại; approve lại từng category để bật trở lại.',
        danger: true,
        choice: { action: 'reset-approvals' },
      },
      { id: 'reset:back', label: 'Quay lại', detail: 'Không xóa gì.', goto: 'actions' },
    ];
  }
  return [
    {
      id: 'global',
      label: 'Đổi mode toàn cục',
      detail: `setMode · hiện: ${picker.globalMode} · mất khi restart app`,
      goto: 'global',
    },
    {
      id: 'project',
      label: 'Project override',
      detail: `setProjectMode + lưu session · hiện: ${picker.projectMode ?? '(none)'} · vĩnh viễn theo repo này`,
      goto: 'project',
    },
    {
      id: 'reset',
      label: 'Reset approvals',
      detail: `Xóa ${picker.approvalCount} category đã auto-approve trong session`,
      goto: 'reset',
    },
  ];
}

const TIER_BACK_TO_ACTION: Record<PermissionTier, string> = {
  actions: 'actions',
  global: 'global',
  project: 'project',
  reset: 'reset',
};

/** Key routing cho permission modal — đè lên input/composer (sau question/grill). */
export function permissionKey(msg: KeyMsg, model: RootModel): [RootModel, Cmd[]] | undefined {
  const picker = model.permission;
  if (!picker.open || model.focus !== 'permission') return undefined;
  const rows = permissionRows(picker);
  const count = rows.length;
  const sel = count ? Math.min(picker.selected, count - 1) : 0;

  const close = (): RootModel => ({
    ...model,
    focus: 'composer' as const,
    permission: { ...picker, open: false, tier: 'actions', selected: 0 },
  });

  // Esc ở tầng con quay lại menu hành động, Esc ở tầng 1 mới hủy cả modal.
  if (msg.key === 'escape' && picker.tier !== 'actions') {
    const actionIndex = Math.max(0, permissionRows({ ...picker, tier: 'actions' })
      .findIndex((row) => row.id === TIER_BACK_TO_ACTION[picker.tier]));
    return [{ ...model, permission: { ...picker, tier: 'actions', selected: actionIndex } }, []];
  }
  if (msg.key === 'escape' || msg.key === 'ctrl+c') {
    return [close(), [{ type: 'permission-cancel' }]];
  }

  if (msg.key === 'up' || msg.key === 'left') {
    if (!count) return [model, []];
    return [{ ...model, permission: { ...picker, selected: (sel + count - 1) % count } }, []];
  }
  if (msg.key === 'down' || msg.key === 'right') {
    if (!count) return [model, []];
    return [{ ...model, permission: { ...picker, selected: (sel + 1) % count } }, []];
  }

  const activate = (row: PermissionRow): [RootModel, Cmd[]] => {
    if (row.goto) return [{ ...model, permission: { ...picker, tier: row.goto, selected: 0 } }, []];
    if (!row.choice) return [model, []];
    return [close(), [{ type: 'permission-pick', choice: row.choice }]];
  };

  if (msg.key === 'enter') {
    if (!count) return [model, []];
    return activate(rows[sel]);
  }

  // Phím số 1..9 chọn nhanh; các phím khác không lọt xuống composer.
  const digit = msg.text && /^[1-9]$/.test(msg.text) ? Number(msg.text) - 1 : -1;
  if (digit >= 0 && digit < count) return activate(rows[digit]);
  return [model, []];
}

export function permissionView(picker: PermissionPickerModel, width: number, height: number): string[] {
  const panelWidth = Math.max(20, Math.min(width - 4, 72));
  const inner = Math.max(1, panelWidth - 2);
  const rows = permissionRows(picker);
  const sel = rows.length ? Math.min(picker.selected, rows.length - 1) : 0;
  const body: string[] = [];
  const title = picker.tier === 'actions' ? 'PERMISSIONS · chọn thao tác' : `PERMISSIONS · ${picker.tier === 'global' ? 'mode toàn cục' : picker.tier === 'project' ? 'project override' : 'reset approvals'}`;
  body.push(color(tokyoNight.purple, title) + color(tokyoNight.muted, ' · Esc quay lại/hủy'));
  body.push(color(tokyoNight.muted, `Global ${picker.globalMode} · Project ${picker.projectMode ?? '(none)'} · Ở đây: ${picker.effectiveMode}`));
  if (picker.planModeActive) body.push(color(tokyoNight.yellow, 'PLAN đang bật · chọn mode sẽ áp khi exit'));
  body.push('');
  rows.forEach((row, i) => {
    const marker = i === sel ? color(tokyoNight.cyan, '› ') : '  ';
    const badge = row.current ? color(tokyoNight.green, '● ') : row.danger ? color(tokyoNight.red, '⚠ ') : '';
    const label = row.danger && i !== sel ? color(tokyoNight.red, row.label) : row.label;
    body.push(`${marker}${badge}${color(tokyoNight.cyan, `${i + 1}.`)} ${label}${row.goto ? color(tokyoNight.muted, ' ›') : ''}`);
    if (i === sel && row.detail) {
      for (const line of wrap(color(tokyoNight.muted, `    ${row.detail}`), inner).slice(0, 2)) body.push(line);
    }
  });
  body.push('');
  body.push(color(tokyoNight.muted, '↑↓ di chuyển · Enter chọn · Esc về menu · Ctrl+C hủy'));
  const bodyHeight = Math.min(height - 4, body.length + 2);
  const content = body.slice(0, Math.max(1, bodyHeight - 2));
  return lipGlossTheme.panel.render(content.join('\n'), panelWidth, bodyHeight).map((row) => fit(row, panelWidth));
}

/** Label mode cho notice/log — đọc từ cùng một bảng metadata. */
export function permissionModeLabel(mode: PermissionPickerModel['globalMode']): string {
  return permissionModeMeta(mode).label;
}
