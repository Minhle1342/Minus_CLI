import React from 'react';
import { render, Instance } from 'ink';
import { App } from './components/App.js';
import { TuiStore } from './tui-store.js';

export * from './types.js';
export * from './tui-store.js';
export * from './components/Header.js';
export * from './components/TelemetryBar.js';
export * from './components/StepStream.js';
export * from './components/LiveReasoningBox.js';
export * from './components/DiffPreviewBox.js';
export * from './components/PermissionPromptBox.js';
export * from './components/InputPromptBar.js';
export * from './components/App.js';

export interface InkAppHandle {
  instance: Instance;
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
}

/**
 * Khởi chạy Ink Reactive TUI
 */
export function renderInkApp(
  store: TuiStore,
  options: {
    onSubmitPrompt?: (prompt: string) => void;
    onAbort?: () => void;
    patchConsole?: boolean;
  } = {}
): InkAppHandle {
  // Bật bracketed paste mode nếu đang chạy trong terminal TTY
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?2004h');
  }

  const exitHandler = () => {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?2004l');
    }
  };
  process.once('exit', exitHandler);

  const instance = render(
    <App store={store} onSubmitPrompt={options.onSubmitPrompt} onAbort={options.onAbort} />,
    {
      patchConsole: options.patchConsole ?? true,
    }
  );

  return {
    instance,
    unmount: () => {
      exitHandler();
      process.removeListener('exit', exitHandler);
      instance.unmount();
    },
    waitUntilExit: async () => {
      try {
        await instance.waitUntilExit();
      } finally {
        exitHandler();
        process.removeListener('exit', exitHandler);
      }
    },
  };
}
