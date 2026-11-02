import type { KernelEvents } from '../../kernel/kernel.js';
import type { CompactionStatus } from '../compaction-status.js';
import type { PermissionMode } from '../../security/permission-manager.js';

export type KernelMsg = { [K in keyof KernelEvents]: { type: 'kernel'; event: K; args: Parameters<KernelEvents[K]> } }[keyof KernelEvents];
export interface KeyMsg { type: 'key'; key: string; text?: string; mouse?: { x: number; y: number }; now: number }
export type Action = 'compact' | 'editor' | 'quit' | 'sidebar' | 'diff' | 'palette' | 'mode' | 'clear' | 'subagents';
export type Msg = KeyMsg | KernelMsg
  | { type: 'resize'; width: number; height: number }
  | { type: 'tick'; now: number }
  | { type: 'action'; action: Action }
  | { type: 'log'; text: string; /** session sở hữu dòng log (output của subagent) → ghi vào tab con */ sessionId?: string }
  | { type: 'notice'; text: string }
  | { type: 'busy'; busy: boolean; /** session sở hữu task (đa task song song); thiếu → tab đang xem */ sessionId?: string }
  | { type: 'question'; prompt: string; active: boolean; permission?: PermissionCard; sessionId?: string }
  | { type: 'grill'; open: boolean; question?: string; options?: GrillOption[]; loading?: boolean; sessionId?: string }
  | { type: 'grill-loading'; loading: boolean }
  | { type: 'model-picker'; open: boolean; options?: ModelPickerOption[]; sessionId?: string }
  | { type: 'permission'; open: boolean; state?: PermissionStateSnapshot; sessionId?: string }
  | { type: 'full-access'; on: boolean }
  | { type: 'sessions'; open?: boolean; tabs?: SessionTab[]; activeId?: string }
  | { type: 'sessions-adopt'; activeId: string }
  | { type: 'session-transcript'; sessionId: string; entries: TranscriptEntry[] }
  | { type: 'workspace-switch'; workspace: string; activeSessionId: string; sessionIds?: string[]; titles?: string[]; entries?: TranscriptEntry[]; model?: string; defaultModel?: string }
  | { type: 'compose'; text: string }
  | { type: 'completions'; values: Completion[] }
  | { type: 'diff'; text: string; reveal?: boolean }
  | { type: 'file'; path: string; text: string; truncated?: boolean }
  | { type: 'metadata'; data: Partial<SidebarModel> }
  | { type: 'compaction'; status: CompactionStatus | null };

export interface SwitchWorkspaceOptions {
  workspace: string;
  activeSessionId: string;
  sessionIds?: string[];
  titles?: string[];
  entries?: TranscriptEntry[];
  model?: string;
  defaultModel?: string;
}

/** Effect descriptions are interpreted by Program, never executed by reducers. */
export type Cmd = { type: 'submit' | 'answer'; text: string }
  | { type: 'hot-model-switch'; model: string }
  | { type: 'grill-pick'; text: string }
  | { type: 'grill-cancel' }
  | { type: 'model-pick'; id: string; name: string }
  | { type: 'model-cancel' }
  | { type: 'permission-pick'; choice: PermissionChoice }
  | { type: 'permission-cancel' }
  | { type: 'session-switch'; sessionId: string }
  | { type: 'session-new'; sessionId?: string }
  | { type: 'session-close'; sessionId: string }
  | { type: 'session-delete'; sessionId: string }
  | { type: 'copy'; text: string }
  | { type: 'abort' | 'quit' | 'compact' | 'editor' }
  | { type: 'complete'; value: string; cursor: number }
  | { type: 'file-open'; path: string }
  | { type: 'mode'; mode: Mode };
