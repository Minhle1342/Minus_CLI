import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sessionStripSegments,
  sessionTabStripView,
  sessionTabsView,
  visibleTabOrder,
} from '../models/viewport-model.js';
import type { SessionTabsModel } from '../types.js';

test('subagent tabs are excluded from top session strip and general Ctrl+T modal', () => {
  const state: SessionTabsModel = {
    tabs: [
      { id: 'session-main', title: 'Main Session', busy: false },
      { id: 'session-sub-1', title: 'Subagent: fix auth', subagent: true, busy: true },
      { id: 'session-sub-2', title: 'Subagent: audit db', subagent: true, busy: false },
      { id: 'session-feature', title: 'Feature Tab', busy: false },
    ],
    activeId: 'session-main',
    selected: 0,
    open: true,
  };

  // 1. visibleTabOrder must not include subagent tabs
  const visible = visibleTabOrder(state);
  const visibleTabs = visible.map(idx => state.tabs[idx]);
  assert.equal(visibleTabs.some(t => t.subagent), false, 'visibleTabOrder must not contain subagent tabs');
  assert.equal(visibleTabs.length, 2, 'Should only contain the 2 user sessions');

  // 2. sessionStripSegments must not render subagent tabs
  const segments = sessionStripSegments(state, 120);
  const tabSegTexts = segments.filter(s => s.zone === 'tab').map(s => s.text);
  assert.equal(tabSegTexts.some(t => t.includes('Subagent')), false, 'session strip must not render subagent tabs');
  assert.ok(tabSegTexts.some(t => t.includes('Main Session')), 'session strip must render Main Session');
  assert.ok(tabSegTexts.some(t => t.includes('Feature Tab')), 'session strip must render Feature Tab');

  // 3. sessionTabsView (Ctrl+T modal) must only list user sessions
  const modalLines = sessionTabsView(state, 80, 24);
  const modalText = modalLines.join('\n');
  assert.ok(modalText.includes('Main Session'));
  assert.ok(modalText.includes('Feature Tab'));
  assert.ok(!modalText.includes('Subagent: fix auth'), 'Ctrl+T modal must not display subagent tabs');
  assert.ok(!modalText.includes('Subagent: audit db'), 'Ctrl+T modal must not display subagent tabs');
  assert.ok(modalText.includes('SESSIONS · 2 tabs'), 'Header should count only 2 user tabs');
});
