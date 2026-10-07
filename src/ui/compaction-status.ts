export interface CompactionStatus {
  scope: 'turn' | 'step';
  state: 'running' | 'completed' | 'skipped' | 'failed';
  savedTokens?: number;
  remainingTokens?: number;
}

let current: CompactionStatus | null = null;
const listeners = new Set<(status: CompactionStatus | null) => void>();

export const compactionStatus = {
  get: () => current,
  hasListeners: () => listeners.size > 0,
  set(status: CompactionStatus | null): void {
    current = status;
    for (const listener of listeners) listener(status);
  },
  subscribe(listener: (status: CompactionStatus | null) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function formatCompactionStatus(status: CompactionStatus): string {
  if (status.state === 'running') return `Đang compact ${status.scope}…`;
  if (status.state === 'failed') return `Compact ${status.scope} thất bại · giữ context`;
  if (status.state === 'skipped') return `Compact ${status.scope} không áp dụng · giữ context`;
  return `Compact ${status.scope} hoàn tất · −${status.savedTokens ?? 0} tok · còn ${status.remainingTokens ?? 0} tok`;
}
