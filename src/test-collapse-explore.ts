import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { exploreDirectoryTree, getFileExtensionBadge } from './workspace/tree-explorer.js';
import { inspectContext } from './context/context-inspector.js';
import { CLI, UICollapsePreferences, DEFAULT_COLLAPSE_PREFERENCES } from './ui/cli-ui.js';
import { Session } from './session/session.js';
import { AgentLoop } from './agent/agent-loop.js';
import { Workspace } from './workspace/workspace.js';
import { ToolRegistry } from './tools/registry.js';

describe('Antigravity CLI Collapse & Explore Mechanism', () => {
  const currentWorkspaceDir = process.cwd();

  describe('1. Workspace Tree Explorer (exploreDirectoryTree & getFileExtensionBadge)', () => {
    it('should resolve proper badges and icons for common file extensions', () => {
      const tsBadge = getFileExtensionBadge('.ts');
      assert.strictEqual(tsBadge.badge, 'TS');
      assert.strictEqual(tsBadge.icon, '📘');

      const jsonBadge = getFileExtensionBadge('package.json');
      assert.strictEqual(jsonBadge.badge, 'JSON');

      const mdBadge = getFileExtensionBadge('.md');
      assert.strictEqual(mdBadge.badge, 'MD');

      const pyBadge = getFileExtensionBadge('.py');
      assert.strictEqual(pyBadge.badge, 'PY');

      const rsBadge = getFileExtensionBadge('.rs');
      assert.strictEqual(rsBadge.badge, 'RS');
    });

    it('should scan workspace directory tree respecting depth and ignores', async () => {
      const scanResult = await exploreDirectoryTree(currentWorkspaceDir, { maxDepth: 2 });
      assert.ok(scanResult.totalFiles > 0, 'Should find files in workspace');
      assert.ok(scanResult.totalDirectories > 0, 'Should find directories');
      assert.ok(scanResult.totalSizeBytes > 0, 'Should calculate total size');
      assert.strictEqual(scanResult.maxDepth, 2);

      // Verify node_modules and .git are ignored
      const rootChildrenNames = (scanResult.rootNode.children || []).map((c) => c.name);
      assert.ok(!rootChildrenNames.includes('node_modules'), 'node_modules must be excluded');
      assert.ok(!rootChildrenNames.includes('.git'), '.git must be excluded');
      assert.ok(rootChildrenNames.includes('src'), 'src directory must be present');
    });

    it('should render workspace tree via CLI without throwing', async () => {
      const scanResult = await exploreDirectoryTree(path.join(currentWorkspaceDir, 'src'), { maxDepth: 1 });
      assert.doesNotThrow(() => {
        CLI.renderWorkspaceTree(scanResult, { maxLines: 20 });
      });
    });
  });

  describe('2. Agent Context Inspector (inspectContext & Token Layers)', () => {
    it('should analyze and break down all 5 context layers with telemetry', () => {
      const workspace = new Workspace(currentWorkspaceDir);
      const toolRegistry = new ToolRegistry();
      const mockLLM: any = {
        name: 'openrouter/z-ai/glm-5.3-flash',
        generateText: async () => ({ text: 'mock' }),
      };
      const agentLoop = new AgentLoop(mockLLM, toolRegistry, { workspace });
      const session = new Session();

      // Add messages and memory to session
      session.addUserMessage('Khởi tạo dự án và cấu hình TUI', 'human');
      session.addModelMessage({ text: 'Tôi sẽ phân tích cấu trúc mã nguồn...' });
      session.append('memory/change', {
        memory: {
          id: 'mem-1',
          title: 'Quy ước Antigravity TUI',
          content: 'Dùng TrueColor và Box borders chuẩn',
          type: 'architecture',
          citations: [],
          tags: ['tui'],
          confidence: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any,
      });

      const report = inspectContext(session, agentLoop, 'openrouter/z-ai/glm-5.3-flash');
      assert.strictEqual(report.sessionId, session.id);
      assert.strictEqual(report.modelName, 'openrouter/z-ai/glm-5.3-flash');
      assert.ok(report.maxInputTokens > 0);
      assert.ok(report.totalEstimatedTokens > 0);
      assert.strictEqual(report.layers.length, 5);

      const systemLayer = report.layers.find((l) => l.category === 'system');
      assert.ok(systemLayer && systemLayer.estimatedTokens > 0);

      const memoryLayer = report.layers.find((l) => l.category === 'memory');
      assert.ok(memoryLayer);

      const historyLayer = report.layers.find((l) => l.category === 'history');
      assert.ok(historyLayer && historyLayer.itemCount >= 2);

      assert.ok(report.recommendations.length > 0);
    });

    it('should render context inspection via CLI without throwing', () => {
      const workspace = new Workspace(currentWorkspaceDir);
      const toolRegistry = new ToolRegistry();
      const mockLLM: any = { name: 'gemini-2.5-flash', generateText: async () => ({ text: 'ok' }) };
      const agentLoop = new AgentLoop(mockLLM, toolRegistry, { workspace });
      const session = new Session();
      session.addUserMessage('Kiểm tra', 'human');

      const report = inspectContext(session, agentLoop, 'gemini-2.5-flash');
      assert.doesNotThrow(() => {
        CLI.renderContextInspection(report);
      });
    });
  });

  describe('3. UI Collapse Preferences & Reasoning Folding (CLI.renderReasoning)', () => {
    it('should have default collapse preferences enabled for thinking and tools', () => {
      assert.strictEqual(DEFAULT_COLLAPSE_PREFERENCES.thinking, true);
      assert.strictEqual(DEFAULT_COLLAPSE_PREFERENCES.tools, true);
      assert.strictEqual(DEFAULT_COLLAPSE_PREFERENCES.diff, false);
      assert.strictEqual(DEFAULT_COLLAPSE_PREFERENCES.treeDepth, 3);
    });

    it('should render collapse status and explore menu via CLI without throwing', () => {
      assert.doesNotThrow(() => {
        CLI.renderCollapseStatus(DEFAULT_COLLAPSE_PREFERENCES);
      });

      assert.doesNotThrow(() => {
        CLI.renderExploreMenu();
      });
    });

    it('should render collapsed vs expanded reasoning streams properly', () => {
      const reasoningSample = `1. Phân tích yêu cầu người dùng
2. Kiểm tra các module trong src/ui/cli-ui.ts
3. Lập kế hoạch thêm /collapse và /explore
4. Tiến hành cập nhật AgentLoop và Session context.`;

      assert.doesNotThrow(() => {
        // Collapsed mode
        CLI.renderReasoning(reasoningSample, { collapsed: true });
        // Expanded mode
        CLI.renderReasoning(reasoningSample, { collapsed: false });
      });
    });

    it('should render deep reasoning inspection via CLI without throwing', () => {
      const data = {
        thought: 'Bước 1: Quét cây thư mục\nBước 2: Phân tích ngữ cảnh\nBước 3: Hoàn tất.',
        timestamp: '15:30:00',
        turn: 2,
        step: 1,
      };

      assert.doesNotThrow(() => {
        CLI.renderReasoningInspection(data);
      });
    });

    it('should allow AgentLoop to manage collapse preferences and latestReasoning', () => {
      const workspace = new Workspace(currentWorkspaceDir);
      const mockLLM: any = { name: 'gemini-2.5-flash', generateText: async () => ({ text: 'ok' }) };
      const agentLoop = new AgentLoop(mockLLM, new ToolRegistry(), { workspace });

      assert.strictEqual(agentLoop.collapsePreferences.thinking, true);

      agentLoop.setCollapsePreferences({ thinking: false, treeDepth: 4 });
      assert.strictEqual(agentLoop.collapsePreferences.thinking, false);
      assert.strictEqual(agentLoop.collapsePreferences.treeDepth, 4);

      agentLoop.setCollapsePreferences({ compactSteps: true });
      assert.strictEqual(agentLoop.collapsePreferences.compactSteps, true);
    });

    it('should render compact step line and Ctrl+O toast without throwing', () => {
      assert.doesNotThrow(() => {
        CLI.renderCompactStepLine('read_file', { path: 'src/agent.ts' }, 15, { success: true, content: 'export class ...' });
        CLI.renderCompactStepLine('replace_text', { path: 'src/main.py' }, 22, { success: true, hunksApplied: 1 });
        CLI.renderCompactStepLine('run_command', { command: 'cargo test' }, 1200, { success: true, stdout: 'test result: ok', exitCode: 0 });
        CLI.renderCompactStepLine('run_command', { command: 'npm test' }, 450, { success: false, error: 'Command failed', exitCode: 1 });
        CLI.renderCtrlOToggleToast(true);
        CLI.renderCtrlOToggleToast(false);
      });
    });
  });
});

