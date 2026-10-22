import path from 'node:path';
import type { RootModel, Msg, Cmd, PaletteItem, Action, KernelMsg, TranscriptEntry, SessionTab, SessionTabsModel } from '../types.js';
import { createComposer, updateComposer, composerView, composerDisplay } from './composer-model.js';
import { appendEntry, viewportView, viewportLines, lastAnswerOffset, createSessionTabs, syncSessionTabs, adoptActiveTab, adoptAfterSync, ownerAppendEntry, ownerReplaceLastEntry, ownerStream, ownerArchiveThinking, ownerClearStream, ownerFlushLiveAnswer, thoughtToggleHit, toggleThought, sanitizeComposer, sessionTabsKey, sessionTabStripView, sessionTabsView, sessionStripHit, sessionStripClick, tabDisplayModel, shortTabTitle } from './viewport-model.js';
import { sidebarView } from './sidebar-model.js';
import { paletteItems, paletteView } from './palette-model.js';
import { diffView, createDiffViewer } from './diff-model.js';
import { headerView, statuslineView } from './statusline-model.js';
import { toolCallEntry, toolErrorEntry, toolResultEntry, mergedToolEntry } from './tool-entry.js';
import { selectionKey, selectionRows, type SelectionLayout } from './selection.js';
import { createGrillModel, grillKey, grillView } from './grill-model.js';
import { createModelPickerModel, modelPickerKey, modelPickerLayout } from './model-picker-model.js';
import { fit, wrap, joinHorizontal, joinVertical, paintCanvas, color, tokyoNight } from '../styles/theme.js';

const defaultCommands: PaletteItem[] = [
  { id: '/help', label: 'Help', description: 'Show commands' },
  ...(['compact', 'editor', 'quit', 'sidebar', 'diff', 'mode', 'clear'] as const).map(action => ({ id: action, label: action, description: 'Session action', action })),
];

