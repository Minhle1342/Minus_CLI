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
    : 'No tool called (direct answer/completion)';

  const reasoningSnippet = input.reasoningContent ? input.reasoningContent.slice(0, 1000) : '';
  const textSnippet = input.text ? input.text.slice(0, 800) : '';

  const prompt = [
    `You are a behavior-monitoring expert for an AI coding agent. Summarize the Agent's behavior and reasoning intent at Step ${input.step} in EXACTLY 1 short, concise English sentence (about 15-25 words).`,
    '',
    `[Step ${input.step} Context]:`,
    input.userGoal ? `- User goal: ${input.userGoal.slice(0, 200)}` : '',
    reasoningSnippet ? `- Internal reasoning: ${reasoningSnippet}` : '',
    textSnippet ? `- Preliminary response: ${textSnippet}` : '',
    `- Executed tools: ${toolCallsFormatted}`,
    '',
    'Rules:',
    '1. Return ONLY 1 behavior-summary sentence (e.g.: "Reading src/ui/cli-ui.ts to analyze the reasoning render location.", "Running npm test to verify the unit tests.").',
    '2. Never add extra explanations, headings, or markdown code blocks.',
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
        return p ? `read file ${p}` : 'read file';
      }
      if (tc.name === 'replace_text' || tc.name === 'write_file' || tc.name === 'apply_patch') {
        const p = (tc.args as any)?.path || (tc.args as any)?.filePath;
        return p ? `modify file ${p}` : 'edit code';
      }
      if (tc.name === 'run_command') {
        const cmd = (tc.args as any)?.command;
        return cmd ? `run command "${cmd.slice(0, 40)}"` : 'execute system command';
      }
      if (tc.name === 'grep_search' || tc.name === 'find_by_name') {
        const q = (tc.args as any)?.query || (tc.args as any)?.pattern;
        return q ? `search "${q}" in the workspace` : 'search the source code';
      }
      if (tc.name === 'submit_solution') {
        return 'submit the solution to complete the task';
      }
      return `execute tool ${tc.name}`;
    });
    return `Doing ${actions.join(' and ')}.`;
  }

  if (input.text && input.text.trim()) {
    const firstLine = input.text.trim().split('\n')[0].slice(0, 100);
    return firstLine.endsWith('.') ? firstLine : `${firstLine}.`;
  }

  return 'Analyzing context and determining the next execution step.';
}

