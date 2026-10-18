import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from '../tools/codebase-intelligence.js';
import type { ComposeGrillAnswer } from './compose-types.js';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Ngữ cảnh bổ trợ để GrillGate ưu tiên câu hỏi phù hợp nhất mỗi loại tác vụ. */
export interface GrillContext {
  /** 'feature' | 'bugfix' | 'refactor' | 'security' | ... */
  taskClass?: string;
  /** 'explore' | 'plan' | 'implement' | 'verify' | 'release' | ... */
  phase?: string;
  /** Khi đúng, GrillGate không chờ người dùng — tự đánh giá và trả về best-judgment. */
  headless?: boolean;
}

/** Một câu hỏi làm rõ spec, có trọng số ưu tiên. */
export interface GrillQuestion extends ComposeGrillAnswer {
  /** 0..1: càng cao càng ưu tiên hỏi sớm (chỉ điền khi createQuestions có context). */
  priority?: number;
  /** Nhóm câu hỏi để hiển thị gộp: 'success' | 'failure' | 'compatibility' | 'verification' | 'domain'. */
  category?: string;
}

function hasKeyword(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => new RegExp(p, 'iu').test(lower));
}

/** Ngẫu nhiên xem câu trả lời có chứa thông tin hữu ích hay chỉ là từ vựng chung chung. */
function isVagueAnswer(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  const vague = /^(?:ok|okay|yes|no|y|n|sure|maybe|i think|should be|as usual|normal|standard|default|phải|đúng|sai|không|có)\b/i;
  if (vague.test(trimmed)) return true;
  if (trimmed.length < 8) return true; // 'yes', 'ok', 'do it' không mang tín hiệu
  return false;
}