export type Mode = 'PLAN' | 'IMPLEMENT';
export type Focus = 'composer' | 'viewport' | 'sidebar' | 'palette' | 'diff' | 'file' | 'grill' | 'sessions' | 'model-picker' | 'permission' | 'subagents';
export interface GrillOption { id: string; label: string; detail?: string; source: 'llm' | 'heuristic' | 'user' }
export interface GrillModel { open: boolean; question: string; options: GrillOption[]; selected: number; loading: boolean; /** session sở hữu modal (mặc định tab đang xem lúc mở) */ sessionId?: string; customInput?: { active: boolean; value: string; cursor: number } }
/** Một entry trong modal chọn model (/model): mirror AVAILABLE_MODELS của cli-ui. */
export interface ModelPickerOption { id: string; name: string; desc?: string; provider?: string; recommended?: boolean; /** true = model đang active của tab */ current?: boolean }
/** Modal chọn model đè lên viewport — cùng ngôn ngữ visual/key với grill. */
export interface ModelPickerModel { open: boolean; options: ModelPickerOption[]; selected: number; /** chuỗi lọc fuzzy (mirror palette query) */ query: string; /** session sở hữu modal (mặc định tab đang xem lúc mở) */ sessionId?: string }
export interface SubagentsModalModel { open: boolean; selected: number }
/** Tầng của permission modal: menu hành động → danh sách value của một hành động. */
export type PermissionTier = 'actions' | 'global' | 'project' | 'reset';
/** Trạng thái permission mà outer (slash) cấp khi mở modal — modal không tự đọc kernel. */
export interface PermissionStateSnapshot {
  globalMode: PermissionMode;
  projectMode: PermissionMode | null;
  effectiveMode: PermissionMode;
  planModeActive: boolean;
  approvalCount: number;
}
/** Lựa chọn hoàn tất trong modal; outer áp dụng rồi mới báo kết quả. */
export interface PermissionChoice {
  action: 'set-global' | 'set-project' | 'clear-project' | 'reset-approvals';
  mode?: PermissionMode;
}
export interface PermissionPickerModel extends PermissionStateSnapshot {
  open: boolean;
  tier: PermissionTier;
  selected: number;
  /** session sở hữu modal (mặc định tab đang xem lúc mở) */ sessionId?: string;
}
export interface Completion { label: string; value: string; cursor?: number; kind?: 'file' | 'session' }
export interface ComposerModel {
  selection?: { anchor: number; head: number };
  pastedBlocks?: { start: number; end: number; text: string }[];
  value: string; cursorOffset: number; history: string[]; historyIndex: number;
  draft: string; completions: Completion[]; selected: number; completionDismissed: boolean;
}
export interface PermissionCard { toolName: string; target: string; summary: string; riskLevel: string; category: string; suggestedTool?: string; diff?: string }
export interface TranscriptEntry { kind: 'user' | 'answer' | 'live' | 'thought' | 'tool' | 'step' | 'log' | 'permission' | 'compaction'; text: string; permission?: PermissionCard; expanded?: boolean; /** thinking blocks only: duration in ms, absent when replayed from history */ ms?: number }
/** Một tab = một session chạy song song trong cùng cửa sổ terminal. Entries cache giữ transcript riêng mỗi tab. */
export interface SessionTab { id: string; title: string; busy?: boolean; hidden?: boolean; awaitingInput?: boolean; /** true khi đã biết chắc có/không lịch sử (tab mới tạo hoặc đã hydrate) */ historyKnown?: boolean; /** stream buffer riêng để task nền không lọt vào viewport tab khác */ thinking?: string; answerStream?: string; thinkingStartedAt?: number; /** số entries mới khi tab chạy nền */ unread?: number; /** chrome riêng theo tab: draft/input, diff, tools đang chạy, tokens */ composer?: ComposerModel; diff?: DiffViewerModel; tools?: string[]; tokens?: number; /** model tường minh của tab (/model scope theo tab); undefined = theo default chung */ model?: string; lastActive?: number; entries?: TranscriptEntry[]; /** tab transcript của subagent — chỉ để xem, không gõ vào */ subagent?: boolean }
export interface SessionTabsModel { open: boolean; selected: number; tabs: SessionTab[]; activeId: string; activeQuestionSessionId?: string; /** model mặc định chung cho tab chưa chọn riêng (đồng bộ từ global /model + metadata) */ defaultModel?: string; /** switch do TEA khởi xướng, kernel chưa confirm — metadata không được revert */ pendingActiveId?: string }
export interface ViewportModel { entries: TranscriptEntry[]; thinking: string; answerStream: string; offset: number; pinned: boolean; collapsed: boolean; /** epoch ms of the first thinking chunk in the live buffer */ thinkingStartedAt?: number }
export interface SidebarModel { visible: boolean; workspace: string; model: string; session: string; sessions: string[]; tools: string[]; files: string[]; invariants: string[]; tokens: number; maxTokens: number; /** dòng đang chọn trong MODIFIED FILES khi sidebar có focus */ selected?: number;
  /** Model mặc định chung (carrier cho metadata, không render trực tiếp — sidebar.model luôn là model của tab đang xem). */
  defaultModel?: string;
  /** IDs song song với `sessions` (vốn là tên hiển thị) + id active — để tab-strip switch đúng session. */
  sessionIds?: string[]; activeSessionId?: string }
export interface PaletteItem { id: string; label: string; description: string; action?: Action }
export interface PaletteModel { open: boolean; query: string; selected: number; items: PaletteItem[] }
export interface DiffViewerModel { visible: boolean; text: string; offset: number; split: boolean; collapsed: number[]; hunk: number }
export interface FileViewModel { visible: boolean; path: string; text: string; offset: number; truncated?: boolean }
export interface StatuslineModel { busy: boolean; aborting: boolean; step: number; maxSteps: number; phase: string; retry: string; notice: string; noticeUntil?: number; stoppingUntil?: number; compaction: CompactionStatus | null; compactionUntil?: number; frame: number; /** tab sở hữu task đang chạy — event kernel route về tab này, không lọt sang tab đang xem */ busySessionId?: string }
export interface RootModel {
  selection?: { target: 'composer' | 'viewport'; anchor: number; head: number; dragging: boolean; lines?: string[]; sourceLines?: string[]; entries?: TranscriptEntry[]; width?: number; viewportOffset?: number; composerCursor?: number };
  width: number; height: number; mode: Mode; focus: Focus; leaderUntil: number;
  /** Badge FULL ACCESS thường trực — do Outer đẩy khi effectiveMode() đổi. */
  fullAccess?: boolean;
  composer: ComposerModel; viewport: ViewportModel; sidebar: SidebarModel;
  palette: PaletteModel; diff: DiffViewerModel; file: FileViewModel; status: StatuslineModel;
  grill: GrillModel;
  modelPicker: ModelPickerModel;
  permission: PermissionPickerModel;
  sessions: SessionTabsModel;
  subagents: SubagentsModalModel;
  previousActiveSessionId?: string;
  question: { active: boolean; prompt: string; draft?: ComposerModel; permission?: PermissionCard; selected: number; sessionId?: string };
}
export interface Model<M> { init(): [M, Cmd[]]; update(msg: Msg, model: M): [M, Cmd[]]; view(model: M): string }
export type Sub = (send: (msg: Msg) => void) => () => void;
