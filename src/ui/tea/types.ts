import type { KernelEvents } from '../../kernel/kernel.js';
import type { CompactionStatus } from '../compaction-status.js';

export type KernelMsg = { [K in keyof KernelEvents]: { type: 'kernel'; event: K; args: Parameters<KernelEvents[K]> } }[keyof KernelEvents];
export interface KeyMsg { type: 'key'; key: string; text?: string; mouse?: { x: number; y: number }; now: number }
export type Action = 'compact' | 'editor' | 'quit' | 'sidebar' | 'diff' | 'palette' | 'mode' | 'clear';
export type Msg = KeyMsg | KernelMsg
  | { type: 'resize'; width: number; height: number }
  | { type: 'tick'; now: number }
  | { type: 'action'; action: Action }
  | { type: 'log'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'question'; prompt: string; active: boolean; permission?: PermissionCard; sessionId?: string }
  | { type: 'grill'; open: boolean; question?: string; options?: GrillOption[]; loading?: boolean; sessionId?: string }
  | { type: 'grill-loading'; loading: boolean }
  | { type: 'sessions'; open?: boolean; tabs?: SessionTab[]; activeId?: string }
  | { type: 'sessions-adopt'; activeId: string }
  | { type: 'session-transcript'; sessionId: string; entries: TranscriptEntry[] }
  | { type: 'compose'; text: string }
  | { type: 'completions'; values: Completion[] }
  | { type: 'diff'; text: string; reveal?: boolean }
  | { type: 'metadata'; data: Partial<SidebarModel> }
  | { type: 'compaction'; status: CompactionStatus | null };

/** Effect descriptions are interpreted by Program, never executed by reducers. */
export type Cmd = { type: 'submit' | 'answer'; text: string }
  | { type: 'grill-pick'; text: string }
  | { type: 'grill-cancel' }
  | { type: 'session-switch'; sessionId: string }
  | { type: 'session-new'; sessionId?: string }
  | { type: 'session-close'; sessionId: string }
  | { type: 'session-delete'; sessionId: string }
  | { type: 'copy'; text: string }
  | { type: 'abort' | 'quit' | 'compact' | 'editor' }
  | { type: 'complete'; value: string; cursor: number }
  | { type: 'mode'; mode: Mode };
export type Mode = 'PLAN' | 'IMPLEMENT';
export type Focus = 'composer' | 'viewport' | 'sidebar' | 'palette' | 'diff' | 'grill' | 'sessions';
export interface GrillOption { id: string; label: string; detail?: string; source: 'llm' | 'heuristic' | 'user' }
export interface GrillModel { open: boolean; question: string; options: GrillOption[]; selected: number; loading: boolean; /** session sở hữu modal (mặc định tab đang xem lúc mở) */ sessionId?: string }
export interface Completion { label: string; value: string; cursor?: number; kind?: 'file' | 'session' }
export interface ComposerModel {
  selection?: { anchor: number; head: number };
  pastedBlocks?: { start: number; end: number; text: string }[];
  value: string; cursorOffset: number; history: string[]; historyIndex: number;
  draft: string; completions: Completion[]; selected: number; completionDismissed: boolean;
}
export interface PermissionCard { toolName: string; target: string; summary: string; riskLevel: string; category: string; suggestedTool?: string }
export interface TranscriptEntry { kind: 'user' | 'answer' | 'thought' | 'tool' | 'step' | 'log' | 'permission'; text: string; permission?: PermissionCard }
/** Một tab = một session chạy song song trong cùng cửa sổ terminal. Entries cache giữ transcript riêng mỗi tab. */
export interface SessionTab { id: string; title: string; busy?: boolean; hidden?: boolean; /** true khi đã biết chắc có/không lịch sử (tab mới tạo hoặc đã hydrate) */ historyKnown?: boolean; /** stream buffer riêng để task nền không lọt vào viewport tab khác */ thinking?: string; answerStream?: string; /** số entries mới khi tab chạy nền */ unread?: number; /** chrome riêng theo tab: draft/input, diff, tools đang chạy, tokens */ composer?: ComposerModel; diff?: DiffViewerModel; tools?: string[]; tokens?: number; lastActive?: number; entries?: TranscriptEntry[] }
export interface SessionTabsModel { open: boolean; selected: number; tabs: SessionTab[]; activeId: string; /** switch do TEA khởi xướng, kernel chưa confirm — metadata không được revert */ pendingActiveId?: string }
export interface ViewportModel { entries: TranscriptEntry[]; thinking: string; answerStream: string; offset: number; pinned: boolean; collapsed: boolean }
export interface SidebarModel { visible: boolean; workspace: string; model: string; session: string; sessions: string[]; tools: string[]; files: string[]; invariants: string[]; tokens: number; maxTokens: number;
  /** IDs song song với `sessions` (vốn là tên hiển thị) + id active — để tab-strip switch đúng session. */
  sessionIds?: string[]; activeSessionId?: string }
export interface PaletteItem { id: string; label: string; description: string; action?: Action }
export interface PaletteModel { open: boolean; query: string; selected: number; items: PaletteItem[] }
export interface DiffViewerModel { visible: boolean; text: string; offset: number; split: boolean; collapsed: number[]; hunk: number }
export interface StatuslineModel { busy: boolean; aborting: boolean; step: number; maxSteps: number; phase: string; retry: string; notice: string; noticeUntil?: number; stoppingUntil?: number; compaction: CompactionStatus | null; compactionUntil?: number; frame: number; /** tab sở hữu task đang chạy — event kernel route về tab này, không lọt sang tab đang xem */ busySessionId?: string }
export interface RootModel {
  selection?: { target: 'composer' | 'viewport'; anchor: number; head: number; dragging: boolean; lines?: string[]; sourceLines?: string[]; entries?: TranscriptEntry[]; width?: number; viewportOffset?: number; composerCursor?: number };
  width: number; height: number; mode: Mode; focus: Focus; leaderUntil: number;
  composer: ComposerModel; viewport: ViewportModel; sidebar: SidebarModel;
  palette: PaletteModel; diff: DiffViewerModel; status: StatuslineModel;
  grill: GrillModel;
  sessions: SessionTabsModel;
  question: { active: boolean; prompt: string; draft?: ComposerModel; permission?: PermissionCard; selected: number; sessionId?: string };
}
export interface Model<M> { init(): [M, Cmd[]]; update(msg: Msg, model: M): [M, Cmd[]]; view(model: M): string }
export type Sub = (send: (msg: Msg) => void) => () => void;
