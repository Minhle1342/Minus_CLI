import type { IWebTransport } from './gemini-web-bridge.js';
import { GEMINI_WEB_SELECTORS } from './gemini-web-bridge.js';

/** Tối thiểu page cần để lái tab Gemini — dễ mock test, adapter thật bên dưới. */
export interface GeminiWebPage {
  url(): string;
  bringToFront(): Promise<void>;
  fillInput(text: string): Promise<void>;
  clickSend(): Promise<void>;
  clickStop(): Promise<void>;
  isGenerating(): Promise<boolean>;
  responseText(): Promise<string>;
}

export type PageProvider = () => Promise<GeminiWebPage>;

function first(sel: string[]): string {
  return sel[0];
}

/** Phạm vi click tối thiểu để bấm nút gửi — tách riêng để test được fallback. */
export interface ClickScope {
  click(sel: string): Promise<void>;
  pressEnter(): Promise<void>;
}

/** Thử từng selector, rớt hết thì Enter trên ô input (Gemini Enter = gửi). */
export async function clickSendRobust(scope: ClickScope, sels: string[]): Promise<void> {
  let lastErr: any = new Error('No send selectors configured');
  for (const s of sels) {
    try {
      await scope.click(s);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  await scope.pressEnter().catch((e: any) => { lastErr = e; throw lastErr; });
}

/** Adapter page Playwright thật sang GeminiWebPage (selectors có fallback). */
export async function connectChromeTab(port = 9222): Promise<GeminiWebPage> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is not installed. Run: npm i playwright');
  }
  let browser: import('playwright').Browser;
  try {
    browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${port}` });
  } catch {
    throw new Error(
      `Cannot reach Chrome on port ${port}. Start Chrome with: chrome --remote-debugging-port=${port} (giữ nguyên profile để giữ đăng nhập), rồi mở gemini.google.com.`,
    );
  }
  const context = browser.contexts()[0] ?? (await (browser as any).newContext?.());
  const pages: import('playwright').Page[] = context?.pages?.() ?? [];
  let raw = pages.find((p) => (p.url() || '').includes('gemini.google.com'));
  if (!raw) {
    raw = await context.newPage();
    await raw.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  }
  const tryAll = async <T>(sels: string[], fn: (loc: import('playwright').Locator) => Promise<T>): Promise<T> => {
    let lastErr: any;
    for (const s of sels) {
      try {
        return await fn(raw.locator(s).first());
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };
  return {
    url: () => raw.url(),
    bringToFront: async () => { await raw.bringToFront(); },
    // fill programmatic + append từng chunk 8000 ký tự để DOM không đứng với payload lớn
    fillInput: async (text: string) => {
      await tryAll(GEMINI_WEB_SELECTORS.chatInput, (loc) => loc.click());
      const firstSel = first(GEMINI_WEB_SELECTORS.chatInput);
      await raw.locator(firstSel).first().fill(text.slice(0, 8000));
      for (let i = 8000; i < text.length; i += 8000) {
        await raw.evaluate(
          `(([sel, chunk]) => {
            const el = document.querySelector(sel);
            if (el) {
              el.textContent = (el.textContent ?? '') + chunk;
              el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
          })([${JSON.stringify(firstSel)}, ${JSON.stringify(text.slice(i, i + 8000))}])`,
        );
      }
    },
    clickSend: async () => {
      await clickSendRobust(
        {
          click: async (s: string) => { await raw.locator(s).first().click({ timeout: 3000 }); },
          pressEnter: async () => {
            const input = first(GEMINI_WEB_SELECTORS.chatInput);
            await raw.locator(input).first().click({ timeout: 3000 });
            await raw.keyboard.press('Enter');
          },
        },
        GEMINI_WEB_SELECTORS.sendButton,
      );
    },
    clickStop: async () => { await tryAll(GEMINI_WEB_SELECTORS.stopButton, (loc) => loc.click()); },
    isGenerating: async () => {
      for (const s of GEMINI_WEB_SELECTORS.stopButton) {
        try {
          if (await raw.locator(s).first().isVisible()) return true;
        } catch { /* thử selector tiếp */ }
      }
      return false;
    },
    responseText: async () => {
      for (const s of GEMINI_WEB_SELECTORS.responseContainer) {
        try {
          const loc = raw.locator(s);
          const n = await loc.count();
          if (n > 0) return (await loc.last().innerText()) ?? '';
        } catch { /* thử selector tiếp */ }
      }
      return '';
    },
  };
}

/** Giao ước turn đầu với tab web: ép model trả tool bằng fenced block, xong việc trả text thuần. */
export const PROTOCOL_BOOTSTRAP = [
  'You are an autonomous coding agent driven by a local harness. Rules:',
  '1. When you need a local action, emit exactly one fenced block per call:',
  '```toolcall-json',
  '{"name":"<tool>","args":{...}}',
  '```',
  '2. You may emit several blocks across turns; wait for harness results between turns.',
  '3. When the task is fully done, reply with plain text only (no tool blocks). That text is your final answer.',
  'Reply "READY" if you accept.',
].join('\n');

/** Transport chạy trên 1 tab Gemini: điền prompt, gửi, stream delta tới khi ổn định. */
export class PlaywrightTransport implements IWebTransport {
  private cached: GeminiWebPage | null = null;
  private protocolInstalled = false;

  constructor(
    private provider: PageProvider = () => connectChromeTab(Number(process.env.GEMINI_WEB_DEBUG_PORT ?? 9222)),
    private opts?: { pollMs?: number; stableMs?: number },
  ) {}

  private async page(): Promise<GeminiWebPage> {
    if (!this.cached) this.cached = await this.provider();
    return this.cached;
  }

  async *send(payload: string): AsyncIterable<string> {
    const page = await this.page();
    await page.bringToFront();
    if (!this.protocolInstalled) {
      await this.submitAndWait(page, PROTOCOL_BOOTSTRAP);
      this.protocolInstalled = true;
    }
    const full = await this.submitAndWait(page, payload);
    if (!full.trim()) throw new Error('Gemini Web returned an empty response (selectors may not match this UI). Check selectors.config.json.');
    let last = '';
    // Phát lại toàn văn thành 1 delta để bridge stream như cũ
    yield full.slice(last.length);
  }

  /** Điền 1 lượt, gửi, đợi tới khi text ổn định; trả toàn văn lượt đó. */
  private async submitAndWait(page: GeminiWebPage, text: string): Promise<string> {
    await page.fillInput(text);
    await page.clickSend();
    const pollMs = this.opts?.pollMs ?? 500;
    const stableMs = this.opts?.stableMs ?? 800;
    let last = '';
    let stableSince = 0;
    for (;;) {
      const generating = await page.isGenerating();
      const cur = await page.responseText();
      if (cur.length > last.length) {
        last = cur;
        stableSince = 0;
      } else if (!generating && cur === last) {
        if (!stableSince) stableSince = Date.now();
        else if (Date.now() - stableSince >= stableMs) break;
      } else {
        stableSince = 0;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return last;
  }

  async cancel(): Promise<void> {
    if (this.cached) await this.cached.clickStop().catch(() => {});
  }
}
