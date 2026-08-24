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
