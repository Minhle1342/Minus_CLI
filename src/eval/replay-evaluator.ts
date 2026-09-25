import fs from 'node:fs';
import path from 'node:path';
import { Session } from '../session/session.js';
import { colors as c } from '../ui/cli-ui.js';

export interface TrajectoryEvaluationResult {
  sessionId: string;
  totalTurns: number;
  totalSteps: number;
  totalTokens: number;
  cacheHitRate: number;
  toolUsageCount: number;
  toolBreakdown: Record<string, number>;
  guardianBlocksCount: number;
  duplicateToolCallsCount: number;
  hasCompletedGoal: boolean;
  score: number; // 0 - 100
  recommendations: string[];
}

/**
 * ReplayEvaluator: Thẩm định trajectory lịch sử session đã lưu (Zero API Cost)
 */
export class ReplayEvaluator {
  /**
   * Đánh giá một file session JSON đã lưu
   */
  static evaluateSessionFile(filePath: string): TrajectoryEvaluationResult {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const messages = Array.isArray(data) ? data : data.messages || [];
    return this.evaluateMessages(messages, path.basename(filePath, '.json'));
  }

  /**
   * Đánh giá trực tiếp danh sách messages của một trajectory (in-memory)
   */
  static evaluateMessages(messages: any[], sessionId = 'session-trajectory'): TrajectoryEvaluationResult {
    let totalSteps = 0;
    let totalTurns = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let toolUsageCount = 0;
    const toolBreakdown: Record<string, number> = {};
    let guardianBlocksCount = 0;
    let duplicateToolCallsCount = 0;
    let hasCompletedGoal = false;
    const seenToolCalls = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'user') {
        totalTurns++;
      }
      if (msg.role === 'assistant') {
        totalSteps++;
        if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            toolUsageCount++;
            toolBreakdown[tc.name] = (toolBreakdown[tc.name] || 0) + 1;
            if (tc.name === 'submit_solution') {
              hasCompletedGoal = true;
            }
            const signature = `${tc.name}:${JSON.stringify(tc.args || {})}`;
            if (seenToolCalls.has(signature)) {
              duplicateToolCallsCount++;
            } else {
              seenToolCalls.add(signature);
            }
          }
        }
      }
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        if (
          msg.content.includes('BLOCKED') ||
          msg.content.includes('UNVERIFIED_MUTATION_BLOCKED') ||
          msg.content.includes('GUARDIAN')
        ) {
          guardianBlocksCount++;
        }
      }
      if (msg.usage) {
        promptTokens += msg.usage.promptTokens || 0;
        completionTokens += msg.usage.completionTokens || 0;
        cachedTokens += msg.usage.cachedTokens || 0;
      }
    }

    const totalTokens = promptTokens + completionTokens;
    const cacheHitRate = promptTokens > 0 ? Number(((cachedTokens / promptTokens) * 100).toFixed(1)) : 0;

    // Tính điểm chất lượng Trajectory (Thang 100)
    let score = 100;
    const recommendations: string[] = [];

    if (!hasCompletedGoal) {
      score -= 30;
      recommendations.push('Agent kết thúc mà chưa gọi submit_solution.');
    }
    if (duplicateToolCallsCount > 2) {
      score -= Math.min(20, duplicateToolCallsCount * 5);
      recommendations.push(`Phát hiện ${duplicateToolCallsCount} lượt gọi tool trùng lặp tham số (vòng lặp thừa).`);
    }
    if (guardianBlocksCount > 0) {
      score -= Math.min(20, guardianBlocksCount * 5);
      recommendations.push(`Agent bị ToolUseGuardian can thiệp chặn ${guardianBlocksCount} lần do vi phạm rule.`);
    }
    if (cacheHitRate < 30 && totalTokens > 20000) {
      recommendations.push('Tỷ lệ cache hit thấp (<30%), cần tối ưu tiền tố Prompt Cache.');
    }

    score = Math.max(0, score);

    return {
      sessionId,
      totalTurns,
      totalSteps,
      totalTokens,
      cacheHitRate,
      toolUsageCount,
      toolBreakdown,
      guardianBlocksCount,
      duplicateToolCallsCount,
      hasCompletedGoal,
      score,
      recommendations,
    };
  }

  /**
   * Quét toàn bộ thư mục sessions và xuất báo cáo tổng quan
   */
  static evaluateDirectory(sessionsDir: string): TrajectoryEvaluationResult[] {
    if (!fs.existsSync(sessionsDir)) return [];
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    return files.map((file) => this.evaluateSessionFile(path.join(sessionsDir, file)));
  }
}
