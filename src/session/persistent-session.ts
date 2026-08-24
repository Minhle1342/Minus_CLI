import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lấy đường dẫn file cấu hình session an toàn và cố định theo project root
 */
export function getSessionFilePath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // Từ src/session/ hoặc dist/session/, đi lên 2 cấp là project root
    const projectRoot = path.resolve(__dirname, '..', '..');
    return path.join(projectRoot, '.codingagent', 'session.json');
  } catch {
    return path.join(process.cwd(), '.codingagent', 'session.json');
  }
}

export const SESSION_FILE = getSessionFilePath();

export interface SessionData {
  modelName?: string;
  workspacePath?: string;
  activeSessionId?: string;
  tokenConfig?: import('../llm/token-config.js').TokenConfig;
  lastUpdated?: string;
}

/**
 * Tải thông tin cấu hình phiên làm việc trước đó (.codingagent/session.json)
 */
export function loadSession(customPath?: string): SessionData {
  const filePath = customPath || SESSION_FILE;
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content && content.trim()) {
        return JSON.parse(content);
      }
    }
  } catch (error) {
    // Không ném lỗi để tránh ngắt quá trình khởi động
  }
  return {};
}

/**
 * Lưu thông tin cấu hình phiên làm việc (merge với dữ liệu cũ)
 */
export function saveSession(data: Partial<SessionData>, customPath?: string): void {
  const filePath = customPath || SESSION_FILE;
  try {
    const current = loadSession(filePath);
    const updated: SessionData = {
      ...current,
      ...data,
      lastUpdated: new Date().toISOString(),
    };
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save session:', error);
  }
}

/**
 * Xóa thông tin phiên đã lưu
 */
export function clearSession(customPath?: string): boolean {
  const filePath = customPath || SESSION_FILE;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch (error) {
    console.error('Failed to clear session:', error);
  }
  return false;
}
