import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLazyOmission } from './aci-guardrails.js';
import { ToolUseGuardian } from '../tools/tool-use-guardian.js';

test('detectLazyOmission flags comment-only ellipsis markers', () => {
  assert.equal(detectLazyOmission('const a = 1;\n# ... rest of code unchanged\nconst b = 2;', 'x.py').length, 1);
  assert.equal(detectLazyOmission('const a = 1;\n// ...\nconst b = 2;', 'x.ts').length, 1);
  assert.equal(detectLazyOmission('line1\n...\nline3', 'x.ts').length, 1);
});

test('detectLazyOmission flags omission phrases and placeholders', () => {
  const text = 'function f() {\n  // phần còn lại giữ nguyên\n}';
  assert.equal(detectLazyOmission(text, 'x.ts').length, 1);
  assert.equal(detectLazyOmission('code\n<!-- your code here -->\nend', 'x.html').length, 1);
});

test('detectLazyOmission ignores spread operators and real code', () => {
  assert.deepEqual(detectLazyOmission('function f(...args) {\n  return foo(...args);\n}', 'x.ts'), []);
  assert.deepEqual(detectLazyOmission('const x = 1;\nconst y = x + 2;', 'x.ts'), []);
});

test('detectLazyOmission is lenient with prose files', () => {
  assert.deepEqual(detectLazyOmission('See above, same as before.\nDone.', 'doc.md'), []);
  assert.equal(detectLazyOmission('Intro.\n<!-- same as before -->\nEnd.', 'doc.md').length, 1);
});

test('guardian blocks write_file with lazy markers', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  const blocked = guardian.preCallValidate('write_file', {
    path: 'src/a.ts',
    content: 'const a = 1;\n// ... rest of code unchanged\n',
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.errorCode, 'LAZY_OMISSION_BLOCKED');
});

test('guardian allows clean content and warns on huge rewrites', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  const ok = guardian.preCallValidate('write_file', {
    path: 'src/a.ts',
    content: 'const a = 1;\nconst b = 2;\n',
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.warning, undefined);
  const huge = guardian.preCallValidate('write_file', {
    path: 'src/a.ts',
    content: Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join('\n'),
  });
  assert.equal(huge.allowed, true);
  assert.ok(String(huge.warning).includes('rewrite'));
});
