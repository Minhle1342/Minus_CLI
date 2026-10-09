/** Adapt the existing OpenAI-compatible agent wire format to Codex Responses. */
export async function fetchCodexResponse(
  baseURL: string,
  chat: any,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const input: any[] = [];
  const instructions: string[] = [];
  for (const message of chat.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' });
    } else {
      if (message.content) {
        const content = Array.isArray(message.content) ? message.content.map((part: any) =>
          part.type === 'image_url'
            ? { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' }
            : { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' }) : message.content;
        input.push({ role: message.role, content });
      }
      for (const call of message.tool_calls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const body: any = {
    model: chat.model, instructions: instructions.join('\n\n'), input,
    tools: (chat.tools || []).map((tool: any) => ({ type: 'function', ...tool.function })),
    stream: true, store: false,
    ...(chat.reasoning_effort ? { reasoning: { effort: chat.reasoning_effort } } : {}),
    ...(chat.prompt_cache_key ? { prompt_cache_key: chat.prompt_cache_key } : {}),
    ...(chat.parallel_tool_calls !== undefined ? { parallel_tool_calls: chat.parallel_tool_calls } : {}),
  };
  if (chat.tool_choice) {
    body.tool_choice = typeof chat.tool_choice === 'string' ? chat.tool_choice
      : { type: 'function', name: chat.tool_choice.function.name };
  }
  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/responses`, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  });
  if (!response.ok || !response.body) return response;

  // Keep the agent's existing text/tool/usage parser and cancellation semantics.
  const decoder = new TextDecoder(); const encoder = new TextEncoder();
  let buffer = ''; let sawText = false; let completed = false;
  const calls = new Map<number, { announced: boolean; arguments: boolean }>();
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, delta: any, finish?: string, usage?: any) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`));
  };
  const event = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
    const value = JSON.parse(data);
    if (value.type === 'error' || value.type === 'response.failed') {
      throw new Error(value.response?.error?.message || value.error?.message || value.message || 'Codex response failed.');
    }
    if (value.type === 'response.output_text.delta' || value.type === 'response.refusal.delta') {
      sawText = true; emit(controller, { content: value.delta });
    } else if (value.type === 'response.reasoning_summary_text.delta' || value.type === 'response.reasoning_text.delta') {
      emit(controller, { reasoning_content: value.delta });
    } else if (value.type === 'response.output_item.added' || value.type === 'response.output_item.done') {
      if (value.item?.type === 'function_call') {
        const index = value.output_index;
        const state = calls.get(index) || { announced: false, arguments: false };
        if (!state.announced) {
          emit(controller, { tool_calls: [{ index, id: value.item.call_id, function: { name: value.item.name } }] });
          state.announced = true;
        }
        if (!state.arguments && value.item.arguments) {
          emit(controller, { tool_calls: [{ index, function: { arguments: value.item.arguments } }] });
          state.arguments = true;
        }
        calls.set(index, state);
      }
    } else if (value.type === 'response.function_call_arguments.delta') {
      const state = calls.get(value.output_index) || { announced: false, arguments: false };
      state.arguments = true; calls.set(value.output_index, state);
      emit(controller, { tool_calls: [{ index: value.output_index, function: { arguments: value.delta } }] });
    } else if (value.type === 'response.completed' || value.type === 'response.incomplete') {
      // Some gateways emit only the final response, without incremental item events.
      for (const [index, item] of (value.response?.output || []).entries()) {
        if (item.type === 'function_call' && !calls.get(index)?.announced) {
          emit(controller, { tool_calls: [{ index, id: item.call_id, function: { name: item.name, arguments: item.arguments } }] });
          calls.set(index, { announced: true, arguments: true });
        }
        if (!sawText && item.type === 'message') {
          for (const part of item.content || []) {
            if (part.type === 'output_text') emit(controller, { content: part.text });
            if (part.type === 'refusal') emit(controller, { content: part.refusal });
          }
        }
      }
      const tokens = value.response?.usage;
      const usage = tokens ? { prompt_tokens: tokens.input_tokens, completion_tokens: tokens.output_tokens,
        total_tokens: tokens.total_tokens, prompt_tokens_details: tokens.input_tokens_details } : undefined;
      const reason = value.type === 'response.incomplete'
        ? (value.response?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length')
        : calls.size ? 'tool_calls' : 'stop';
      emit(controller, {}, reason, usage);
      controller.enqueue(encoder.encode('data: [DONE]\n\n')); completed = true;
    }
  };
  const consume = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (!completed) event(line, controller);
    }
  };
  const transformed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); consume(controller); },
    flush(controller) {
      buffer += decoder.decode(); consume(controller);
      if (buffer.trim() && !completed) event(buffer.trim(), controller);
    },
  }));
  return new Response(transformed, { status: response.status, headers: { 'Content-Type': 'text/event-stream' } });
}
