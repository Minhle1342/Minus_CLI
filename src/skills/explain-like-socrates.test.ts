import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS } from '../ui/cli-ui.js';
import { SkillRegistry } from './skill-registry.js';
import { SuperpowersSource } from './superpowers-source.js';
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
