import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * Trích xuất credentials từ file ~/.codex/auth.json hoặc biến môi trường
 */
export function getCodexCredentials(): CodexAuthCredentials | null {
  // 1. Kiểm tra biến môi trường trước (nếu người dùng cấu hình thủ công trong .env)
  if (process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_TOKEN) {
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

    if (accessToken && typeof accessToken === 'string') {
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
