import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from '../tools/codebase-intelligence.js';
import type { ComposeGrillAnswer } from './compose-types.js';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Turns an underspecified feature request into an explicit engineering contract. */
export class GrillGate {
  createQuestions(objective: string): ComposeGrillAnswer[] {
    const text = objective.trim();
    const questions: ComposeGrillAnswer[] = [];
    if (!/\b(?:must|shall|when|if|only|không|phải|khi)\b/iu.test(text)) {
      questions.push({ id: 'success', question: 'Điều kiện thành công quan sát được của tính năng này là gì?' });
    }
    if (!/\b(?:error|failure|fallback|retry|timeout|lỗi|thất bại)\b/iu.test(text)) {
      questions.push({ id: 'failure', question: 'Hệ thống phải xử lý lỗi, timeout và đường lui như thế nào?' });
    }
    if (!/\b(?:compatible|migration|schema|api|breaking|tương thích|di trú)\b/iu.test(text)) {
      questions.push({ id: 'compatibility', question: 'Có ràng buộc tương thích ngược, API, schema hoặc migration nào không?' });
    }
    if (!/\b(?:tests?|verify|verification|acceptance|kiểm thử|xác minh)\b/iu.test(text)) {
      questions.push({ id: 'verification', question: 'Những lệnh kiểm thử nào phải vượt qua để chấp nhận thay đổi?' });
    }
    return questions;
  }

  answerNext(items: ComposeGrillAnswer[], answer: string): ComposeGrillAnswer[] {
    const value = answer.trim();
    if (!value) throw new Error('Grill answer must not be empty.');
    const next = items.find((item) => !item.answer);
    if (!next) throw new Error('All Grill questions are already answered.');
    return items.map((item) => item.id === next.id ? { ...item, answer: value } : { ...item });
  }

  isComplete(items: ComposeGrillAnswer[]): boolean {
    return items.every((item) => Boolean(item.answer?.trim()));
  }

  nextQuestion(items: ComposeGrillAnswer[]): ComposeGrillAnswer | undefined {
    return items.find((item) => !item.answer);
  }

  async inspectCodebase(objective: string, workspace: Workspace): Promise<string[]> {
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
}
