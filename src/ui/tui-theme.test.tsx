import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import React from 'react';
import { renderToString } from 'ink';
import {
  CLI,
  getTerminalWidth,
  getVisibleWidth,
  stripAnsiForDisplay,
} from './cli-ui.js';
import { supportsTerminalColor } from './tui-theme.js';
import { Header } from './ink/components/Header.js';
import { DiffPreviewBox } from './ink/components/DiffPreviewBox.js';
import { InputPromptBar } from './ink/components/InputPromptBar.js';
import { TelemetryBar } from './ink/components/TelemetryBar.js';
import { StepStream } from './ink/components/StepStream.js';
import { PermissionPromptBox } from './ink/components/PermissionPromptBox.js';
import { LiveReasoningBox } from './ink/components/LiveReasoningBox.js';

function captureAtWidth(columns: number, render: () => void): string {
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const originalLog = console.log;
  const lines: string[] = [];
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    render();
  } finally {
    console.log = originalLog;
    if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
    else Reflect.deleteProperty(process.stdout, 'columns');
  }
  return lines.join('\n');
}

function assertFits(output: string, columns: number): void {
  for (const line of stripAnsiForDisplay(output).split('\n')) {
    assert.ok(getVisibleWidth(line) <= columns, `${getVisibleWidth(line)} > ${columns}: ${line}`);
  }
}

