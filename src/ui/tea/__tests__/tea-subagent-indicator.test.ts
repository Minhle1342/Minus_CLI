import assert from 'node:assert/strict';
import test from 'node:test';
import { createRootModel } from '../models/root-model.js';
import { statuslineView, statuslineSubagentHit } from '../models/statusline-model.js';
import { color, tokyoNight } from '../styles/theme.js';

test('statusline renders purple Subagent working when active, and green Subagent (All done) when finished', () => {
  let model = createRootModel({ width: 120, height: 30 });

  // 1. No subagents
  let view = statuslineView(model);
  assert.ok(!view.includes('Subagent working'), 'Should not show subagent indicator when none exist');
  assert.ok(!view.includes('Subagent (All done)'), 'Should not show subagent indicator when none exist');
  assert.equal(statuslineSubagentHit(model, 10), false);

  // 2. Subagent running
  model = {
    ...model,
    sessions: {
      ...model.sessions,
      tabs: [
        { id: 'session-main', title: 'Main', busy: false },
        { id: 'sub-1', title: 'Fix bug', subagent: true, busy: true },
      ],
    },
  };
  view = statuslineView(model);
  assert.ok(view.includes('Subagent working'), 'Must show Subagent working when subagent is busy');
  assert.ok(view.includes(color(tokyoNight.purple, '● Subagent working')), 'Must be styled with tokyoNight.purple');

  // Hit test should resolve true on the subagent indicator coordinates
  assert.equal(statuslineSubagentHit(model, 2), true, 'Hit test on subagent segment should return true');

  // 3. All subagents done
  model = {
    ...model,
    sessions: {
      ...model.sessions,
      tabs: [
        { id: 'session-main', title: 'Main', busy: false },
        { id: 'sub-1', title: 'Fix bug', subagent: true, busy: false },
      ],
    },
  };
  view = statuslineView(model);
  assert.ok(!view.includes('Subagent working'), 'Should not show working when all are done');
  assert.ok(view.includes('Subagent (All done)'), 'Must show Subagent (All done) when all subagents finished');
  assert.ok(view.includes(color(tokyoNight.green, '✓ Subagent (All done)')), 'Must be styled with tokyoNight.green');
  assert.equal(statuslineSubagentHit(model, 2), true, 'Hit test on All done segment should return true');
});
