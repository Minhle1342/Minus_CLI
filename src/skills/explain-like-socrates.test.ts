import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS } from '../ui/cli-ui.js';
import { SkillRegistry } from './skill-registry.js';
import { SkillActivator } from './skill-activator.js';
import { SuperpowersSource } from './superpowers-source.js';
import { Session } from '../session/session.js';
import { BUILTIN_ARCHITECTURE_PLAYBOOKS, EXPLAIN_LIKE_SOCRATES_PLAYBOOK } from './architecture-playbooks.js';

test('Slash Command Catalog: /explain-like-socrates is registered with aliases and category', () => {
  const cmd = SLASH_COMMANDS.find((c) => c.command === '/explain-like-socrates');
  assert.ok(cmd, 'SLASH_COMMANDS must include /explain-like-socrates');
  assert.equal(cmd.category, 'Exploration');
  assert.ok(cmd.aliases?.includes('/socrates'), 'Aliases must include /socrates');
  assert.match(cmd.description, /Socrates/i);
});

test('SuperpowersSource & SkillRegistry: registers explain-like-socrates with full playbook', () => {
  const registry = new SkillRegistry();
  SuperpowersSource.registerSuperpowers(registry);

  const manifest = registry.get('explain-like-socrates');
  assert.ok(manifest, 'explain-like-socrates must be registered in SkillRegistry');
  assert.equal(manifest.name, 'Explain Like Socrates');
  assert.equal(manifest.autoActivate, false, 'autoActivate must be false to prevent accidental context pollution');

  // Verify playbook content
  assert.ok(BUILTIN_ARCHITECTURE_PLAYBOOKS['explain-like-socrates'], 'BUILTIN_ARCHITECTURE_PLAYBOOKS must have entry');
  const content = registry.loadContent('explain-like-socrates');
  assert.ok(content, 'loadContent must return non-null string');
  assert.match(content, /EXPLAIN LIKE SOCRATES/);
  assert.match(content, /Single Analogy/);
  assert.match(content, /Guided Reasoning/);
});

test('SkillActivator: explain-like-socrates is strictly gated by slash command', () => {
  const registry = new SkillRegistry();
  SuperpowersSource.registerSuperpowers(registry);
  const activator = new SkillActivator(registry);
  const session = new Session();

  // Test 1: Generic explanation prompt without slash command -> NOT ACTIVATED
  const genericRes = activator.evaluate({
    session,
    userRequest: 'Giải thích cho tôi về cơ chế Event Loop trong Node.js',
  });
  assert.equal(
    genericRes.activeSkills.some((s) => s.id === 'explain-like-socrates'),
    false,
    'Generic explanation prompt must NOT activate explain-like-socrates'
  );

  // Test 2: Prompt with philosophy/reasoning tags without slash command -> NOT ACTIVATED
  const tagsRes = activator.evaluate({
    session,
    userRequest: 'Hãy dùng phương pháp reasoning và philosophy để phân tích kiến trúc',
  });
  assert.equal(
    tagsRes.activeSkills.some((s) => s.id === 'explain-like-socrates'),
    false,
    'Prompt matching skill tags must NOT activate explain-like-socrates without slash command'
  );

  // Test 3: Prompt with /explain-like-socrates -> ACTIVATED
  const socratesRes = activator.evaluate({
    session,
    userRequest: '/explain-like-socrates Event Loop hoạt động như thế nào?',
  });
  assert.equal(
    socratesRes.activeSkills.some((s) => s.id === 'explain-like-socrates'),
    true,
    'Prompt starting with /explain-like-socrates MUST activate explain-like-socrates'
  );
  assert.ok(
    socratesRes.promptSections.some((sec) => sec.name.includes('Explain Like Socrates')),
    'Prompt sections must contain Socratic playbook'
  );

  // Test 4: Prompt with alias /socrates -> ACTIVATED
  const aliasRes = activator.evaluate({
    session,
    userRequest: '/socrates Closures trong JavaScript là gì?',
  });
  assert.equal(
    aliasRes.activeSkills.some((s) => s.id === 'explain-like-socrates'),
    true,
    'Prompt starting with alias /socrates MUST activate explain-like-socrates'
  );

  // Test 5: Mid-prompt slash command invocation -> ACTIVATED
  const midPromptRes = activator.evaluate({
    session,
    userRequest: 'Hãy xem đoạn code này và /explain-like-socrates cơ chế bất đồng bộ',
  });
  assert.equal(
    midPromptRes.activeSkills.some((s) => s.id === 'explain-like-socrates'),
    true,
    'Mid-prompt invocation of /explain-like-socrates MUST activate explain-like-socrates'
  );
});