describe('dark terminal TUI theme', () => {
  it('uses terminal capability and honors NO_COLOR', () => {
    assert.equal(supportsTerminalColor({}, true), true);
    assert.equal(supportsTerminalColor({ NO_COLOR: '' }, true), false);
    assert.equal(supportsTerminalColor({ TERM: 'dumb' }, true), false);
    assert.equal(supportsTerminalColor({}, false), false);
    assert.equal(supportsTerminalColor({ FORCE_COLOR: '1' }, false), true);
  });

  it('emits 16-color accents only when color is enabled', () => {
    const script = 'import { colors } from "./src/ui/cli-ui.ts"; process.stdout.write(colors.cyan + "x" + colors.reset)';
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' };
    delete env.NO_COLOR;
    const colored = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), env, encoding: 'utf8',
    });
    assert.equal(colored.status, 0, colored.stderr);
    assert.equal(colored.stdout, '\x1b[36mx\x1b[0m');

    const plain = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), env: { ...env, NO_COLOR: '1' }, encoding: 'utf8',
    });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, 'x');
  });

  it('keeps primary CLI screens within 40, 80 and 120 columns', () => {
    for (const columns of [40, 80, 120]) {
      const output = captureAtWidth(columns, () => {
        assert.equal(getTerminalWidth(), columns);
        CLI.renderBanner({
          modelName: 'gemini-3.1-flash-lite-preview',
          workspaceRoot: 'D:\\AgentLearn\\CodingAgent\\long-workspace',
          maxSteps: 30,
          tools: ['read_file', 'write_file'],
        });
        CLI.renderStepHeader(1, 30, { activeTask: 'Kiểm tra thay đổi dài với emoji 🧪 và tiếng Việt' });
        CLI.renderQuickCommands();
        CLI.renderHelp();
        CLI.renderModelSelector('gemini-3.1-flash-lite-preview');
        CLI.renderDockerStatus({ isAvailable: false, autoStartEnabled: false, mode: 'local' });
        CLI.renderDockerStartupPrompt();
        CLI.renderDiffView('--- a/very-long-name.ts\n+++ b/very-long-name.ts\n@@ -1,1 +1,1 @@\n-old value with a long explanation\n+new value with a long explanation', 'src/very-long-name.ts');
      });
      assertFits(output, columns);
      assert.match(output, /CHANGE PREVIEW \(DIFF VIEW\)/);
      assert.match(output, /very-long-name\.ts/);
      assert.match(output, /\+new value/);
    }
  });

  it('keeps compact tool results within 40 columns', () => {
    const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const originalWrite = process.stdout.write;
    let output = '';
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 40 });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      CLI.renderCompactOneLiner({
        step: 1, maxSteps: 30, toolName: 'replace_text',
        args: { path: 'src/very-long-name-with-emoji-🧪.ts' },
        result: { replacements: 1 }, durationMs: 120, tokens: 2300,
      });
      CLI.renderCompactOneLiner({
        step: 2, maxSteps: 30, toolName: 'replace_text',
        args: { path: 'src/very-long-name-with-emoji-🧪.ts' },
        result: { error: 'Detailed error that would otherwise exceed the terminal width' },
        durationMs: 120,
      });
    } finally {
      process.stdout.write = originalWrite;
      if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
      else Reflect.deleteProperty(process.stdout, 'columns');
    }
    assertFits(output, 40);
    assert.match(output, /replaced/);
    assert.match(output, /failed/);
  });

  it('renders Ink status, diff and input legibly at 40 columns', () => {
    const header = renderToString(React.createElement(Header, {
      modelName: 'gemini-3.1-flash-lite-preview',
      workspacePath: 'D:\\AgentLearn\\CodingAgent',
      sandboxMode: 'local',
      status: 'completed',
      activePhase: 'IDLE',
      currentStep: 1,
      maxSteps: 30,
    }), { columns: 40 });
    assertFits(header, 40);
    assert.match(stripAnsiForDisplay(header), /Hoàn tất/);

    const diff = renderToString(React.createElement(DiffPreviewBox, {
      diff: {
        file: 'src/very-long-name.ts',
        lines: ['--- a/src/very-long-name.ts', '+++ b/src/very-long-name.ts', '@@ -1,1 +1,1 @@', '-old value', '+new value'],
      },
    }), { columns: 40 });
    assertFits(diff, 40);
    assert.match(stripAnsiForDisplay(diff), /\+new value/);

    const input = renderToString(React.createElement(InputPromptBar, {
      onSubmit: () => {},
      disabled: true,
      workspacePath: process.cwd(),
    }), { columns: 40 });
    assertFits(input, 40);
    assert.match(stripAnsiForDisplay(input), /Đang chạy/);
    assert.match(stripAnsiForDisplay(input), /❯ Đang chạy/);

    const telemetry = renderToString(React.createElement(TelemetryBar, {
      usedTokens: 45_000,
      maxTokens: 100_000,
      promptTokens: 5_000,
      cachedTokens: 1_000,
      cacheHitRate: 20,
    }), { columns: 40 });
    assertFits(telemetry, 40);
    assert.match(stripAnsiForDisplay(telemetry), /Context .*%/);

    const steps = renderToString(React.createElement(StepStream, {
      steps: [{
        id: '1', step: 1, maxSteps: 30, phase: 'IMPLEMENT',
        toolName: 'replace_text', args: { path: 'src/very-long-name.ts' },
        durationMs: 230, result: { replacements: 1 }, status: 'success', timestamp: Date.now(),
      }],
    }), { columns: 40 });
    assertFits(steps, 40);
    assert.match(stripAnsiForDisplay(steps), /● replace_text/);

    const permission = renderToString(React.createElement(PermissionPromptBox, {
      permission: {
        id: 'p1', toolName: 'replace_text', target: 'src/very-long-name.ts',
        args: { path: 'src/very-long-name.ts' }, resolve: () => {},
      },
      onResolve: () => {},
    }), { columns: 40 });
    assertFits(permission, 40);
    assert.match(stripAnsiForDisplay(permission), /Công cụ replace_text/);

    const reasoning = renderToString(React.createElement(LiveReasoningBox, {
      reasoning: 'Đang xem xét một dòng giải thích khá dài ở trong terminal hẹp',
      isCollapsed: false,
      status: 'thinking',
      isThinking: true,
    }), { columns: 40 });
    assertFits(reasoning, 40);
    assert.match(stripAnsiForDisplay(reasoning), /REASONING TRACE/);
  });
});
