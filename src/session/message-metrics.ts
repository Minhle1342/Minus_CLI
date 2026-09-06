import type { Content } from '@google/genai';
import { nativeFastHistoryStats } from '../native/index.js';
import { ExactTokenizer } from '../agent/exact-tokenizer.js';

const partCharLengthCache = new WeakMap<object, number>();
const messageCharLengthCache = new WeakMap<object, number>();
const messageTokenLengthCache = new WeakMap<object, number>();

/**
 * Lấy độ dài ký tự của một ContentPart với bộ đệm WeakMap O(1) zero-leak
 * Tránh bẫy NAPI Overhead: Không gọi FFI cho từng part nhỏ, dùng WeakMap trong V8
 */
export function getPartCharLength(part: any): number {
  if (!part || typeof part !== 'object') return 0;
  const cached = partCharLengthCache.get(part);
  if (cached !== undefined) return cached;

  let len = 0;
  if (typeof part.text === 'string') {
    len = part.text.length;
  } else if (part.functionResponse) {
    try {
      len = JSON.stringify(part.functionResponse).length;
    } catch {
      len = 0;
    }
  } else if (part.functionCall) {
    try {
      len = JSON.stringify(part.functionCall).length;
    } catch {
      len = 0;
    }
  }

  partCharLengthCache.set(part, len);
  return len;
}

/**
 * Lấy tổng độ dài ký tự của một SessionMessage với bộ đệm WeakMap
 */
export function getMessageCharLength(message: Content): number {
  if (!message || typeof message !== 'object') return 0;
  const cached = messageCharLengthCache.get(message);
  if (cached !== undefined) return cached;

  let total = 0;
  for (const part of message.parts || []) {
    total += getPartCharLength(part);
  }

  messageCharLengthCache.set(message, total);
  return total;
}

/**
 * Tính tổng số ký tự của toàn bộ danh sách lịch sử tin nhắn.
 * Nhờ WeakMap cache, các tin nhắn cũ từ các step trước đều đạt O(1) lookup,
 * triệt tiêu hoàn toàn chi phí JSON.stringify lặp lại ở mỗi step.
 */
export function getHistoryTotalChars(messages: Content[]): number {
  let total = 0;
  for (const msg of messages) {
    total += getMessageCharLength(msg);
  }
  return total;
}

/**
 * Ước lượng tokens trực tiếp từ số lượng ký tự mà không cấp phát chuỗi trắng
 */
export function estimateTokensFromChars(totalChars: number): number {
  return Math.ceil(Math.max(0, totalChars) / 3.8);
}

/**
 * Ước lượng tokens của toàn bộ lịch sử (Heuristic fallback)
 */
export function estimateHistoryTokens(messages: Content[]): number {
  return estimateTokensFromChars(getHistoryTotalChars(messages));
}

/**
 * Đếm chính xác token cho một Message bằng ExactTokenizer có bộ đệm WeakMap
 */
export function getExactMessageTokens(message: Content, modelFamily?: string): number {
  if (!message || typeof message !== 'object') return 0;
  const cached = messageTokenLengthCache.get(message);
  if (cached !== undefined) return cached;

  let total = 0;
  for (const part of message.parts || []) {
    if (!part || typeof part !== 'object') continue;
    if (typeof (part as any).text === 'string') {
      total += ExactTokenizer.countTokens((part as any).text, modelFamily);
    } else if ((part as any).functionResponse) {
      total += ExactTokenizer.countTokens(JSON.stringify((part as any).functionResponse), modelFamily);
    } else if ((part as any).functionCall) {
      total += ExactTokenizer.countTokens(JSON.stringify((part as any).functionCall), modelFamily);
    }
  }

  messageTokenLengthCache.set(message, total);
  return total;
}

/**
 * Ước lượng token chính xác cho toàn bộ lịch sử hội thoại bằng ExactTokenizer
 */
export function estimateExactHistoryTokens(messages: Content[], modelFamily?: string): number {
  let total = 0;
  for (const msg of messages) {
    total += getExactMessageTokens(msg, modelFamily);
  }
  return total;
}

/**
 * Phân tích bulk mảng chuỗi payload lớn bằng Rust Native Core (Bulk processing)
 */
export function computeBulkPayloadStats(payloads: string[]) {
  return nativeFastHistoryStats(payloads);
}