/** Shared layout budget: keeps view() and the mouse-scroll math in sync. */
function isCompactHeight(height: number): boolean { return height < 24; }
function composerCap(height: number): number { return isCompactHeight(height) ? 3 : 5; }
function hintCap(height: number): number { return isCompactHeight(height) ? 2 : 4; }
/** P0: narrow terminals get a slimmer side-by-side panel instead of losing context entirely. */
export function sidebarWidthFor(width: number, visible: boolean, height: number): number {
  if (!visible || height < 12) return 0;
  if (width >= 80) return Math.min(32, Math.floor(width / 3));
  if (width < 40) return 0;
  return Math.min(24, Math.floor(width / 2));
}
function composerHeightFor(height: number, width: number, value: string): number {
  return Math.min(composerCap(height), Math.max(1, Math.floor((height - 2) / 3)), wrap('› ' + value, width).length);
}
export function createRootModel(options: { width?: number; height?: number; commands?: PaletteItem[] } = {}): RootModel {
  return { width: Math.max(1, options.width ?? 80), height: Math.max(1, options.height ?? 24), mode: 'IMPLEMENT', focus: 'composer', leaderUntil: 0,
    composer: createComposer(), viewport: { entries: [], thinking: '', answerStream: '', offset: 0, pinned: true, collapsed: false },
    sidebar: { visible: false, workspace: '', model: '', session: '', sessions: [], tools: [], files: [], invariants: [], tokens: 0, maxTokens: 128000 },
    palette: { open: false, query: '', selected: 0, items: options.commands || defaultCommands }, diff: { visible: false, text: '', offset: 0, split: false, collapsed: [], hunk: 0 },
    grill: createGrillModel(),
    modelPicker: createModelPickerModel(),
    sessions: createSessionTabs('', []),
    status: { busy: false, aborting: false, step: 0, maxSteps: Infinity, phase: '', retry: '', notice: '', compaction: null, frame: 0 }, question: { active: false, prompt: '', selected: 0 } };
}
export function init(options?: Parameters<typeof createRootModel>[0]): [RootModel, Cmd[]] { return [createRootModel(options), []]; }
function action(model: RootModel, actionName: Action): [RootModel, Cmd[]] {
  switch (actionName) {
    case 'sidebar': return [{ ...model, sidebar: { ...model.sidebar, visible: !model.sidebar.visible } }, []];
    case 'diff': return [{ ...model, diff: { ...model.diff, visible: !model.diff.visible }, focus: model.diff.visible ? 'composer' : 'diff' }, []];
    case 'palette': return [{ ...model, palette: { ...model.palette, open: true, query: '', selected: 0 }, focus: 'palette' }, []];
    case 'mode': { if (model.status.busy) return [{ ...model, status: { ...model.status, notice: 'Switch mode after the current task finishes.' } }, []]; const mode = model.mode === 'IMPLEMENT' ? 'PLAN' : 'IMPLEMENT'; return [{ ...model, mode }, [{ type: 'mode', mode }]]; }
    case 'clear': return [{ ...model, viewport: { ...model.viewport, entries: [], thinking: '', answerStream: '', offset: 0 } }, []];
    case 'compact': case 'editor': return model.status.busy ? [{ ...model, status: { ...model.status, notice: 'Wait for the current task to finish.' } }, []] : [model, [{ type: actionName }]];
    case 'quit': return [model, [{ type: 'quit' }]];
  }
}
function archiveThinking(model: RootModel): RootModel {
  if (!model.viewport.thinking) return model;
  return { ...model, viewport: { ...appendEntry(model.viewport, { kind: 'thought', text: model.viewport.thinking }), thinking: '' } };
}
/** Đọc sessionId tường minh đã thread qua kernel emit (undefined khi emit cũ/thiếu ctx). */
function kernelSessionId(msg: KernelMsg): string | undefined {
  switch (msg.event) {
    case 'model:thinking:start':
    case 'model:thinking:end':
      return msg.args[0]?.sessionId || undefined;
    case 'model:retry':
      return msg.args[1]?.sessionId || undefined;
    case 'tool:after':
      return msg.args[4]?.sessionId || undefined;
    case 'step:before':
      return msg.args[3]?.sessionId || undefined;
    case 'step:after':
    case 'model:thought':
    case 'model:token':
    case 'model:final_answer':
    case 'model:changed':
    case 'tool:before':
    case 'tool:error': {
      const last: unknown = msg.args[msg.args.length - 1];
      return last && typeof last === 'object' && typeof (last as { sessionId?: unknown }).sessionId === 'string'
        ? (last as { sessionId: string }).sessionId || undefined
        : undefined;
    }
    default:
      return undefined;
  }
}
function reduce(msg: Msg, model: RootModel): [RootModel, Cmd[]] {
  if (['compose', 'question', 'action', 'diff'].includes(msg.type)) model = { ...model, selection: undefined, composer: { ...model.composer, selection: undefined } };
  const log = (text: string, kind: 'log' | 'tool' | 'step' | 'answer' = 'log'): [RootModel, Cmd[]] => [{ ...model, viewport: appendEntry(model.viewport, { kind, text }) }, []];
  switch (msg.type) {
    case 'resize': return [{ ...model, selection: undefined, composer: { ...model.composer, selection: undefined }, width: Math.max(1, msg.width), height: Math.max(1, msg.height) }, []];
    case 'tick': return [{ ...model, leaderUntil: msg.now >= model.leaderUntil ? 0 : model.leaderUntil, status: { ...model.status, frame: model.status.frame + 1,
      ...(model.status.noticeUntil && msg.now >= model.status.noticeUntil ? { notice: '', noticeUntil: undefined } : {}),
      ...(model.status.stoppingUntil && msg.now >= model.status.stoppingUntil ? { stoppingUntil: undefined } : {}),
      ...(model.status.compactionUntil && msg.now >= model.status.compactionUntil ? { compaction: null, compactionUntil: undefined } : {}),
    } }, []];
    case 'action': return action(model, msg.action);
    case 'log': {
      if (!msg.text.trim()) return [model, []];
      // Log của subagent → tab của subagent (không lẫn vào viewport đang xem).
      if (msg.sessionId) {
        if (!model.sessions.tabs.some(t => t.id === msg.sessionId)) return [model, []];
        return [ownerAppendEntry(model, { kind: 'log', text: msg.text }, msg.sessionId), []];
      }
      return log(msg.text);
    }
    case 'notice': return [{ ...model, status: { ...model.status, notice: msg.text } }, []];
    case 'busy': {
      // Busy theo từng session (đa task song song): chỉ dot đúng tab, global
      // busy còn sáng khi bất kỳ tab nào còn chạy. Pin giữ đầu mối đầu tiên
      // cho event kernel legacy thiếu ctx; task xong thì re-pin sang tab còn chạy.
      const rawOwner = msg.sessionId ?? model.sessions.activeId;
      const owner = model.sessions.tabs.some(t => t.id === rawOwner) ? rawOwner : model.sessions.activeId;
      const tabs = model.sessions.tabs.map(t => t.id === owner ? { ...t, busy: msg.busy } : t);
      const anyBusy = tabs.some(t => t.busy);
      let pin = model.status.busySessionId;
      if (msg.busy) pin = pin ?? owner;
      else if (pin === owner) pin = tabs.find(t => t.busy)?.id;
      return [{ ...model, status: { ...model.status, busy: anyBusy, busySessionId: pin, aborting: msg.busy ? model.status.aborting : false, retry: '', notice: msg.busy ? '' : model.status.aborting ? 'Task cancelled' : model.status.notice },
        sessions: { ...model.sessions, tabs } }, []];
    }
    case 'compose': return [{ ...model, composer: { ...model.composer, value: msg.text, cursorOffset: msg.text.length } }, []];
    case 'completions': return [{ ...model, composer: { ...model.composer, completions: msg.values, selected: 0 } }, []];
    case 'diff': return [{ ...model, diff: { ...model.diff, text: msg.text, visible: msg.reveal ?? model.diff.visible, offset: 0, collapsed: [], hunk: 0 } }, []];
    case 'metadata': {
      // `model` là state per-session-tab (outer gửi model của kernel-active session):
      // tách khỏi spread global để không đè nhầm lên tab đang xem.
      const { model: metaModel, ...rest } = msg.data;
      // sessionIds (id thật) ưu tiên; sessions có thể là tên hiển thị (main loop)
      // hoặc ids (startup) — chỉ dùng làm ids khi không có sessionIds.
      const ids = msg.data.sessionIds ?? msg.data.sessions ?? model.sessions.tabs.map(t => t.id);
      const titles = msg.data.sessionIds ? msg.data.sessions : undefined;
      const wantActive = msg.data.activeSessionId ?? msg.data.session ?? model.sessions.activeId;
      // Switch do TEA khởi xướng (pending): giữ active + tab optimistic, kẻo metadata
      // mang activeSessionId cũ của kernel revert mất. Clear khi kernel đã confirm.
      const pending = model.sessions.pendingActiveId;
      const hasSync = Boolean(msg.data.sessionIds || msg.data.sessions || msg.data.session || msg.data.activeSessionId);
      let sessions = hasSync ? syncSessionTabs(model.sessions, ids, pending ?? wantActive, titles) : model.sessions;
      if (pending) {
        sessions = msg.data.activeSessionId === pending
          ? { ...sessions, pendingActiveId: undefined }
          : { ...sessions, pendingActiveId: pending };
      }
      // Model mặc định chung theo metadata của outer (tab chưa /model riêng theo default này).
      if (msg.data.defaultModel !== undefined) sessions = { ...sessions, defaultModel: msg.data.defaultModel };
      // Route model về đúng tab sở hữu: cache authoritative khi khác default,
      // sidebar chỉ đổi khi mô tả đúng tab đang xem và không có switch lạc quan.
      let displayModel: string | undefined;
      if (typeof metaModel === 'string' && metaModel) {
        const metaActive = typeof msg.data.activeSessionId === 'string' ? msg.data.activeSessionId : undefined;
        const metaSession = typeof msg.data.session === 'string' ? msg.data.session : undefined;
        const owner = (metaActive && sessions.tabs.some(t => t.id === metaActive)) ? metaActive
          : (!msg.data.sessionIds && metaSession && sessions.tabs.some(t => t.id === metaSession)) ? metaSession
          : undefined;
        const target = owner ?? sessions.activeId;
        if (sessions.defaultModel !== undefined && metaModel !== sessions.defaultModel) {
          sessions = { ...sessions, tabs: sessions.tabs.map(t => t.id === target ? { ...t, model: metaModel } : t) };
        }
        if (target === sessions.activeId && !sessions.pendingActiveId) {
          displayModel = metaModel;
        }
      }
      let next: RootModel = { ...model, sidebar: { ...model.sidebar, ...rest }, sessions };
      if (displayModel !== undefined) {
        next = { ...next, sidebar: { ...next.sidebar, model: displayModel } };
      }
      if (!pending && hasSync && sessions.activeId !== model.sessions.activeId
        && sessions.tabs.some(t => t.id === sessions.activeId)) {
        next = adoptAfterSync(next, sessions, model.sessions.activeId);
        if (displayModel !== undefined) {
          next = { ...next, sidebar: { ...next.sidebar, model: displayModel } };
        }
      }
      return [next, []];
    }
    case 'sessions-adopt': {
      // Outer (slash) đã switch kernel: swap viewport theo, không phát Cmd.
      return [adoptActiveTab(model, msg.activeId), []];
    }
    case 'workspace-switch': {
      const ids = Array.from(new Set([
        msg.activeSessionId,
        ...(msg.sessionIds || []),
      ])).filter(Boolean);

      const titleMap = new Map<string, string>();
      if (msg.sessionIds && msg.titles) {
        msg.sessionIds.forEach((id, i) => {
          if (msg.titles?.[i]) titleMap.set(id, msg.titles[i]);
        });
      }

      const tabs: SessionTab[] = ids.map((id) => {
        const rawTitle = titleMap.get(id);
        return {
          id,
          title: rawTitle ? shortTabTitle(rawTitle) : shortTabTitle(id),
          historyKnown: id === msg.activeSessionId ? Boolean(msg.entries) : false,
          lastActive: id === msg.activeSessionId ? Date.now() : 0,
          entries: id === msg.activeSessionId ? (msg.entries || []) : undefined,
        };
      });

      const activeTab = tabs.find((t) => t.id === msg.activeSessionId) || tabs[0];
      const activeId = activeTab ? activeTab.id : msg.activeSessionId;
      const displayModel = msg.model ?? msg.defaultModel ?? model.sidebar.model;

      const sessions: SessionTabsModel = {
        open: false,
        selected: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
        tabs,
        activeId,
        pendingActiveId: undefined,
        defaultModel: msg.defaultModel ?? model.sessions.defaultModel,
      };

      const baseName = path.basename(msg.workspace) || msg.workspace;
      const next: RootModel = {
        ...model,
        focus: 'composer',
        sessions,
        viewport: {
          ...model.viewport,
          entries: msg.entries || [],
          thinking: '',
          answerStream: '',
          offset: 0,
          pinned: true,
        },
        composer: createComposer(),
        diff: createDiffViewer(),
        sidebar: {
          ...model.sidebar,
          workspace: msg.workspace,
          session: activeTab?.title || shortTabTitle(activeId),
          sessions: ids,
          model: displayModel,
          tools: [],
          tokens: 0,
        },
        status: {
          ...model.status,
          notice: `Đã chuyển workspace sang ${baseName}`,
        },
      };

      return [next, []];
    }
    case 'compaction': {
      const isFinished = Boolean(msg.status && msg.status.state !== 'running');
      return [{
        ...model,
        status: {
          ...model.status,
          compaction: msg.status,
          compactionUntil: isFinished ? Date.now() + 3000 : undefined,
        },
      }, []];
    }
    case 'question': {
      const owner = msg.active ? (msg.sessionId ?? model.sessions.activeId) : (model.question.sessionId ?? model.sessions.activeId);
      if (!msg.active) {
        const closed = { active: false as const, prompt: '', selected: 0 };
        const baseTabs = model.sessions.tabs.map(t => t.id === owner ? { ...t, awaitingInput: false } : t);
        const updatedSessions = { ...model.sessions, tabs: baseTabs, activeQuestionSessionId: undefined };
        // Chỉ stash draft khi question đã clear composer (owner là tab đang xem).
        // Question của tab nền không đụng composer nên lúc đóng không trả gì —
        // text mỗi tab ở yên trong tab của nó.
        const draft = model.question.draft;
        if (!draft) return [{ ...model, sessions: updatedSessions, question: closed }, []];
        // Draft trả đúng tab sở hữu question — không ghi đè composer tab đang xem.
        if (owner === model.sessions.activeId) return [{ ...model, sessions: updatedSessions, composer: draft, question: closed }, []];
        const tabs = baseTabs.map(t => t.id === owner ? { ...t, composer: sanitizeComposer(draft) } : t);
        return [{ ...model, sessions: { ...updatedSessions, tabs }, question: closed }, []];
      }
      const card: TranscriptEntry = { kind: msg.permission ? 'permission' : 'log', text: msg.prompt, permission: msg.permission };
      const withCard = owner === model.sessions.activeId
        ? { ...model, viewport: { ...appendEntry(model.viewport, card), offset: 0, pinned: true } }
        : ownerAppendEntry(model, card, owner);
      const ownerActive = owner === model.sessions.activeId;
      const tabsWithInput = withCard.sessions.tabs.map(t => t.id === owner ? { ...t, awaitingInput: true } : t);
      const sessionsWithInput = { ...withCard.sessions, tabs: tabsWithInput, activeQuestionSessionId: owner };
      return [{ ...withCard, sessions: sessionsWithInput, focus: 'composer', palette: { ...withCard.palette, open: false },
        composer: ownerActive ? createComposer() : withCard.composer,
        question: { active: true, prompt: msg.prompt, draft: ownerActive ? model.composer : undefined, permission: msg.permission, selected: 0, sessionId: owner } }, []];
    }
    case 'grill': {
      if (!msg.open) return [{ ...model, focus: model.focus === 'grill' ? 'composer' : model.focus, grill: { ...model.grill, open: false, loading: false } }, []];
      return [{ ...model, focus: 'grill' as const, palette: { ...model.palette, open: false }, grill: { open: true, question: msg.question ?? model.grill.question, options: msg.options ?? model.grill.options, selected: 0, loading: msg.loading ?? false, sessionId: msg.sessionId ?? model.sessions.activeId } }, []];
    }
    case 'grill-loading': return [{ ...model, grill: { ...model.grill, loading: msg.loading } }, []];
    case 'model-picker': {
      if (!msg.open) return [{ ...model, focus: model.focus === 'model-picker' ? 'composer' : model.focus, modelPicker: { ...model.modelPicker, open: false } }, []];
      const options = msg.options ?? model.modelPicker.options;
      const current = Math.max(0, options.findIndex((o) => o.current));
      return [{ ...model, focus: 'model-picker' as const, palette: { ...model.palette, open: false }, modelPicker: { open: true, options, selected: current, query: '', sessionId: msg.sessionId ?? model.sessions.activeId } }, []];
    }
    case 'sessions': {
      if (msg.tabs || msg.activeId) {
        const ids = msg.tabs ? msg.tabs.map(t => t.id) : model.sidebar.sessions;
        const synced = syncSessionTabs(model.sessions, ids, (msg.activeId ?? model.sessions.activeId) || model.sidebar.session);
        return [{ ...model, sessions: { ...synced, open: msg.open ?? model.sessions.open }, focus: (msg.open ?? model.sessions.open) ? 'sessions' as const : model.focus === 'sessions' ? 'composer' as const : model.focus }, []];
      }
      const open = msg.open ?? !model.sessions.open;
      const selected = Math.max(0, model.sessions.tabs.findIndex(t => t.id === model.sessions.activeId));
      return [{ ...model, focus: open ? 'sessions' as const : 'composer' as const, palette: { ...model.palette, open: false }, sessions: { ...model.sessions, open, selected: selected >= 0 ? selected : 0 } }, []];
    }
    case 'session-transcript': {
      // Hydrate lịch sử session cũ vào tab cache; nếu đúng tab đang xem thì vẽ ngay.
      if (!model.sessions.tabs.some(t => t.id === msg.sessionId)) return [model, []];
      const prev = model.sessions.tabs.find(t => t.id === msg.sessionId)!;
      const viewed = msg.sessionId === model.sessions.activeId;
      // Tab đang chạy task nền (busy / còn stream live) thì hydrate chỉ bổ sung
      // cache, KHÔNG ghi đè entries và KHÔNG xóa stream — nếu không transcript
      // đang chạy sẽ bị lịch sử cũ đè mất, chunks mới append tiếp gây trộn view.
      const liveThinking = viewed ? model.viewport.thinking : (prev.thinking || '');
      const liveAnswer = viewed ? model.viewport.answerStream : (prev.answerStream || '');
      const hasLive = Boolean(prev.busy || liveThinking || liveAnswer);
      // Chỉ khi tab KHÔNG đang xem VÀ đang bận/streaming (task nền) thì giữ entries
      // cũ, kẻo lịch sử hydration đè mất nội dung đang live. Mọi trường hợp khác
      // (đặc biệt là quay lại tab cũ) áp dụng msg.entries để render lại markdown
      // mới nhất theo thời gian thực.
      const entries = (!viewed && hasLive) ? (prev.entries ?? msg.entries) : msg.entries;
      const tabs = model.sessions.tabs.map(t => t.id === msg.sessionId ? { ...t,
        entries,
        thinking: hasLive ? liveThinking : '',
        answerStream: hasLive ? liveAnswer : '',
        unread: viewed ? 0 : (t.unread ?? 0),
        historyKnown: true, lastActive: Date.now() } : t);
      const sessions = { ...model.sessions, tabs };
      if (!viewed) return [{ ...model, sessions }, []];
      const tab = tabs.find(t => t.id === msg.sessionId);
      return [{ ...model, sessions,
        viewport: { ...model.viewport, entries: viewed ? entries : model.viewport.entries, thinking: liveThinking, answerStream: liveAnswer, offset: 0, pinned: true },
        sidebar: { ...model.sidebar, session: tab?.title || model.sidebar.session, model: tab ? tabDisplayModel(model, tab) : model.sidebar.model },
        status: msg.entries.length ? { ...model.status, notice: `Đã khôi phục lịch sử session (${msg.entries.length} msgs)` } : model.status,
      }, []];
    }
    case 'kernel': {
      // Nội dung stream/tool route về tab sở hữu task: ưu tiên ctx tường minh
      // từ kernel (đã thread sessionId), fallback pin lúc busy, cuối cùng là tab
      // đang xem. Tab khác không bao giờ thấy lọt vào.
      const explicitOwner = kernelSessionId(msg);
      const owner = explicitOwner ?? model.status.busySessionId ?? model.sessions.activeId;
      const ownerActive = owner === model.sessions.activeId;
      switch (msg.event) {
        case 'model:thought': return model.status.aborting ? [model, []] : [{ ...ownerStream(model, 'thinking', msg.args[0], explicitOwner), status: { ...model.status, retry: ownerActive ? '' : model.status.retry } }, []];
        case 'model:token': return model.status.aborting ? [model, []] : [ownerStream(model, 'answerStream', msg.args[0], explicitOwner), []];
        case 'model:final_answer': {
          const archived = ownerArchiveThinking(model, explicitOwner);
          const next = ownerAppendEntry(archived, { kind: 'answer', text: msg.args[0] }, explicitOwner);
          const cleared = ownerClearStream(next, 'answerStream', explicitOwner);
          return [{ ...cleared, status: { ...cleared.status, retry: ownerActive ? '' : cleared.status.retry } }, []];
        }
        case 'model:thinking:start': return [{ ...ownerArchiveThinking(model, explicitOwner), status: { ...model.status, phase: ownerActive ? 'Thinking' : model.status.phase } }, []];
        case 'model:thinking:end': return [ownerArchiveThinking(model, explicitOwner), []];
        case 'step:before': return [{ ...ownerArchiveThinking(model, explicitOwner), status: { ...model.status, step: ownerActive ? msg.args[0] : model.status.step, maxSteps: ownerActive ? msg.args[1] : model.status.maxSteps, phase: ownerActive ? msg.args[2] || 'Working' : model.status.phase } }, []];
        case 'step:after': return [model, []];
        case 'tool:before': {
          const entry = { kind: 'tool' as const, text: toolCallEntry(msg.args[0], msg.args[1]) };
          // Câu trả lời tạm thời model in ra trước tool phải nằm ngay trên tool này:
          // flush buffer stream thành entry 'live' (bọc 2 separator) trước khi thêm tool.
          const flushed = ownerFlushLiveAnswer(model, explicitOwner);
          if (ownerActive) return [ownerAppendEntry({ ...flushed, sidebar: { ...flushed.sidebar, tools: [...flushed.sidebar.tools, msg.args[0]] } }, entry, explicitOwner), []];
          const tabs = flushed.sessions.tabs.map(t => t.id === owner ? { ...t, tools: [...(t.tools ?? []), msg.args[0]] } : t);
          return [ownerAppendEntry({ ...flushed, sessions: { ...flushed.sessions, tabs } }, entry, explicitOwner), []];
        }
        case 'tool:after': {
          const [name, result, duration, args] = msg.args;
          const target = args?.path || args?.filePath || args?.targetFile;
          const diff = result.diff || result.patch || (result as any).unifiedDiff || (args as any)?.patch;
          // files giữ global (workspace-level); diff + tools theo tab sở hữu.
          const withSidebar = { ...model, sidebar: { ...model.sidebar, tools: ownerActive ? model.sidebar.tools.filter(t => t !== name) : model.sidebar.tools, files: target && /write|replace|edit|patch/.test(name) ? [...new Set([...model.sidebar.files, String(target)])] : model.sidebar.files },
            diff: ownerActive && typeof diff === 'string' ? { ...model.diff, text: diff } : model.diff };
          const withTabs = ownerActive ? withSidebar : { ...withSidebar, sessions: { ...withSidebar.sessions, tabs: withSidebar.sessions.tabs.map(t => {
            if (t.id !== owner) return t;
            const next = { ...t, tools: (t.tools ?? []).filter(tool => tool !== name) };
            return typeof diff === 'string' ? { ...next, diff: { ...createDiffViewer(), ...(t.diff ?? {}), text: diff, offset: 0 } } : next;
          }) } };
          // Explore tools thành công: gộp call entry + result thành MỘT dòng (thay thế chỗ call).
          // Không tìm thấy call entry (tool:after mồ côi / hydrate lệch) → fallback push result entry.
          const merged = mergedToolEntry(name, args, result);
          if (merged) {
            const callText = toolCallEntry(name, args);
            const replaced = ownerReplaceLastEntry(withTabs, e => e.kind === 'tool' && e.text === callText, { kind: 'tool' as const, text: merged }, explicitOwner);
            if (replaced !== withTabs) return [replaced, []];
          }
          return [ownerAppendEntry(withTabs, { kind: 'tool', text: toolResultEntry(name, result, duration, args) }, explicitOwner), []];
        }
        case 'tool:error': {
          const entry = { kind: 'tool' as const, text: toolErrorEntry(String(msg.args[0] ?? 'unknown_tool'), msg.args[1]) };
          if (!entry.text.trim()) return [model, []];
          return [ownerAppendEntry(model, entry, explicitOwner), []];
        }
        case 'model:usage': {
          const tokens = msg.args[0].promptTokens || msg.args[0].totalTokens || 0;
          if (ownerActive) return [{ ...model, sidebar: { ...model.sidebar, tokens } }, []];
          const tabs = model.sessions.tabs.map(t => t.id === owner ? { ...t, tokens } : t);
          return [{ ...model, sessions: { ...model.sessions, tabs } }, []];
        }        case 'model:retry': { const retry = msg.args[0]; return ownerActive ? [{ ...model, status: { ...model.status, retry: retry ? `Retry ${retry.attempt}/${retry.maxRetries} in ${Math.ceil(retry.delayMs / 1000)}s · ${retry.message || ''}` : '' } }, []] : [model, []]; }
        case 'workspace:changed': return [{ ...model, sidebar: { ...model.sidebar, workspace: msg.args[1] } }, []];
        case 'model:changed': {
          // Model theo từng tab: ctx tường minh → ghim vào tab sở hữu (+ sidebar nếu đang xem tab đó).
          // Thiếu ctx (đổi default chung) → cập nhật default; sidebar giữ model riêng của tab đang xem nếu có.
          const explicitOwner = kernelSessionId(msg);
          if (explicitOwner && model.sessions.tabs.some(t => t.id === explicitOwner)) {
            const tabs = model.sessions.tabs.map(t => t.id === explicitOwner ? { ...t, model: msg.args[0] } : t);
            const sidebar = explicitOwner === model.sessions.activeId
              ? { ...model.sidebar, model: msg.args[0] }
              : model.sidebar;
            return [{ ...model, sidebar, sessions: { ...model.sessions, tabs } }, []];
          }
          const activeTab = model.sessions.tabs.find(t => t.id === model.sessions.activeId);
          return [{ ...model,
            sidebar: { ...model.sidebar, model: activeTab?.model ?? msg.args[0] },
            sessions: { ...model.sessions, defaultModel: msg.args[0] } }, []];
        }
        case 'agent:abort': case 'abort': return [{ ...model, status: { ...model.status, aborting: model.status.busy } }, []];
        case 'agent:status': case 'agent/status': {
          const record = msg.args[0];
          // Subagent: transcript đi vào tab riêng (chỉ xem), không lẫn vào tab cha.
          if (record?.isSubagent && record.sessionId) {
            const id = record.sessionId;
            // Bỏ tiền tố "Subagent:" — tab hiện objective để user nhận ra việc con đang làm.
            const label = String(record.name || record.label || 'Subagent').replace(/^Subagent:\s*/i, '').trim();
            const title = label.length > 18 ? label.slice(0, 17) + '…' : (label || 'Subagent');
            const busy = record.status === 'running';
            const exists = model.sessions.tabs.some(t => t.id === id);
            const tabs = exists
              // Giữ tiêu đề đã có (objective lúc spawn) — status sau không ghi đè.
              ? model.sessions.tabs.map(t => t.id === id ? { ...t, title: t.title || title, busy } : t)
              : [...model.sessions.tabs, { id, title, subagent: true, busy, lastActive: Date.now() }];
            return [{ ...model, sessions: { ...model.sessions, tabs } }, []];
          }
          if (!['root', 'main', 'primary', 'interactive-agent', 'coding-agent'].includes(record.id)) return [model, []];
          if (['idle', 'stopped', 'error'].includes(record.status)) return [{ ...model, status: { ...model.status, aborting: false, phase: record.status } }, []];
          return [model, []];
        }
        case 'kernel:disposed': return [model, [{ type: 'quit' }]];
        case 'kernel:init': case 'plugin:registered': case 'router:decision': case 'gate:exploration_sufficiency': case 'gate:reproduction_advisory': case 'model:request_telemetry': case 'tools:batch': case 'model:steered': return [model, []];
      }
    }
    case 'key': {
      // Model-picker modal mở: chuột thuộc về modal trước mọi hit-test khác
      // (kẻo click lọt xuống strip/viewport sau modal).
      if ((model.modelPicker.open || model.focus === 'model-picker') && msg.mouse) {
        const handled = modelPickerKey(msg, { ...model, focus: 'model-picker' as const });
        if (handled) return handled;
        return [model, []];
      }
      // Click chuột trên session tab-strip (dòng y=2, ngay trên viewport):
      // tab → switch, × → ẩn tạm, + new → tạo tab. Nuốt click để không lọt
      // xuống text-selection của viewport. Grill/question giữ quyền ưu tiên.
      if (msg.key === 'mouse+press' && msg.mouse && model.height > 4 && msg.mouse.y === 2
        && !model.grill.open && model.focus !== 'grill' && !model.question.active) {
        const hit = sessionStripHit(model.sessions, model.width, msg.mouse.x);
        if (hit) return sessionStripClick(model, hit);
        return [model, []];
      }
      // Click chuột lên dấu +/− trước dòng "Thinking ›" → mở/tắt khối Thinking.
      // Phải xử lý TRƯỚC selection để click nút không bị hiểu là bôi chữ.
      if (msg.key === 'mouse+press' && msg.mouse && model.height > 4
        && !model.grill.open && model.focus !== 'grill' && !model.question.active) {
        const layout = selectionLayout(model);
        const hit = thoughtToggleHit(model, msg.mouse.x, msg.mouse.y, layout.bodyHeight, layout.mainWidth);
        if (hit !== undefined) return [toggleThought(model, hit), []];
      }
      const selected = selectionKey(msg, model, selectionLayout(model));
      if (selected) return selected;
      if (model.selection && !msg.key.startsWith('mouse+')) model = { ...model, selection: undefined };
      if (msg.key === 'mouse+up' || msg.key === 'mouse+down') {
        model = { ...model, selection: undefined, composer: { ...model.composer, selection: undefined } };
        if (model.height <= 2 || model.focus === 'palette') return [model, []];
        const composerHeight = composerHeightFor(model.height, model.width, composerDisplay(model.composer).value);
        const completionCount = model.composer.completionDismissed ? 0 : Math.min(4, model.composer.completions.length);
        const hintCount = Math.min(hintCap(model.height), completionCount, Math.max(0, model.height - composerHeight - 4));
        const questionCount = questionView(model, composerHeight).length;
        const bodyHeight = Math.max(0, model.height - 3 - composerHeight - hintCount - questionCount);
        const sidebarWidth = sidebarWidthFor(model.width, model.sidebar.visible, model.height);
        const mainWidth = model.width - sidebarWidth;
        const delta = msg.key === 'mouse+up' ? 3 : -3;
        if (model.diff.visible) {
          const maxOffset = Math.max(0, model.diff.text.split('\n').length + 1 - bodyHeight);
          const offset = Math.max(0, Math.min(maxOffset, model.diff.offset + delta));
          return offset === model.diff.offset ? [model, []] : [{ ...model, diff: { ...model.diff, offset } }, []];
        }
        const maxOffset = Math.max(0, viewportLines(model.viewport, mainWidth).length - bodyHeight);
        const offset = Math.max(0, Math.min(maxOffset, model.viewport.offset + delta));
        return offset === model.viewport.offset ? [model, []] : [{ ...model, viewport: { ...model.viewport, offset, pinned: offset === 0 } }, []];
      }
      if (model.question.active) {
        if (msg.key === 'ctrl+x') return [{ ...model, leaderUntil: msg.now + 1200 }, []];
        if (model.leaderUntil > msg.now) {
          const next = { ...model, leaderUntil: 0 };
          if (msg.key === 'd' || msg.key === 'b') return action(next, msg.key === 'd' ? 'diff' : 'sidebar');
          if (msg.key === '?') return [{ ...next, focus: 'palette' as const, palette: { ...next.palette, open: true, query: '', selected: 0 } }, []];
          return [next, []];
        }
        if (msg.key === 'pageup' || msg.key === 'pagedown') {
          if (model.diff.visible) return [{ ...model, diff: { ...model.diff, offset: Math.max(0, model.diff.offset + (msg.key === 'pageup' ? -10 : 10)) } }, []];
          const [next, commands] = reduce(msg, { ...model, question: { ...model.question, active: false } });
          return [{ ...next, question: model.question }, commands];
        }
        if (msg.key === 'enter') {
          // Permission: confirm the highlighted option (↑↓ navigated). Values match
          // the downstream mapping in src/index.ts (y → approve, a → approve_all_session, else reject).
          if (model.question.permission) {
            const sel = Math.min(model.question.selected, PERMISSION_OPTIONS.length - 1);
            return [model, [{ type: 'answer', text: PERMISSION_OPTIONS[sel].value }]];
          }
          return [model, [{ type: 'answer', text: model.composer.value }]];
        }
        if (['escape', 'ctrl+c'].includes(msg.key)) return [model, [{ type: 'answer', text: '\x03' }]];
        if (model.question.permission) {
          const sel = Math.min(model.question.selected, PERMISSION_OPTIONS.length - 1);
          if (msg.key === 'up' || msg.key === 'left') return [{ ...model, question: { ...model.question, selected: (sel + PERMISSION_OPTIONS.length - 1) % PERMISSION_OPTIONS.length } }, []];
          if (msg.key === 'down' || msg.key === 'right') return [{ ...model, question: { ...model.question, selected: (sel + 1) % PERMISSION_OPTIONS.length } }, []];
          // Letter shortcuts jump the highlight without confirming; Enter confirms.
          const letter = (msg.text || (msg.key.length === 1 ? msg.key : '')).toLowerCase();
          const jump = PERMISSION_OPTIONS.findIndex(opt => opt.key === letter);
          if (jump >= 0) return [{ ...model, question: { ...model.question, selected: jump } }, []];
          return [model, []];
        }
        return [{ ...model, composer: updateComposer(model.composer, msg) }, []];
      }
      // Grill modal đè lên input/composer: chặn mọi phím (kể cả khi busy) để thống nhất lựa chọn với LLM.
      if (model.grill.open || model.focus === 'grill') {
        const handled = grillKey(msg, { ...model, focus: 'grill' as const });
        if (handled) return handled;
        return [model, []];
      }
      // Session tabs modal đè lên input/composer (sau grill): quản lý nhiều session song song.
      if (model.sessions.open || model.focus === 'sessions') {
        const handled = sessionTabsKey(msg, { ...model, focus: 'sessions' as const });
        if (handled) return handled;
        return [model, []];
      }
      // Model-picker modal đè lên viewport (sau sessions): ↑↓ + Enter hoặc click chuột để chọn model.
      if (model.modelPicker.open || model.focus === 'model-picker') {
        const handled = modelPickerKey(msg, { ...model, focus: 'model-picker' as const });
        if (handled) return handled;
        return [model, []];
      }
      if (msg.key === 'ctrl+c' || (msg.key === 'escape' && model.status.busy && model.focus === 'composer')) {
        if (model.status.aborting) return [model, []];
        if (!model.status.busy) return action(model, 'quit');
        return [{ ...model, status: { ...model.status, aborting: true, notice: 'Stopping…' } }, [{ type: 'abort' }]];
      }
      if (model.focus === 'palette') {
        if (msg.key === 'escape') return [{ ...model, focus: 'composer', palette: { ...model.palette, open: false } }, []];
        const items = paletteItems(model.palette);
        if (msg.key === 'enter') {
          // P1: empty result keeps the palette open so the query survives refinement.
          if (!items.length) return [model, []];
          const item = items[Math.min(model.palette.selected, items.length - 1)];
          const next = { ...model, focus: 'composer' as const, palette: { ...model.palette, open: false } };
          if (item.action) return action(next, item.action);
          const text = item.id;
          if (next.status.busy && (text === '/model' || text === '/modal' || text.startsWith('/model ') || text.startsWith('/modal '))) {
            const targetModel = text.replace(/^\/(?:model|modal)\s*/, '').trim();
            return [
              { ...next, status: { ...next.status, notice: targetModel ? `Đang lên lịch đổi sang model ${targetModel}…` : 'Đang mở danh sách model…' } },
              [{ type: 'hot-model-switch', model: targetModel }]
            ];
          }
          return [next, [{ type: 'submit', text: item.id }]];
        }
        // P1: selection wraps around the list edges.
        if (msg.key === 'up' || msg.key === 'down') {
          if (!items.length) return [model, []];
          const selected = (model.palette.selected + (msg.key === 'up' ? -1 : 1) + items.length) % items.length;
          return [{ ...model, palette: { ...model.palette, selected } }, []];
        }
        const query = msg.key === 'backspace' ? Array.from(model.palette.query).slice(0, -1).join('') : model.palette.query + (msg.text || '');
        return [{ ...model, palette: { ...model.palette, query, selected: 0 } }, []];
      }
      if (msg.key === 'ctrl+x') return [{ ...model, leaderUntil: msg.now + 1200 }, []];
      if (model.leaderUntil > msg.now) {
        const routes: Record<string, Action> = { c: 'compact', e: 'editor', q: 'quit', b: 'sidebar', d: 'diff' };
        const next = { ...model, leaderUntil: 0 };
        if (msg.key === '?') return action(next, 'palette');
        if (msg.key === 's' || msg.key === 't') {
          const selected = Math.max(0, next.sessions.tabs.findIndex(t => t.id === next.sessions.activeId));
          return [{ ...next, focus: 'sessions' as const, palette: { ...next.palette, open: false }, sessions: { ...next.sessions, open: true, selected: selected >= 0 ? selected : 0 } }, []];
        }
        return routes[msg.key.toLowerCase()] ? action(next, routes[msg.key.toLowerCase()]) : [next, []];
      }
      if (msg.key === 'ctrl+p') return action(model, 'palette');
      if (msg.key === 'ctrl+t') {
        const open = !model.sessions.open;
        const selected = Math.max(0, model.sessions.tabs.findIndex(t => t.id === model.sessions.activeId));
        return [{ ...model, focus: open ? 'sessions' as const : 'composer' as const, palette: { ...model.palette, open: false }, sessions: { ...model.sessions, open, selected: selected >= 0 ? selected : 0 } }, []];
      }
      if (msg.key === 'tab') return action(model, 'mode');
      if (msg.key === 'ctrl+o') return [{ ...model, viewport: { ...model.viewport, collapsed: !model.viewport.collapsed } }, []];
      if (model.focus === 'diff') {
        if (msg.key === 'escape') return [{ ...model, focus: 'composer', diff: { ...model.diff, visible: false } }, []];
        if (msg.key === 's') return [{ ...model, diff: { ...model.diff, split: !model.diff.split } }, []];
        if (msg.key === 'h') return [{ ...model, diff: { ...model.diff, collapsed: model.diff.collapsed.includes(model.diff.hunk) ? model.diff.collapsed.filter(h => h !== model.diff.hunk) : [...model.diff.collapsed, model.diff.hunk] } }, []];
        if (msg.key === 'left' || msg.key === 'right') return [{ ...model, diff: { ...model.diff, hunk: Math.max(0, model.diff.hunk + (msg.key === 'left' ? -1 : 1)) } }, []];
        if (['up', 'down', 'pageup', 'pagedown'].includes(msg.key)) return [{ ...model, diff: { ...model.diff, offset: Math.max(0, model.diff.offset + (msg.key.endsWith('up') ? -1 : 1) * (msg.key.startsWith('page') ? 10 : 1)) } }, []];
        return [model, []];
      }
      if (msg.key === 'pageup' || msg.key === 'pagedown') {
        const mainWidth = Math.max(1, model.width - sidebarWidthFor(model.width, model.sidebar.visible, model.height));
        const maxOffset = Math.max(0, viewportLines(model.viewport, mainWidth).length - Math.max(1, model.height - 6));
        const delta = (msg.key.endsWith('up') ? 1 : -1) * Math.max(1, model.height - 6);
        const target = msg.key === 'pagedown' && model.viewport.offset > 0
          ? lastAnswerOffset(model.viewport, mainWidth)
          : undefined;
        const offset = Math.max(0, Math.min(maxOffset, target ?? model.viewport.offset + delta));
        return [{ ...model, viewport: { ...model.viewport, offset, pinned: offset === 0 } }, []];
      }
      if (msg.key === 'ctrl+space' && model.composer.completions.length) {
        const item = model.composer.completions[model.composer.selected];
        return [{ ...model, composer: { ...model.composer, value: item.value, cursorOffset: item.cursor ?? item.value.length, completions: [] } }, []];
      }
      if ((msg.key === ' ' || (msg.key === 'text' && msg.text === ' ')) && !model.composer.completionDismissed && !model.composer.selection) {
        const selected = model.composer.completionDismissed ? undefined : model.composer.completions[model.composer.selected];
        if (selected) {
          const cursor = selected.cursor ?? selected.value.length;
          const suffix = selected.value.slice(cursor);
          const separator = suffix.startsWith(' ') ? '' : ' ';
          return [{ ...model, composer: { ...model.composer, value: selected.value.slice(0, cursor) + separator + suffix,
            cursorOffset: cursor + 1, completions: [], selected: 0, completionDismissed: true } }, []];
        }
      }
      if (msg.key === 'enter') {
        const session = model.composer.completionDismissed ? undefined : model.composer.completions[model.composer.selected];
        const text = session?.kind === 'session' ? session.value.trim() : model.composer.value.trim();
        if (!text) return [model, []];
        // Tab subagent chỉ để xem — không gõ được vào con.
        if (model.sessions.tabs.find(t => t.id === model.sessions.activeId)?.subagent) {
          return [{ ...model, status: { ...model.status, notice: 'Tab subagent chỉ để xem — quay lại tab khác để gõ.' } }, []];
        }
        const composer = { ...createComposer(), history: [...model.composer.history.slice(-199), text] };
        if (model.status.busy && (text === '/model' || text === '/modal' || text.startsWith('/model ') || text.startsWith('/modal '))) {
          const targetModel = text.replace(/^\/(?:model|modal)\s*/, '').trim();
          return [
            { ...model, composer, status: { ...model.status, notice: targetModel ? `Đang lên lịch đổi sang model ${targetModel}…` : 'Đang mở danh sách model…' } },
            [{ type: 'hot-model-switch', model: targetModel }]
          ];
        }
        return [{ ...model, composer, viewport: { ...appendEntry(model.viewport, { kind: 'user', text }), offset: 0, pinned: true } }, [{ type: 'submit', text }]];
      }
      const composer = updateComposer(model.composer, msg);
      const commands: Cmd[] = composer.value !== model.composer.value || composer.cursorOffset !== model.composer.cursorOffset ? [{ type: 'complete', value: composer.value, cursor: composer.cursorOffset }] : [];
      return [{ ...model, composer }, commands];
    }
  }
}
export function update(msg: Msg, model: RootModel): [RootModel, Cmd[]] {
  let [next, commands] = reduce(msg, model);
  const now = msg.type === 'tick' || msg.type === 'key' ? msg.now : Date.now();
  if (next.status.notice !== model.status.notice || msg.type === 'notice') {
    next = { ...next, status: { ...next.status, noticeUntil: next.status.notice ? now + 3000 : undefined } };
  }
  if (next.status.aborting !== model.status.aborting) {
    next = { ...next, status: { ...next.status, stoppingUntil: next.status.aborting ? now + 3000 : undefined } };
  }
  if (!model.viewport.pinned && next.viewport !== model.viewport && next.viewport.offset === model.viewport.offset) {
    const width = model.width - sidebarWidthFor(model.width, model.sidebar.visible, model.height);
    const addedLines = viewportLines(next.viewport, width).length - viewportLines(model.viewport, width).length;
    return [{ ...next, viewport: { ...next.viewport, offset: Math.max(0, next.viewport.offset + addedLines) } }, commands];
  }
  return [next, commands];
}
/** Permission answer options. Values match the downstream mapping in src/index.ts. */
export const PERMISSION_OPTIONS = [
  { value: 'y', key: 'y', label: 'Allow once', tone: tokyoNight.green },
  { value: 'a', key: 'a', label: 'Allow for session', tone: tokyoNight.blue },
  { value: 'n', key: 'n', label: 'Reject', tone: tokyoNight.red },
];
function questionView(model: RootModel, composerHeight: number): string[] {
  if (!model.question.active) return [];
  if (model.question.permission) {
    const sel = Math.min(model.question.selected, PERMISSION_OPTIONS.length - 1);
    const rows = PERMISSION_OPTIONS.flatMap((opt, i) => {
      const marker = i === sel ? color(tokyoNight.cyan, '› ') : '  ';
      return wrap(marker + color(opt.tone, `[${opt.key}] ${opt.label}`), model.width);
    });
    rows.push(...wrap(color(tokyoNight.muted, '↑↓ move · Enter confirm · Wheel scroll · Ctrl+X D diff · Esc cancel'), model.width));
    // P0 budget kept: permission block gets up to 8 rows so options + footer are never sliced.
    const available = model.height - composerHeight - 3;
    if (available <= 0) return rows.slice(0, 1);
    return rows.slice(0, Math.max(2, Math.min(8, available)));
  }
  const rows = wrap(model.question.prompt + '\nPgUp/PgDn review · Ctrl+X D diff', model.width);
  const available = model.height - composerHeight - 3;
  if (available <= 0) return rows.slice(0, 1);
  return rows.slice(-Math.max(1, Math.min(4, available)));
}