function scoreAnswer(value: string): number {
  let score = 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (trimmed.length >= 10) score += 1;
  if (trimmed.length >= 30) score += 1;
  if (/\d|src\/|test\/|\.ts|\.js|\.py|https?:\/\//i.test(trimmed)) score += 1;
  if (!isVagueAnswer(trimmed)) score += 1;
  return Math.min(score, 4);
}

/** Đánh giá độ tin cậy của một câu trả lời (0..5). Càng thấp càng cần hỏi lại. */
export function answerConfidence(answer: string): number {
  return scoreAnswer(answer);
}

/** Turn câu trả lời thô thành điểm số phân bu GrillGate cần hỏi thêm hay không. */
export function isAnswerUseful(answer: string): boolean {
  return answerConfidence(answer) >= 3;
}

/** Turn câu trả lời thô thành điểm số phân bu GrillGate cần hỏi lại do quá chung chung. */
export function needsClarification(answer: string): boolean {
  return !isAnswerUseful(answer);
}

/** Turn câu trả lời thô thành điểm số phân bu GrillGate cần hỏi thêm hay không. */

function baseQuestions(objective: string): { id: string; question: string; category: string; basePriority: number }[] {
  const q: { id: string; question: string; category: string; basePriority: number }[] = [];
  if (!hasKeyword(objective, ['must', 'shall', 'when', 'if', 'only', 'không', 'phải', 'khi'])) {
    q.push({ id: 'success', question: 'What is the observable success condition of this feature?', category: 'success', basePriority: 5 });
  }
  if (!hasKeyword(objective, ['error', 'failure', 'fallback', 'retry', 'timeout', 'lỗi', 'thất bại'])) {
    q.push({ id: 'failure', question: 'How should the system handle errors, timeouts, and fallbacks?', category: 'failure', basePriority: 4 });
  }
  if (!hasKeyword(objective, ['compatible', 'migration', 'schema', 'api', 'breaking', 'tương thích', 'di trú'])) {
    q.push({ id: 'compatibility', question: 'Are there any backward-compatibility, API, schema, or migration constraints?', category: 'compatibility', basePriority: 3 });
  }
  if (!hasKeyword(objective, ['tests?', 'verify', 'verification', 'acceptance', 'kiểm thử', 'xác minh'])) {
    q.push({ id: 'verification', question: 'Which test commands must pass to accept the change?', category: 'verification', basePriority: 5 });
  }
  return q;
}

/** Tạo câu hỏi làm rõ spec, có trọng số ưu tiên theo ngữ cảnh tác vụ. */
export function createQuestions(objective: string, context: GrillContext = {}): GrillQuestion[] {
  const base = baseQuestions(objective);
  const { taskClass, phase, headless } = context;

  // Ưu tiên theo loại tác vụ: bugfix/security cần verification cao, refactor cần compatibility cao.
  let boostSuccess = 0;
  let boostFailure = 0;
  let boostCompat = 0;
  let boostVerify = 0;

  if (taskClass === 'bugfix' || taskClass === 'security') {
    boostVerify += 2; boostFailure += 1;
  }
  if (taskClass === 'refactor') {
    boostCompat += 3; boostSuccess += 1;
  }
  if (phase === 'verify' || phase === 'release') {
    boostVerify += 2;
  }
  if (phase === 'explore' || phase === 'plan') {
    boostSuccess += 1;
  }

  const questions: GrillQuestion[] = base.map((item) => {
    let priority = item.basePriority;
    if (item.id === 'success') priority += boostSuccess;
    if (item.id === 'failure') priority += boostFailure;
    if (item.id === 'compatibility') priority += boostCompat;
    if (item.id === 'verification') priority += boostVerify;
    return { ...item, priority };
  });

  // Sắp xếp theo priority giảm dần; cùng priority giữ nguyên thứ tự khai báo.
  questions.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  if (headless) {
    // Headless: không sinh câu hỏi — trả về mảng rỗng, caller tự áp dụng best judgment.
    return [];
  }

  return questions;
}

export function answerNext(items: ComposeGrillAnswer[], answer: string): ComposeGrillAnswer[] {
  const value = answer.trim();
  if (!value) throw new Error('Grill answer must not be empty.');
  const next = items.find((item) => !item.answer);
  if (!next) throw new Error('All Grill questions are already answered.');
  return items.map((item) => item.id === next.id ? { ...item, answer: value } : { ...item });
}

export function isComplete(items: ComposeGrillAnswer[]): boolean {
  return items.every((item) => Boolean(item.answer?.trim()));
}

export function nextQuestion(items: ComposeGrillAnswer[]): ComposeGrillAnswer | undefined {
  return items.find((item) => !item.answer);
}

/** Backward-compatible wrapper: GrillGate class used by ComposeController and tests. */
export class GrillGate {
  createQuestions(objective: string, context: GrillContext = {}): GrillQuestion[] {
    return createQuestions(objective, context);
  }

  answerNext(items: ComposeGrillAnswer[], answer: string): ComposeGrillAnswer[] {
    return answerNext(items, answer);
  }

  isComplete(items: ComposeGrillAnswer[]): boolean {
    return isComplete(items);
  }

  nextQuestion(items: ComposeGrillAnswer[]): ComposeGrillAnswer | undefined {
    return nextQuestion(items);
  }

  async inspectCodebase(objective: string, workspace: Workspace): Promise<string[]> {
    return inspectCodebase(objective, workspace);
  }
}

export async function inspectCodebase(objective: string, workspace: Workspace): Promise<string[]> {
  const service = new CodebaseIntelligenceService(workspace);
  const candidates = unique([
    ...[...objective.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    ...[...objective.matchAll(/(?:src|test|tests)[/\\][\w./\\-]+/g)].map((match) => match[0]),
  ]).slice(0, 6);
  const context: string[] = [];
  for (const candidate of candidates) {
    try {
      const relative = candidate.replaceAll('\\', '/');
      const resolved = workspace.resolveSafePath(relative);
      context.push(`Target ${relative} resolves to ${path.relative(workspace.rootDir, resolved).replaceAll('\\', '/')}.`);
    } catch {
      try {
        const symbol = await service.getSymbolContext360(candidate);
        context.push(`Symbol ${candidate}: ${JSON.stringify(symbol).slice(0, 700)}`);
      } catch {}
    }
  }
  try {
    const topology = await service.getArchitectureTopology();
    context.push(`Architecture: ${JSON.stringify(topology).slice(0, 1200)}`);
    if (/\b(?:api|route|endpoint|controller)\b/i.test(objective)) {
      const routes = await service.getRouteMap();
      context.push(`Route map: ${JSON.stringify(routes).slice(0, 900)}`);
    }
  } catch {
    if (context.length === 0) context.push('Architecture inspection unavailable; register the intended blast radius explicitly.');
  }
  return context;
}
