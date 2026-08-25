import { type FunctionCall } from '@google/genai';

export interface StepSummaryInput {
  step: number;
  userGoal?: string;
  text?: string;
  reasoningContent?: string;
  toolCalls?: FunctionCall[];
}

/**
 * Tóm tắt hành vi/ý định suy luận của LLM trong step hiện tại bằng mô hình mistral/codestral-latest.
 */
export async function summarizeStepWithCodestral(
  input: StepSummaryInput,
  apiKey?: string,
): Promise<string> {
  const mistralKey = apiKey || process.env.MISTRAL_API_KEY;

  // Nếu không có API Key, fallback sang heuristic tóm tắt nhanh
  if (!mistralKey) {
    return generateFallbackStepSummary(input);
  }

  const toolCallsFormatted = input.toolCalls && input.toolCalls.length > 0
    ? input.toolCalls.map((tc) => {
        const argsStr = tc.args ? JSON.stringify(tc.args).slice(0, 150) : '{}';
        return `${tc.name}(${argsStr})`;
      }).join(', ')
    : 'Không gọi công cụ (trả lời trực tiếp/hoàn thành)';

  const reasoningSnippet = input.reasoningContent ? input.reasoningContent.slice(0, 1000) : '';
  const textSnippet = input.text ? input.text.slice(0, 800) : '';

  const prompt = [
    `Bạn là một chuyên gia giám sát hành vi của AI coding agent. Hãy tóm tắt hành vi và ý định suy luận của Agent ở Step ${input.step} trong ĐÚNG 1 câu tiếng Việt ngắn gọn, súc tích (khoảng 15-25 từ).`,
    '',
    `[Ngữ cảnh Step ${input.step}]:`,
    input.userGoal ? `- Mục tiêu người dùng: ${input.userGoal.slice(0, 200)}` : '',
    reasoningSnippet ? `- Suy luận nội tâm: ${reasoningSnippet}` : '',
    textSnippet ? `- Phản hồi sơ bộ: ${textSnippet}` : '',
    `- Công cụ thực thi: ${toolCallsFormatted}`,
    '',
    'Quy tắc:',
    '1. Trả về DUY NHẤT 1 câu tóm tắt hành vi (ví dụ: "Đang đọc file src/ui/cli-ui.ts để phân tích vị trí render reasoning.", "Đang thực thi lệnh npm test để kiểm chứng các unit test.").',
    '2. Tuyệt đối không thêm lời giải thích thừa, tiêu đề hay markdown code blocks.',
  ].filter(Boolean).join('\n');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mistralKey}`,
      },
      body: JSON.stringify({
        model: 'codestral-latest',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data: any = await response.json();
      const rawContent = data?.choices?.[0]?.message?.content?.trim();
      if (rawContent) {
        // Loại bỏ ngoặc kép bao quanh nếu có
        return rawContent.replace(/^["'«“]+|["'»”]+$/g, '').trim();
      }
    }
  } catch {
    // Nếu timeout hoặc lỗi mạng, fallback sang heuristic
  }

  return generateFallbackStepSummary(input);
}

/**
 * Heuristic fallback tạo câu tóm tắt nếu mạng lỗi hoặc không có API key
 */
export function generateFallbackStepSummary(input: StepSummaryInput): string {
  if (input.toolCalls && input.toolCalls.length > 0) {
    const actions = input.toolCalls.map((tc) => {
      if (tc.name === 'read_file') {
        const p = (tc.args as any)?.path;
        return p ? `đọc file ${p}` : 'đọc file';
      }
      if (tc.name === 'replace_text' || tc.name === 'write_file' || tc.name === 'apply_patch') {
        const p = (tc.args as any)?.path || (tc.args as any)?.filePath;
        return p ? `sửa đổi file ${p}` : 'chỉnh sửa code';
      }
      if (tc.name === 'run_command') {
        const cmd = (tc.args as any)?.command;
        return cmd ? `chạy lệnh "${cmd.slice(0, 40)}"` : 'thực thi lệnh hệ thống';
      }
      if (tc.name === 'grep_search' || tc.name === 'find_by_name') {
        const q = (tc.args as any)?.query || (tc.args as any)?.pattern;
        return q ? `tìm kiếm "${q}" trong workspace` : 'tìm kiếm mã nguồn';
      }
      if (tc.name === 'submit_solution') {
        return 'nộp giải pháp hoàn thành nhiệm vụ';
      }
      return `thực thi công cụ ${tc.name}`;
    });
    return `Đang ${actions.join(' và ')}.`;
  }

  if (input.text && input.text.trim()) {
    const firstLine = input.text.trim().split('\n')[0].slice(0, 100);
    return firstLine.endsWith('.') ? firstLine : `${firstLine}.`;
  }

  return 'Đang phân tích ngữ cảnh và xác định bước thực thi tiếp theo.';
}

export interface TurnSummaryStepInfo {
  step: number;
  toolCalls?: FunctionCall[];
  toolResults?: Array<{ toolName: string; outcome: string; durationMs?: number }>;
  filesModified?: string[];
  reasoningSnippet?: string;
  textSnippet?: string;
}

export interface TurnSummaryInput {
  turn: number;
  userGoal?: string;
  steps: TurnSummaryStepInfo[];
  finalAnswer?: string;
  durationMs?: number;
  filesModified?: string[];
  testsPassed?: boolean;
}

/**
 * Tóm tắt toàn diện lượt thực thi (Turn) bằng mô hình mistral/codestral-latest ngay sau khi kết thúc turn.
 */
export async function summarizeTurnWithCodestral(
  input: TurnSummaryInput,
  apiKey?: string,
): Promise<string> {
  const mistralKey = apiKey || process.env.MISTRAL_API_KEY;

  if (!mistralKey) {
    return generateFallbackTurnSummary(input);
  }

  const stepsOverview = input.steps.map((s) => {
    const tools = (s.toolCalls || []).map((t) => t.name).join(', ');
    const results = (s.toolResults || []).map((r) => `${r.toolName}: ${r.outcome}`).join('; ');
    return `Step ${s.step}: [${tools || 'trả lời trực tiếp'}] -> ${results || 'OK'}`;
  }).join('\n');

  const filesStr = input.filesModified?.length ? input.filesModified.join(', ') : 'Không sửa đổi file';
  const finalSnippet = input.finalAnswer ? input.finalAnswer.slice(0, 400) : '';

  const prompt = [
    `Bạn là một chuyên gia giám sát AI Agent. Hãy tóm tắt ngắn gọn những việc Agent đã thực hiện và đạt được trong lượt Turn #${input.turn} trong 1-2 câu tiếng Việt súc tích, chuyên nghiệp (khoảng 20-40 từ).`,
    '',
    `[Ngữ cảnh Turn #${input.turn}]:`,
    input.userGoal ? `- Yêu cầu người dùng: ${input.userGoal.slice(0, 250)}` : '',
    `- Số bước thực hiện: ${input.steps.length} steps (${((input.durationMs || 0) / 1000).toFixed(1)}s)`,
    `- Tệp đã thay đổi: ${filesStr}`,
    input.testsPassed !== undefined ? `- Trạng thái kiểm thử: ${input.testsPassed ? 'ĐẠT' : 'KHÔNG ĐẠT'}` : '',
    `- Diễn biến các bước:`,
    stepsOverview.slice(0, 800),
    finalSnippet ? `- Kết luận cuối: ${finalSnippet}` : '',
    '',
    'Quy tắc:',
    '1. Trả về DUY NHẤT 1-2 câu tóm tắt trực diện những gì đã làm và kết quả (ví dụ: "Đã hoàn thành phân tích và chỉnh sửa src/ui/cli-ui.ts, chuyển cơ chế tóm tắt AI về cuối mỗi turn và chạy thành công bộ kiểm thử.").',
    '2. Không thêm lời chào, tiêu đề hay markdown code blocks.',
  ].filter(Boolean).join('\n');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mistralKey}`,
      },
      body: JSON.stringify({
        model: 'codestral-latest',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data: any = await response.json();
      const rawContent = data?.choices?.[0]?.message?.content?.trim();
      if (rawContent) {
        return rawContent.replace(/^["'«“]+|["'»”]+$/g, '').trim();
      }
    }
  } catch {
    // fallback
  }

  return generateFallbackTurnSummary(input);
}

/**
 * Fallback tạo tóm tắt turn nếu không có API key hoặc mạng chậm
 */
export function generateFallbackTurnSummary(input: TurnSummaryInput): string {
  const stepsCount = input.steps.length;
  const filesCount = input.filesModified?.length || 0;
  const toolNames = Array.from(new Set(input.steps.flatMap((s) => (s.toolCalls || []).map((t) => t.name))));

  let summary = `Hoàn thành Turn #${input.turn} qua ${stepsCount} bước thực thi`;
  if (toolNames.length > 0) {
    summary += ` (${toolNames.slice(0, 4).join(', ')}${toolNames.length > 4 ? '...' : ''})`;
  }
  if (filesCount > 0) {
    summary += `, đã sửa đổi ${filesCount} tệp`;
  }
  if (input.testsPassed !== undefined) {
    summary += input.testsPassed ? ', kiểm thử đạt chuẩn.' : ', cần kiểm tra lại kiểm thử.';
  } else {
    summary += '.';
  }
  return summary;
}
