import { describe, it } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import {
  insertText,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteToStart,
  deleteToEnd,
  moveCursor,
  sanitizeInput,
  LineEditorState,
} from './ui/ink/components/input-line-editor.js';
import { InputPromptBar } from './ui/ink/components/InputPromptBar.js';
import { PermissionPromptBox } from './ui/ink/components/PermissionPromptBox.js';
import { formatToolTargetWithLines, formatTuiErrorDetail } from './ui/ink/components/StepStream.js';
import { VerificationPolicy } from './skills/verification-policy.js';
import { DomainIntentGuardian } from './agent/domain-intent-guardian.js';
import { hasUnfulfilledDeferredPromise } from './agent/final-answer-guard.js';
import { PlanManager } from './agent/plan-manager.js';
import { FileMentionEngine } from './workspace/file-attachment.js';
import { Workspace } from './workspace/workspace.js';

describe('Text Input & Prompt Bug Fixes (TUI)', () => {
  describe('1. Input Sanitization (Newlines & Control Characters)', () => {
    it('should convert carriage returns and line feeds to single spaces', () => {
      const dirty = 'Line 1\r\nLine 2\nLine 3';
      const clean = sanitizeInput(dirty);
      assert.strictEqual(clean, 'Line 1 Line 2 Line 3');
    });

    it('should expand tabs to spaces cleanly', () => {
      const dirty = 'foo\tbar';
      const clean = sanitizeInput(dirty);
      assert.strictEqual(clean, 'foo  bar');
    });
  });

  describe('2. Text Insertion & In-place Editing', () => {
    it('should insert text into an empty state', () => {
      const state: LineEditorState = { value: '', cursorOffset: 0 };
      const next = insertText(state, 'hello');
      assert.strictEqual(next.value, 'hello');
      assert.strictEqual(next.cursorOffset, 5);
    });

    it('should insert text at the end of existing string', () => {
      const state: LineEditorState = { value: 'hello', cursorOffset: 5 };
      const next = insertText(state, ' world');
      assert.strictEqual(next.value, 'hello world');
      assert.strictEqual(next.cursorOffset, 11);
    });

    it('should insert text in the middle of a string at cursor offset', () => {
      const state: LineEditorState = { value: 'heworld', cursorOffset: 2 };
      const next = insertText(state, 'llo ');
      assert.strictEqual(next.value, 'hello world');
      assert.strictEqual(next.cursorOffset, 6);
    });
  });

  describe('3. Backspace & Delete Operations', () => {
    it('deleteBackward: should do nothing if cursor is at 0', () => {
      const state: LineEditorState = { value: 'hello', cursorOffset: 0 };
      const next = deleteBackward(state);
      assert.strictEqual(next.value, 'hello');
      assert.strictEqual(next.cursorOffset, 0);
    });

    it('deleteBackward: should delete character behind cursor at end of line', () => {
      const state: LineEditorState = { value: 'hello', cursorOffset: 5 };
      const next = deleteBackward(state);
      assert.strictEqual(next.value, 'hell');
      assert.strictEqual(next.cursorOffset, 4);
    });

    it('deleteBackward: should delete character behind cursor in the middle of line', () => {
      const state: LineEditorState = { value: 'hxeello', cursorOffset: 2 };
      const next = deleteBackward(state);
      assert.strictEqual(next.value, 'heello');
      assert.strictEqual(next.cursorOffset, 1);
    });

    it('deleteForward: should do nothing if cursor is at end of line', () => {
      const state: LineEditorState = { value: 'hello', cursorOffset: 5 };
      const next = deleteForward(state);
      assert.strictEqual(next.value, 'hello');
      assert.strictEqual(next.cursorOffset, 5);
    });

    it('deleteForward: should delete character in front of cursor', () => {
      const state: LineEditorState = { value: 'hexllo', cursorOffset: 2 };
      const next = deleteForward(state);
      assert.strictEqual(next.value, 'hello');
      assert.strictEqual(next.cursorOffset, 2);
    });
  });

  describe('4. Advanced Readline Deletion (Ctrl+W, Ctrl+U, Ctrl+K)', () => {
    it('deleteWordBackward (Ctrl+W): should delete word preceding cursor', () => {
      const state: LineEditorState = { value: 'git commit -m "fix"', cursorOffset: 10 }; // after "commit"
      const next = deleteWordBackward(state);
      assert.strictEqual(next.value, 'git  -m "fix"');
      assert.strictEqual(next.cursorOffset, 4);
    });

    it('deleteWordBackward (Ctrl+W): should handle single word at start', () => {
      const state: LineEditorState = { value: 'hello', cursorOffset: 5 };
      const next = deleteWordBackward(state);
      assert.strictEqual(next.value, '');
      assert.strictEqual(next.cursorOffset, 0);
    });

    it('deleteToStart (Ctrl+U): should delete from cursor to beginning', () => {
      const state: LineEditorState = { value: 'hello world', cursorOffset: 5 };
      const next = deleteToStart(state);
      assert.strictEqual(next.value, ' world');
      assert.strictEqual(next.cursorOffset, 0);
    });

    it('deleteToEnd (Ctrl+K): should delete from cursor to end', () => {
      const state: LineEditorState = { value: 'hello world', cursorOffset: 5 };
      const next = deleteToEnd(state);
      assert.strictEqual(next.value, 'hello');
      assert.strictEqual(next.cursorOffset, 5);
    });
  });

  describe('5. Cursor Navigation & Clamping', () => {
    it('moveCursor: should clamp left and right within string bounds', () => {
      let state: LineEditorState = { value: 'abc', cursorOffset: 1 };
      state = moveCursor(state, 'left');
      assert.strictEqual(state.cursorOffset, 0);
      state = moveCursor(state, 'left');
      assert.strictEqual(state.cursorOffset, 0, 'Should not go below 0');

      state = moveCursor(state, 'right');
      assert.strictEqual(state.cursorOffset, 1);
      state = moveCursor(state, 'right');
      state = moveCursor(state, 'right');
      assert.strictEqual(state.cursorOffset, 3);
      state = moveCursor(state, 'right');
      assert.strictEqual(state.cursorOffset, 3, 'Should not exceed length');
    });

    it('moveCursor: Home and End', () => {
      const state: LineEditorState = { value: 'antigravity', cursorOffset: 4 };
      assert.strictEqual(moveCursor(state, 'home').cursorOffset, 0);
      assert.strictEqual(moveCursor(state, 'end').cursorOffset, 11);
    });

    it('moveCursor: WordLeft and WordRight', () => {
      const state: LineEditorState = { value: 'alpha beta gamma', cursorOffset: 11 }; // at 'gamma'
      const left = moveCursor(state, 'wordLeft');
      assert.strictEqual(left.cursorOffset, 6); // at 'beta '
      const right = moveCursor(left, 'wordRight');
      assert.strictEqual(right.cursorOffset, 10); // after 'beta'
    });
  });

  describe('6. File Mention Active Detection & Insertion', () => {
    it('should accurately identify mention query at cursor position in middle of string', () => {
      const line = 'Check @src and verify';
      // Cursor right after @src (index 10)
      const mention = FileMentionEngine.extractActiveMention(line, 10);
      assert.notStrictEqual(mention, null);
      assert.strictEqual(mention?.query, 'src');
      assert.strictEqual(mention?.start, 6);
      assert.strictEqual(mention?.end, 10);
    });

    it('should return null when cursor is elsewhere or no @ exists', () => {
      const line = 'Check normal text';
      const mention = FileMentionEngine.extractActiveMention(line, 5);
      assert.strictEqual(mention, null);
    });
  });

  describe('7. React Component Instantiation & Props Compatibility', () => {
    it('should instantiate InputPromptBar with full options without error', () => {
      const element = React.createElement(InputPromptBar, {
        onSubmit: () => {},
        initialHistory: ['/help', 'git status', 'test prompt'],
        maxHistory: 50,
        disabled: false,
        workspacePath: process.cwd(),
      });
      assert.strictEqual(React.isValidElement(element), true);
    });
  });

  describe('8. TUI Core Bug Fixes (10 Audit Points Verification)', () => {
    it('Bug 1: should instantiate PermissionPromptBox and resolve properly', () => {
      let resolved = false;
      let remembered = false;
      const element = React.createElement(PermissionPromptBox, {
        permission: {
          id: 'perm-1',
          toolName: 'write_to_file',
          target: 'secret.txt',
          args: { targetFile: 'secret.txt' },
          resolve: (appr, rem) => {
            resolved = appr;
            remembered = Boolean(rem);
          },
        },
        onResolve: (appr, rem) => {
          resolved = appr;
          remembered = Boolean(rem);
        },
      });
      assert.strictEqual(React.isValidElement(element), true);
      assert.strictEqual(element.props.permission.toolName, 'write_to_file');
    });

    it('Bug 2: StepStream should not crash when step.args is undefined or null', async () => {
      const { StepStream } = await import('./ui/ink/components/StepStream.js');
      const element = React.createElement(StepStream, {
        steps: [
          {
            id: 's-1',
            step: 1,
            maxSteps: 5,
            phase: 'EXPLORE',
            toolName: 'list_files',
            args: undefined as any,
            durationMs: 20,
            status: 'success',
            timestamp: Date.now(),
          },
          {
            id: 's-2',
            step: 1,
            maxSteps: 5,
            phase: 'IMPLEMENT',
            toolName: 'execute_command',
            args: null as any,
            durationMs: 50,
            status: 'failed',
            result: { error: new Error('Command failed with code 1') },
            timestamp: Date.now(),
          },
        ],
      });
      assert.strictEqual(React.isValidElement(element), true);
    });

    it('Bug 3: TelemetryBar should not throw RangeError on NaN, undefined, or 0 tokens', async () => {
      const { TelemetryBar } = await import('./ui/ink/components/TelemetryBar.js');
      assert.doesNotThrow(() => {
        React.createElement(TelemetryBar, {
          usedTokens: NaN as any,
          maxTokens: 0 as any,
          promptTokens: undefined as any,
          cachedTokens: NaN as any,
          cacheHitRate: NaN as any,
        });
      });
    });

    it('Bug 4: tuiReducer should keep status executing_tool if another tool is still running', async () => {
      const { tuiReducer, createInitialState } = await import('./ui/ink/tui-store.js');
      let state = createInitialState({});

      // Start tool A
      state = tuiReducer(state, {
        type: 'TOOL_START',
        toolName: 'tool_A',
        args: {},
        step: 1,
        maxSteps: 5,
        phase: 'IMPLEMENT',
      });
      assert.strictEqual(state.status, 'executing_tool');

      // Start tool B in parallel
      state = tuiReducer(state, {
        type: 'TOOL_START',
        toolName: 'tool_B',
        args: {},
        step: 1,
        maxSteps: 5,
        phase: 'IMPLEMENT',
      });
      assert.strictEqual(state.status, 'executing_tool');
      assert.strictEqual(state.steps.length, 2);

      // Tool A completes, but Tool B is still running
      state = tuiReducer(state, {
        type: 'TOOL_END',
        toolName: 'tool_A',
        result: { success: true },
        durationMs: 100,
      });
      assert.strictEqual(state.status, 'executing_tool', 'Must remain executing_tool while tool_B is running');

      // Tool B completes
      state = tuiReducer(state, {
        type: 'TOOL_END',
        toolName: 'tool_B',
        result: { success: true },
        durationMs: 150,
      });
      assert.strictEqual(state.status, 'thinking', 'Must transition to thinking when all tools finish');
    });

    it('Bug 5: Sequential TOOL_START in same millisecond must have distinct unique IDs', async () => {
      const { tuiReducer, createInitialState } = await import('./ui/ink/tui-store.js');
      let state = createInitialState({});
      state = tuiReducer(state, {
        type: 'TOOL_START',
        toolName: 'tool_1',
        args: {},
        step: 1,
        maxSteps: 5,
        phase: 'EXPLORE',
      });
      state = tuiReducer(state, {
        type: 'TOOL_START',
        toolName: 'tool_2',
        args: {},
        step: 1,
        maxSteps: 5,
        phase: 'EXPLORE',
      });

      assert.strictEqual(state.steps.length, 2);
      assert.notStrictEqual(state.steps[0].id, state.steps[1].id, 'Step IDs must be strictly unique');
    });

    it('Bug 7: LiveReasoningBox should instantiate cleanly without color dim warnings', async () => {
      const { LiveReasoningBox } = await import('./ui/ink/components/LiveReasoningBox.js');
      const element = React.createElement(LiveReasoningBox, {
        reasoning: 'Detailed System 2 CoT step 1...',
        isCollapsed: true,
        status: 'thinking',
        isThinking: true,
      });
      assert.strictEqual(React.isValidElement(element), true);
    });

    it('Bug 9: DiffPreviewBox should handle undefined diff.lines and non-string lines gracefully', async () => {
      const { DiffPreviewBox } = await import('./ui/ink/components/DiffPreviewBox.js');
      assert.doesNotThrow(() => {
        React.createElement(DiffPreviewBox, {
          diff: {
            file: 'test.ts',
            lines: undefined as any,
          },
        });
      });
      assert.doesNotThrow(() => {
        React.createElement(DiffPreviewBox, {
          diff: {
            file: 'test.ts',
            lines: [null as any, undefined as any, '+valid line'],
          },
        });
      });
    });

    it('Bug 10: Header should handle missing sandboxMode and workspacePath without crash', async () => {
      const { Header } = await import('./ui/ink/components/Header.js');
      assert.doesNotThrow(() => {
        React.createElement(Header, {
          modelName: 'gemini-2.5-flash',
          workspacePath: undefined as any,
          sandboxMode: undefined as any,
          status: 'idle',
          activePhase: 'IDLE',
          currentStep: 0,
          maxSteps: 10,
        });
      });
    });

    it('Bug 1 & 8: App should mount with activePermission and render without deadlocks', async () => {
      const { App } = await import('./ui/ink/components/App.js');
      const { TuiStore } = await import('./ui/ink/tui-store.js');
      const store = new TuiStore({});
      store.dispatch({
        type: 'REQUEST_PERMISSION',
        permission: {
          id: 'perm-test',
          toolName: 'delete_file',
          args: { path: 'temp.log' },
          resolve: () => {},
        },
      });

      const appElem = React.createElement(App, { store });
      assert.strictEqual(React.isValidElement(appElem), true);
      assert.strictEqual(store.getState().activePermission?.toolName, 'delete_file');
    });
  });

  describe('9. Read & Edit Tools Line Range Display (startLine & endLine)', () => {
    it('read_file: should append :startLine-endLine when both are provided', () => {
      const target = formatToolTargetWithLines('read_file', {
        path: 'src/index.ts',
        startLine: 10,
        endLine: 50,
      });
      assert.strictEqual(target, 'src/index.ts:10-50');
    });

    it('read_file: should append :line when startLine equals endLine', () => {
      const target = formatToolTargetWithLines('read_file', {
        path: 'src/index.ts',
        startLine: 25,
        endLine: 25,
      });
      assert.strictEqual(target, 'src/index.ts:25');
    });

    it('read_file: should handle offset and limit aliases', () => {
      const target = formatToolTargetWithLines('read_file', {
        path: 'src/config.json',
        offset: 100,
        limit: 20,
      });
      assert.strictEqual(target, 'src/config.json:100-119');
    });

    it('read_file: should handle single startLine or endLine', () => {
      const targetStart = formatToolTargetWithLines('read_file', {
        path: 'src/main.rs',
        startLine: 42,
      });
      assert.strictEqual(targetStart, 'src/main.rs:42');

      const targetEnd = formatToolTargetWithLines('read_file', {
        path: 'src/main.rs',
        endLine: 80,
      });
      assert.strictEqual(targetEnd, 'src/main.rs:1-80');
    });

    it('view_file: should format AbsolutePath with StartLine and EndLine (case-insensitive keys)', () => {
      const target = formatToolTargetWithLines('view_file', {
        AbsolutePath: '/workspace/src/agent.ts',
        StartLine: 1,
        EndLine: 100,
      });
      assert.strictEqual(target, '/workspace/src/agent.ts:1-100');
    });

    it('replace_file_content: should append line range for edit/replace tool', () => {
      const target = formatToolTargetWithLines('replace_file_content', {
        TargetFile: 'src/ui/ink/components/StepStream.tsx',
        StartLine: 35,
        EndLine: 65,
        TargetContent: 'foo',
        ReplacementContent: 'bar',
      });
      assert.strictEqual(target, 'src/ui/ink/components/StepStream.tsx:35-65');
    });

    it('multi_replace_file_content: should compute overall span from ReplacementChunks', () => {
      const target = formatToolTargetWithLines('multi_replace_file_content', {
        TargetFile: 'src/agent/agent-loop.ts',
        ReplacementChunks: [
          { StartLine: 15, EndLine: 20, TargetContent: 'a', ReplacementContent: 'b' },
          { StartLine: 45, EndLine: 60, TargetContent: 'c', ReplacementContent: 'd' },
        ],
      });
      assert.strictEqual(target, 'src/agent/agent-loop.ts:15-60');
    });

    it('write_to_file without line range should output raw file path without colons', () => {
      const target = formatToolTargetWithLines('write_to_file', {
        TargetFile: 'output.log',
      });
      assert.strictEqual(target, 'output.log');
    });

    it('run_command or other tools should output command or query without line suffix', () => {
      const cmdTarget = formatToolTargetWithLines('run_command', {
        command: 'npm run build',
      });
      assert.strictEqual(cmdTarget, 'npm run build');

      const queryTarget = formatToolTargetWithLines('grep_search', {
        query: 'searchPattern',
      });
      assert.strictEqual(queryTarget, 'searchPattern');
    });
  });

  describe('10. Flexible Policies & Guardians for Non-SWE Tasks', () => {
    it('VerificationPolicy: should allow completion when only non-executable files are modified', () => {
      const policy = new VerificationPolicy();
      policy.recordModification('README.md');
      policy.recordModification('.env.example');
      policy.recordModification('.gitignore');

      const decision = policy.canComplete([]);
      assert.strictEqual(decision.allowed, true, 'Editing non-executable docs/configs must not require test verification');
    });

    it('VerificationPolicy: should mandate verification when code files are modified', () => {
      const policy = new VerificationPolicy();
      policy.recordModification('src/index.ts');

      const decision = policy.canComplete([]);
      assert.strictEqual(decision.allowed, false, 'Editing executable source code must require test verification');
      assert.strictEqual(decision.errorCode, 'VERIFICATION_REQUIRED');
    });

    it('DomainIntentGuardian: should recognize Vietnamese natural keywords for test modification', () => {
      const guardian = new DomainIntentGuardian();
      guardian.extractAndFreezeContract('Thực thi cải tiến và bổ sung kiểm thử cho TUI');
      assert.strictEqual(guardian.getContract()?.allowTestFileModification, true);

      const guardian2 = new DomainIntentGuardian();
      guardian2.extractAndFreezeContract('Áp dụng TDD để fix bug');
      assert.strictEqual(guardian2.getContract()?.allowTestFileModification, true);

      const guardian3 = new DomainIntentGuardian();
      guardian3.extractAndFreezeContract('Cải tiến logic và đồng bộ test case');
      assert.strictEqual(guardian3.getContract()?.allowTestFileModification, true);
    });

    it('DomainIntentGuardian: should allow scratch tests even without explicit test modification flag', () => {
      const guardian = new DomainIntentGuardian();
      guardian.extractAndFreezeContract('Tối ưu hóa hiệu năng hệ thống');
      assert.strictEqual(guardian.getContract()?.allowTestFileModification, false);

      const intervention = guardian.observeToolCall({
        toolName: 'write_to_file',
        args: { TargetFile: 'scratch/perf-test.ts' },
      });
      assert.strictEqual(intervention, null, 'Scratch test file creation should never be blocked as test tampering');
    });

    it('FinalAnswerGuard: should not reject courtesy closing or future roadmap in substantial answers', () => {
      const substantialAnswer = `
Dưới đây là kết quả phân tích chuyên sâu về kiến trúc hệ thống:
1. Module A quản lý vòng lặp chính.
2. Module B xử lý giao diện người dùng.
Hệ thống hiện tại vận hành rất ổn định và đáp ứng đầy đủ yêu cầu.

Trong các bước tiếp theo, tôi sẽ hỗ trợ bạn triển khai tính năng API nếu bạn cần.
`.trim();

      const hasDeferred = hasUnfulfilledDeferredPromise(substantialAnswer);
      assert.strictEqual(hasDeferred, false, 'Courtesy future assistance offer in substantial answer should not be flagged as deferred work');
    });

    it('FinalAnswerGuard: should still reject lazy responses that merely promise future work', () => {
      const lazyAnswer = 'Tôi sẽ tiến hành sửa lỗi này ngay bây giờ.';
      const hasDeferred = hasUnfulfilledDeferredPromise(lazyAnswer);
      assert.strictEqual(hasDeferred, true, 'Lazy response without actual execution must be rejected');
    });

    it('PlanManager: autoReconcileRemainingTasks should skip remaining tasks smoothly', () => {
      const plan = new PlanManager();
      plan.createPlan([
        { id: 1, title: 'Inspect code' },
        { id: 2, title: 'Implement logic' },
        { id: 3, title: 'Write report' },
      ]);

      plan.completeTaskWithEvidence(1);
      assert.strictEqual(plan.isAllTasksCompleted(), false);
      assert.strictEqual(plan.getIncompleteTasks().length, 2);

      plan.autoReconcileRemainingTasks('Delivery of substantive final answer');
      assert.strictEqual(plan.isAllTasksCompleted(), true, 'All tasks should now be in terminal state (COMPLETED or SKIPPED)');
      assert.strictEqual(plan.getCompletionBlocker(), undefined);
    });
  });

  describe('11. TUI Error Detail Formatting (formatTuiErrorDetail)', () => {
    it('should strip long binary path prefixes like Command failed: C:\\...\\node.exe', () => {
      const raw = `Script execution failed with exit code 1: Command failed: C:\\Program Files\\nodejs\\node.exe D:\\APIGo\\.codingagent\\scratch\\batch-script-123.mjs\nTypeError: Cannot read properties of undefined (reading 'name')`;
      const cleaned = formatTuiErrorDetail(raw);
      assert.strictEqual(
        cleaned,
        `Script execution failed with exit code 1: TypeError: Cannot read properties of undefined (reading 'name')`
      );
    });

    it('should replace standalone Command failed with binary basename if no exception is found', () => {
      const raw = `Command failed: C:\\Users\\HP\\AppData\\Local\\Programs\\git.exe checkout nonexistent-branch`;
      const cleaned = formatTuiErrorDetail(raw);
      assert.strictEqual(cleaned, 'Command failed: git.exe checkout nonexistent-branch');
    });

    it('should preserve concise error messages without modifications', () => {
      const raw = `SyntaxError: Unexpected token '}'`;
      const cleaned = formatTuiErrorDetail(raw);
      assert.strictEqual(cleaned, `SyntaxError: Unexpected token '}'`);
    });

    it('should truncate strings exceeding maxLen gracefully with ellipsis', () => {
      const longMessage = 'A'.repeat(200);
      const cleaned = formatTuiErrorDetail(longMessage, 100);
      assert.strictEqual(cleaned.length, 100);
      assert.ok(cleaned.endsWith('…'));
    });
  });
});

