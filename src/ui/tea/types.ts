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
  | { type: 'busy'; busy: boolean }
  | { type: 'question'; prompt: string; active: boolean; permission?: PermissionCard }
  | { type: 'compose'; text: string }
  | { type: 'completions'; values: Completion[] }
  | { type: 'diff'; text: string; reveal?: boolean }
  | { type: 'metadata'; data: Partial<SidebarModel> }
  | { type: 'compaction'; status: CompactionStatus | null };

/** Effect descriptions are interpreted by Program, never executed by reducers. */
export type Cmd = { type: 'submit' | 'answer'; text: string }
  | { type: 'abort' | 'quit' | 'compact' | 'editor' }
  | { type: 'complete'; value: string; cursor: number }
  | { type: 'mode'; mode: Mode };
export type Mode = 'PLAN' | 'IMPLEMENT';
export type Focus = 'composer' | 'viewport' | 'sidebar' | 'palette' | 'diff';
export interface Completion { label: string; value: string; cursor?: number; kind?: 'file' }
export interface ComposerModel {
  value: string; cursorOffset: number; history: string[]; historyIndex: number;
  draft: string; completions: Completion[]; selected: number; completionDismissed: boolean;
}
export interface PermissionCard { toolName: string; target: string; summary: string; riskLevel: string; category: string; suggestedTool?: string }
export interface TranscriptEntry { kind: 'user' | 'answer' | 'thought' | 'tool' | 'step' | 'log' | 'permission'; text: string; permission?: PermissionCard }
export interface ViewportModel { entries: TranscriptEntry[]; thinking: string; answerStream: string; offset: number; pinned: boolean; collapsed: boolean }
export interface SidebarModel { visible: boolean; workspace: string; model: string; session: string; sessions: string[]; tools: string[]; files: string[]; invariants: string[]; tokens: number; maxTokens: number }
export interface PaletteItem { id: string; label: string; description: string; action?: Action }
export interface PaletteModel { open: boolean; query: string; selected: number; items: PaletteItem[] }
export interface DiffViewerModel { visible: boolean; text: string; offset: number; split: boolean; collapsed: number[]; hunk: number }
export interface StatuslineModel { busy: boolean; aborting: boolean; step: number; maxSteps: number; phase: string; retry: string; notice: string; compaction: CompactionStatus | null; frame: number }
export interface RootModel {
  width: number; height: number; mode: Mode; focus: Focus; leaderUntil: number;
  composer: ComposerModel; viewport: ViewportModel; sidebar: SidebarModel;
  palette: PaletteModel; diff: DiffViewerModel; status: StatuslineModel;
  question: { active: boolean; prompt: string; draft?: ComposerModel; permission?: PermissionCard };
}
export interface Model<M> { init(): [M, Cmd[]]; update(msg: Msg, model: M): [M, Cmd[]]; view(model: M): string }
export type Sub = (send: (msg: Msg) => void) => () => void;
