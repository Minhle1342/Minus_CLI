import { Session } from '../session/session.js';
import { AgentLoop } from '../agent/agent-loop.js';
import { getModelTokenProfile } from '../llm/token-config.js';

export interface ContextLayerMetric {
  name: string;
  category: 'system' | 'memory' | 'plan' | 'history' | 'attachments' | 'tools';
  estimatedTokens: number;
  itemCount: number;
  description: string;
  percentage: number;
}

export interface ContextInspectionReport {
  sessionId: string;
  modelName: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  totalEstimatedTokens: number;
  utilizationPercent: number;
  cacheHitRate?: number;
  cachedTokens?: number;
  layers: ContextLayerMetric[];
  turnCount: number;
  messageCount: number;
  toolDeclarationTokens: number;
  recommendations: string[];
}

/**
 * Ước lượng số token từ chuỗi văn bản (khoảng 3.5 ký tự mỗi token cho mã nguồn + tiếng Việt)
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * Phân tích và kiểm tra toàn diện các tầng ngữ cảnh (Context Layers) của Tác nhân Agent
 */
export function inspectContext(
  session: Session,
  agentLoop: AgentLoop,
  modelName: string
): ContextInspectionReport {
  const profile = getModelTokenProfile(modelName);
  const tokenConfig = agentLoop.getTokenConfig();
  const maxInputTokens = tokenConfig?.maxInputTokens || profile.maxSupportedInputTokens;
  const maxOutputTokens = tokenConfig?.maxOutputTokens || profile.maxSupportedOutputTokens;

  // 1. Phân tích Tầng System Prompt & Tool Declarations
  const tools = (agentLoop as any).toolRegistry ? (agentLoop as any).toolRegistry.getAll() : [];
  const toolsJson = JSON.stringify(tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters })));
  const toolDeclarationTokens = estimateTokens(toolsJson);

  const baseSystemPrompt = (agentLoop.promptAssembler as any)?.renderBasePrompt
    ? (agentLoop.promptAssembler as any).renderBasePrompt()
    : 'System Persona and Tool Contracts';
  const systemPromptTokens = estimateTokens(baseSystemPrompt) + toolDeclarationTokens;

  // 2. Phân tích Tầng Bộ nhớ dự án (Project Memory)
  const memoryRecords = session.getMemoryRecords ? session.getMemoryRecords() : [];
  const learnedInsights = (agentLoop.memoryManager as any)?.getProjectMemory
    ? (agentLoop.memoryManager as any).getProjectMemory()?.learnedInsights || []
    : [];
  const memoryText = JSON.stringify([...memoryRecords, ...learnedInsights]);
  const memoryTokens = estimateTokens(memoryText);

  // 3. Phân tích Tầng Kế hoạch động & Mục tiêu (Plan & Goal)
  const tasks = agentLoop.planManager.getTasks();
  const goalState = agentLoop.goalManager.getState();
  const planText = JSON.stringify({ tasks, goal: goalState });
  const planTokens = estimateTokens(planText);

  // 4. Phân tích Lịch sử hội thoại (Message History)
  const history = session.getHistory();
  let userChars = 0;
  let modelChars = 0;
  let toolCallChars = 0;
  let toolResultChars = 0;

  for (const msg of history) {
    for (const part of (msg.parts || [])) {
      if (part.text) {
        if (msg.role === 'user') userChars += part.text.length;
        else modelChars += part.text.length;
      }
      if (part.functionCall) {
        toolCallChars += JSON.stringify(part.functionCall).length;
      }
      if (part.functionResponse) {
        toolResultChars += JSON.stringify(part.functionResponse).length;
      }
    }
  }

  const historyUserTokens = estimateTokens(' '.repeat(userChars));
  const historyModelTokens = estimateTokens(' '.repeat(modelChars));
  const historyToolTokens = estimateTokens(' '.repeat(toolCallChars + toolResultChars));
  const totalHistoryTokens = historyUserTokens + historyModelTokens + historyToolTokens;

  // 5. Phân tích Đính kèm tệp tin (@mentions)
  let attachmentChars = 0;
  let attachmentCount = 0;
  for (const msg of history) {
    if (msg.role === 'user') {
      for (const part of (msg.parts || [])) {
        if (typeof part?.text === 'string' && part.text.includes('<file_content')) {
          attachmentChars += part.text.length;
          attachmentCount++;
        }
      }
    }
  }
  const attachmentTokens = estimateTokens(' '.repeat(attachmentChars));

  const totalEstimatedTokens = systemPromptTokens + memoryTokens + planTokens + totalHistoryTokens + attachmentTokens;
  const utilizationPercent = Math.min(100, Number(((totalEstimatedTokens / maxInputTokens) * 100).toFixed(1)));

  // Tạo báo cáo phân tầng
  const layers: ContextLayerMetric[] = [
    {
      name: 'System Prompt & Tool Schemas',
      category: 'system',
      estimatedTokens: systemPromptTokens,
      itemCount: tools.length,
      description: `Persona cốt lõi và ${tools.length} định nghĩa Tool declarations`,
      percentage: totalEstimatedTokens > 0 ? Number(((systemPromptTokens / totalEstimatedTokens) * 100).toFixed(1)) : 0,
    },
    {
      name: 'Project Memory & Conventions',
      category: 'memory',
      estimatedTokens: memoryTokens,
      itemCount: learnedInsights.length,
      description: `${learnedInsights.length} quy ước và kiến trúc dự án đã ghi nhớ`,
      percentage: totalEstimatedTokens > 0 ? Number(((memoryTokens / totalEstimatedTokens) * 100).toFixed(1)) : 0,
    },
    {
      name: 'Active Plan & Goals',
      category: 'plan',
      estimatedTokens: planTokens,
      itemCount: tasks.length,
      description: `${tasks.length} tasks trong dynamic plan + mục tiêu goal`,
      percentage: totalEstimatedTokens > 0 ? Number(((planTokens / totalEstimatedTokens) * 100).toFixed(1)) : 0,
    },
    {
      name: 'Conversation Turns & Dialogue',
      category: 'history',
      estimatedTokens: totalHistoryTokens,
      itemCount: history.length,
      description: `${session.getEvents().filter((e) => e.type === 'turn/start').length || 1} lượt trao đổi (${history.length} tin nhắn User/Model/Tool)`,
      percentage: totalEstimatedTokens > 0 ? Number(((totalHistoryTokens / totalEstimatedTokens) * 100).toFixed(1)) : 0,
    },
    {
      name: 'Attached Files (@mentions)',
      category: 'attachments',
      estimatedTokens: attachmentTokens,
      itemCount: attachmentCount,
      description: `${attachmentCount} tệp tin được đính kèm vào ngữ cảnh`,
      percentage: totalEstimatedTokens > 0 ? Number(((attachmentTokens / totalEstimatedTokens) * 100).toFixed(1)) : 0,
    },
  ];

  // Khuyến nghị nén/tối ưu ngữ cảnh (Context Health & Optimization)
  const recommendations: string[] = [];
  if (utilizationPercent > 75) {
    recommendations.push(`⚠️ Cảnh báo: Ngữ cảnh đã vượt quá 75% (${utilizationPercent}%). Gõ /compact để nén lịch sử cũ.`);
  }
  if (attachmentTokens > maxInputTokens * 0.4) {
    recommendations.push(`💡 Các tệp đính kèm chiếm ${layers[4].percentage}% context. Khuyến nghị chỉ đính kèm phần hàm cần sửa.`);
  }
  if (totalHistoryTokens > maxInputTokens * 0.5) {
    recommendations.push(`💡 Lịch sử hội thoại dài. AgentLoop hỗ trợ Immutable Prefix Caching bảo toàn KV-Cache.`);
  }
  if (recommendations.length === 0) {
    recommendations.push(`✔ Context Window đang ở trạng thái tối ưu (${utilizationPercent}% dung lượng).`);
  }

  return {
    sessionId: session.id,
    modelName,
    maxInputTokens,
    maxOutputTokens,
    totalEstimatedTokens,
    utilizationPercent,
    layers,
    turnCount: session.getEvents().filter((e) => e.type === 'turn/start').length || 1,
    messageCount: history.length,
    toolDeclarationTokens,
    recommendations,
  };
}