function selectionLayout(model: RootModel): SelectionLayout {
  const composerHeight = composerHeightFor(model.height, model.width, composerDisplay(model.composer).value);
  const hintLimit = Math.min(hintCap(model.height), Math.max(0, model.height - composerHeight - 4));
  const hintCount = model.composer.completionDismissed ? 0 : Math.min(hintLimit, model.composer.completions.length);
  const questionCount = questionView(model, composerHeight).length;
  // Session tab-strip chiếm 1 dòng ngay trên viewport nên trừ vào body budget.
  const bodyHeight = Math.max(0, model.height - 3 - composerHeight - hintCount - questionCount);
  return { composerHeight, bodyHeight, composerTop: model.height - composerHeight, mainWidth: model.width - sidebarWidthFor(model.width, model.sidebar.visible, model.height) };
}

export function view(model: RootModel): string {
  const { width, height } = model;
  if (height <= 2) return Array.from({ length: height }, (_, i) => paintCanvas(fit(i === 0 ? 'MINUS ' + model.mode : model.composer.value, width))).join('\n');
  // P0: compact budget on short terminals — cap composer at 3 and hints at 2
  // so bodyHeight cannot collapse to 0 when question + hints are active.
  const composerHeight = composerHeightFor(height, width, composerDisplay(model.composer).value);
  const hintLimit = Math.min(hintCap(height), Math.max(0, height - composerHeight - 4));
  const hintStart = Math.max(0, model.composer.selected - hintLimit + 1);
  const hints = model.composer.completionDismissed ? [] : model.composer.completions
    .slice(hintStart, hintStart + hintLimit)
    .map((item, index) => fit(`${model.composer.selected === hintStart + index ? '›' : ' '} ${item.label} · ${item.kind === 'session' ? 'Enter resume' : 'Space complete'}`, width));
  const questionRows = questionView(model, composerHeight);
  // Session tab-strip (1 dòng) nằm ngay trên viewport — trừ khỏi body để giữ đúng chiều cao.
  const stripRows = height > 4 ? [sessionTabStripView(model.sessions, width)] : [];
  const bodyHeight = Math.max(0, height - 2 - stripRows.length - composerHeight - hints.length - questionRows.length);
  const sidebarWidth = sidebarWidthFor(width, model.sidebar.visible, height);
  const mainWidth = width - sidebarWidth;
  const selectedViewport = model.selection?.target === 'viewport' ? model.selection : undefined;
  const main = model.focus === 'palette' ? paletteView(model.palette, mainWidth, bodyHeight) : model.diff.visible ? diffView(model.diff, mainWidth, bodyHeight) : viewportView(selectedViewport ? { ...model.viewport, offset: selectedViewport.viewportOffset ?? model.viewport.offset } : model.viewport, mainWidth, bodyHeight, selectedViewport?.sourceLines);
  const body = sidebarWidth ? joinHorizontal(main, sidebarView(model.sidebar, sidebarWidth, bodyHeight), mainWidth, sidebarWidth) : main;
  const displayedComposer = model.selection?.target === 'composer' ? { ...model.composer, cursorOffset: model.selection.composerCursor ?? model.composer.cursorOffset } : model.composer;
  let rows = selectionRows(model, joinVertical([headerView(model)], stripRows, body, questionRows, hints, composerView(displayedComposer, width, composerHeight), [statuslineView(model)]), selectionLayout(model));
  // Grill modal overlay: đè lên giữa màn hình (kể cả vùng input) để user thống nhất lựa chọn với LLM.
  if (model.grill.open) {
    const panel = grillView(model.grill, width, height);
    const startRow = Math.max(1, Math.floor((height - panel.length) / 2));
    rows = rows.map((row, i) => {
      const p = i - startRow;
      if (p < 0 || p >= panel.length) return row;
      return panel[p];
    });
  }
  // Session tabs modal: đè lên giữa màn hình, ngay trên viewport để chuyển/quản lý tab.
  if (model.sessions.open) {
    const panel = sessionTabsView(model.sessions, width, height);
    const startRow = Math.max(1, Math.floor((height - panel.length) / 2));
    rows = rows.map((row, i) => {
      const p = i - startRow;
      if (p < 0 || p >= panel.length) return row;
      return panel[p];
    });
  }
  // Model-picker modal: đè lên giữa màn hình, ngay trên viewport để chọn model.
  if (model.modelPicker.open) {
    const { panel, startRow } = modelPickerLayout(model.modelPicker, width, height);
    rows = rows.map((row, i) => {
      const p = i - startRow;
      if (p < 0 || p >= panel.length) return row;
      return panel[p];
    });
  }
  return Array.from({ length: height }, (_, i) => paintCanvas(fit(rows[i] || '', width))).join('\n');
}
