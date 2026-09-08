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
  } = {}
): InkAppHandle {
  const instance = render(
    <App store={store} onSubmitPrompt={options.onSubmitPrompt} />,
    {
      patchConsole: false,
    }
  );

  return {
    instance,
    unmount: () => instance.unmount(),
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
  };
}
