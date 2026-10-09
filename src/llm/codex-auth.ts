import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

export interface CodexAuthCredentials {
  accessToken: string;
  accountId?: string;
  refreshToken?: string;
  email?: string;
  lastRefresh?: string;
  source: 'file' | 'env';
}

/**
 * Lấy đường dẫn file auth.json của Codex CLI trên máy cục bộ
 */
export function getCodexAuthFilePath(): string {
  if (process.env.CODEX_AUTH_PATH) {
    return path.resolve(process.env.CODEX_AUTH_PATH);
  }
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

/**
 * Trích xuất credentials từ file ~/.codex/auth.json hoặc biến môi trường
 */
export function getCodexCredentials(options: { ignoreEnv?: boolean } = {}): CodexAuthCredentials | null {
  // 1. Kiểm tra biến môi trường trước (nếu người dùng cấu hình thủ công trong .env)
  const envToken = process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_TOKEN;
  if (!options.ignoreEnv && envToken && isUsableAccessToken(envToken)) {
    return {
      accessToken: process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_TOKEN || '',
      accountId: process.env.CODEX_ACCOUNT_ID,
      source: 'env',
    };
  }

  // 2. Đọc từ file auth.json của Codex CLI (~/.codex/auth.json)
  const authPath = getCodexAuthFilePath();
  if (!fs.existsSync(authPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(authPath, 'utf8');
    const data = JSON.parse(content);

    // Codex CLI auth.json format: access_token, refresh_token, account_id, id_token, tokens...
    const accessToken =
      data.access_token ||
      data.tokens?.access_token ||
      data.accessToken ||
      data.token;

    if (typeof accessToken === 'string' && isUsableAccessToken(accessToken)) {
      return {
        accessToken,
        accountId: data.account_id || data.accountId || data.tokens?.account_id,
        refreshToken: data.refresh_token || data.tokens?.refresh_token,
        email: data.email || data.user?.email,
        lastRefresh: data.last_refresh || data.updated_at,
        source: 'file',
      };
    }
  } catch (err) {
    // Không parse được file JSON
    return null;
  }

  return null;
}

/**
 * Kiểm tra xem người dùng đã đăng nhập Codex CLI bằng ChatGPT Plus/Pro hay chưa
 */
export function isCodexAuthenticated(): boolean {
  return getCodexCredentials() !== null;
}

/** Check JWT expiry locally; opaque enterprise access tokens are checked by the server. */
function isUsableAccessToken(token: string): boolean {
  if (!token.trim()) return false;
  if (token.split('.').length !== 3) return true;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

export interface CodexLoginOptions {
  signal?: AbortSignal;
  onLoginRequired?: () => void;
  onStatus?: (message: string) => void;
  login?: (signal?: AbortSignal, onOutput?: (message: string) => void) => Promise<void>;
}

/** Only resolves after credentials are available; callers can keep the old model on failure. */
export async function ensureCodexAuthenticated(options: CodexLoginOptions = {}): Promise<CodexAuthCredentials> {
  options.signal?.throwIfAborted();
  const existing = getCodexCredentials();
  if (existing) {
    options.onStatus?.('Using existing ChatGPT/Codex credentials. Browser sign-in skipped.');
    return existing;
  }
  options.onLoginRequired?.();
  await (options.login || runCodexLogin)(options.signal, options.onStatus);
  options.signal?.throwIfAborted();
  const credentials = getCodexCredentials({ ignoreEnv: true });
  if (!credentials) throw new Error('ChatGPT login did not return a valid Codex access token. Please try again.');
  return credentials;
}

/** Delegate OAuth and the localhost callback to the official CLI, never a shell. */
export async function runCodexLogin(signal?: AbortSignal, onOutput?: (message: string) => void): Promise<void> {
  signal?.throwIfAborted();
  const args = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'login'];
  let executable = 'codex';
  if (process.platform === 'win32') {
    // npm installs a .cmd shim on Windows, which cannot be spawned without a shell.
    // Run its JS entry point directly instead; also support a standalone executable.
    const directories = (process.env.PATH || '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g, ''));
    const native = directories.map(dir => path.join(dir, 'codex.exe')).find(file => fs.existsSync(file));
    const script = directories.map(dir => path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')).find(file => fs.existsSync(file));
    if (native) executable = native;
    else if (script) { executable = process.execPath; args.unshift(script); }
    else throw new Error('Codex CLI is required for ChatGPT login. Install it with: npm install -g @openai/codex');
  }
  const authPath = getCodexAuthFilePath();
  const codexHome = path.dirname(authPath);
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.CODEX_ACCESS_TOKEN; delete env.CODEX_TOKEN; delete env.OPENAI_API_KEY;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stop = (error: Error) => {
      if (process.platform === 'win32' && child.pid) {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
          if (error) child.kill();
        });
      } else child.kill('SIGTERM');
      cleanup(); reject(error);
    };
    const abort = () => stop(new DOMException('ChatGPT login cancelled', 'AbortError'));
    const timer = setTimeout(() => stop(new Error('ChatGPT login timed out. Please try /model again.')), 5 * 60_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const report = (chunk: Buffer) => (onOutput || console.log)(String(chunk).trimEnd());
    child.stdout?.on('data', report);
    child.stderr?.on('data', report);
    child.once('error', () => {
      cleanup(); reject(new Error('Could not start Codex login. Install Codex CLI with: npm install -g @openai/codex'));
    });
    child.once('close', code => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error('ChatGPT login failed or was cancelled. The current model is unchanged.'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  // Codex always writes auth.json; honor an explicitly configured custom filename too.
  const writtenPath = path.join(codexHome, 'auth.json');
  if (path.resolve(writtenPath) !== path.resolve(authPath)) {
    fs.copyFileSync(writtenPath, authPath);
    fs.chmodSync(authPath, 0o600);
  }
}
