import assert from 'node:assert/strict';
import test from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import type { KeyMsg, Msg } from '../types.js';

const key = (name: string): KeyMsg => ({ type: 'key', key: name, now: Date.now() });

test('subagent modal lists subagents, selects one for full-screen transcript view, and Esc returns to main session', () => {
  let model = createRootModel({ width: 100, height: 28 });
  model = {
    ...model,
    sessions: {
      ...model.sessions,
      tabs: [
        { id: 'session-main', title: 'Main Session', busy: false },
        { id: 'session-sub-1', title: 'Subagent: fix auth', subagent: true, busy: true },
        { id: 'session-sub-2', title: 'Subagent: audit db', subagent: true, busy: false },
      ],
      activeId: 'session-main',
    },
  };

  // 1. Open subagents modal via action
  [model] = update({ type: 'action', action: 'subagents' }, model);
  assert.equal(model.subagents?.open, true, 'Subagent modal should be open');
  assert.equal(model.focus, 'subagents', 'Focus should be subagents modal');

  const modalView = view(model);
  assert.match(modalView, /SUBAGENTS/, 'Modal header should appear in view');
  assert.match(modalView, /Subagent: fix auth/, 'Subagent 1 should be listed');
  assert.match(modalView, /Subagent: audit db/, 'Subagent 2 should be listed');

  // 2. Navigate modal down
  [model] = update(key('down'), model);
  assert.equal(model.subagents.selected, 1, 'Should navigate to second subagent');

  // 3. Press Enter to select subagent-2
  [model] = update(key('enter'), model);
  assert.equal(model.subagents.open, false, 'Modal should close on select');
  assert.equal(model.sessions.activeId, 'session-sub-2', 'Should activate subagent-2 tab');
  assert.equal(model.previousActiveSessionId, 'session-main', 'Should store previous active session');

  const subView = view(model);
  assert.match(subView, /Viewing subagent transcript \(read-only\) · Press Esc to return to main session/, 'Composer should be replaced with read-only banner');

  // 4. Press Enter while viewing subagent -> notice shown, input blocked
  [model] = update({ type: 'compose', text: 'hello' }, model);
  [model] = update(key('enter'), model);
  assert.match(model.status.notice, /Tab subagent chỉ để xem/);

  // 5. Press Esc while viewing subagent transcript -> returns to session-main
  [model] = update(key('escape'), model);
  assert.equal(model.sessions.activeId, 'session-main', 'Pressing Esc must return to main session');
});

test('subagent modal can be closed via Esc without switching session', () => {
  let model = createRootModel({ width: 100, height: 28 });
  model = {
    ...model,
    sessions: {
      ...model.sessions,
      tabs: [
        { id: 'session-main', title: 'Main Session', busy: false },
        { id: 'session-sub-1', title: 'Subagent: fix auth', subagent: true, busy: true },
      ],
      activeId: 'session-main',
    },
  };

  [model] = update({ type: 'action', action: 'subagents' }, model);
  assert.equal(model.subagents.open, true);

  [model] = update(key('escape'), model);
  assert.equal(model.subagents.open, false);
  assert.equal(model.sessions.activeId, 'session-main');
});
