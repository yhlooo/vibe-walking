import { isRecord } from '../level/definition.ts';
import { screenshotPrompt, toolsForLevel } from './prompts.ts';
import type { ModelSettings, Protocol } from './settings.ts';

// 表示协议中结构各异的 JSON 对象。
type Item = Record<string, unknown>;
/** 统一表示各协议返回的工具调用。 */
export type ToolCall = { id: string; name: string; args: unknown; serialized: boolean };
/** 携带工具执行的文本、可选截图和失败状态。 */
export type ToolResult = { text: string; image?: string; error?: boolean };

// 把工具结果和原调用关联起来。
type CompletedCall = { call: ToolCall; result: ToolResult };
/** 将一次生成归一化为正文、历史、工具调用和用量。 */
export type Reply = {
  history: Item[];
  text: string;
  calls: ToolCall[];
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  generationSeconds?: number;
};
/** 区分模型答复和流式思考。 */
export type OutputKind = 'assistant' | 'thinking';

// 在协议层收到输出片段时通知调用方。
type EmitDelta = (kind: OutputKind, text: string) => void;

// 接收单个流事件并在结束时组装回复。
type Accumulator = { push(event: Item): boolean | void; finish(): Reply };

// 负责构造协议请求和把回复及工具结果写回历史。
type Adapter = {
  request(settings: ModelSettings, prompt: string, history: Item[], includeTools: boolean, disableReadScreen?: boolean): Item;
  read(value: unknown): Reply;
  results(calls: CompletedCall[]): Item[];
};

// 将游戏工具声明转换成 OpenAI 函数结构。
function openAIFunctions(disableReadScreen?: boolean) {
  return toolsForLevel(disableReadScreen).map((tool) => ({ ...tool, strict: false }));
}

// 将未知值按对象读取，缺失时使用空对象。
function object(value: unknown): Item {
  if (!isRecord(value)) throw new Error('模型响应格式不正确');
  return value;
}

// 将未知值按对象列表读取。
function items(value: unknown): Item[] {
  if (!Array.isArray(value)) throw new Error('模型响应缺少预期的消息');
  return value.map(object);
}

// 规范化供应商返回的工具标识、名称和参数。
function tool(id: unknown, name: unknown, args: unknown, serialized: boolean): ToolCall {
  if (typeof id !== 'string' || !id) {
    throw new Error('模型返回的工具调用缺少 ID');
  }
  return { id, name: typeof name === 'string' ? name : '', args, serialized };
}

// 合并指定类型的文本内容块。
function textBlocks(value: unknown, type: string): string {
  return items(value).flatMap((block) => block.type === type && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

// 适配 OpenAI Chat Completions 的消息和工具结构。
const chatCompletions: Adapter = {
  request(settings, prompt, history, includeTools, disableReadScreen) {
    return {
      model: settings.model, messages: [{ role: 'developer', content: prompt }, ...history], stream: true,
      stream_options: { include_usage: true },
      ...(effort(settings) ? { reasoning_effort: effort(settings) } : {}),
      ...(includeTools ? {
        tools: openAIFunctions(disableReadScreen).map((definition) => ({ type: 'function', function: definition })),
        tool_choice: 'auto',
      } : {}),
    };
  },
  read(value) {
    const choice = object(items(object(value).choices)[0]);
    if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') {
      throw new Error('Chat Completions 的响应未完成');
    }
    const message = object(choice.message);
    const invocations = message.tool_calls == null ? [] : items(message.tool_calls);
    if ((invocations.length > 0) !== (choice.finish_reason === 'tool_calls')) throw new Error('Chat Completions 的工具调用不完整');
    const calls = invocations.map((invocation) => {
      const fn = object(invocation.function);
      return tool(invocation.id, fn.name, fn.arguments, true);
    });
    const text = typeof message.content === 'string' ? message.content : typeof message.refusal === 'string' ? message.refusal : '';
    const history = [{
      role: 'assistant', content: message.content ?? (calls.length ? null : text),
      ...(calls.length ? { tool_calls: invocations } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    }];
    return { history, text, calls };
  },
  results(calls) {
    const history: Item[] = calls.map(({ call, result }) => ({ role: 'tool', tool_call_id: call.id, content: result.text }));
    for (const { result } of calls) {
      if (result.image) history.push({ role: 'user', content: [
        { type: 'text', text: screenshotPrompt },
        { type: 'image_url', image_url: { url: result.image, detail: 'auto' } },
      ] });
    }
    return history;
  },
};

// 识别 Responses 中没有可保留内容的消息。
function isEmptyResponseMessage(item: Item): boolean {
  return item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content) &&
    item.content.every((part: unknown) => isRecord(part) && part.type === 'output_text' &&
      (part.text === undefined || part.text === '') &&
      (part.annotations === undefined || (Array.isArray(part.annotations) && !part.annotations.length)));
}

// 尝试拼回被上游拆成多个输出项的单次调用。
function repairSplitResponseCalls(output: Item[]): Item[] {
  // 跳过空的回复项，以便连续查看同一次函数调用的参数片段。
  const nonEmpty = output.filter((item) => !isEmptyResponseMessage(item));
  const history: Item[] = [];
  for (let index = 0; index < nonEmpty.length; index++) {
    const item = nonEmpty[index];
    history.push(item);
    if (item.type !== 'function_call' || item.status !== 'completed' ||
        typeof item.name !== 'string' || !item.name || typeof item.call_id !== 'string' || !item.call_id ||
        typeof item.arguments !== 'string' || !item.arguments.trimStart().startsWith('{')) continue;

    // 仅收集紧随完整调用头、且没有自身名称或调用 ID 的参数片段。
    const fragments = [item.arguments];
    let next = index + 1;
    for (; next < nonEmpty.length; next++) {
      const fragment = nonEmpty[next];
      if (fragment.type !== 'function_call' || fragment.status !== 'completed' ||
          fragment.call_id != null || fragment.name != null ||
          typeof fragment.arguments !== 'string' || !fragment.arguments.trim()) break;
      fragments.push(fragment.arguments);
    }
    if (fragments.length === 1) continue;

    // 只有合并后能解析为 JSON 对象，才替换历史中的原调用。
    const args = fragments.join('');
    try {
      if (!isRecord(JSON.parse(args))) continue;
    } catch {
      continue;
    }
    history[history.length - 1] = { ...item, arguments: args };
    index = next - 1;
  }
  return history.length < nonEmpty.length ? history : output;
}

// 适配 OpenAI Responses 的输入项和函数调用结果。
const responses: Adapter = {
  request(settings, instructions, input, includeTools, disableReadScreen) {
    const level = effort(settings);
    const summary = level !== 'none' && (level || /^(?:o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(settings.model));
    return {
      model: settings.model, instructions, input, store: false, stream: true,
      include: ['reasoning.encrypted_content'],
      ...(summary || level ? { reasoning: { ...(summary ? { summary: 'auto' } : {}), ...(level ? { effort: level } : {}) } } : {}),
      ...(includeTools ? {
        tools: openAIFunctions(disableReadScreen).map((definition) => ({ type: 'function', ...definition })),
        tool_choice: 'auto',
      } : {}),
    };
  },
  read(value) {
    const response = object(value);
    if (response.status !== 'completed') throw new Error('Responses 的响应未完成');
    const history = repairSplitResponseCalls(items(response.output));
    const calls = history.filter((item) => item.type === 'function_call').map((item) => {
      if (typeof item.call_id !== 'string' || !item.call_id) throw new Error('Responses 的工具调用缺少 call_id');
      return tool(item.call_id, item.name, item.arguments, true);
    });
    const text = history.flatMap((item) => {
      if (item.type !== 'message') return [];
      return items(item.content).flatMap((block) => {
        if (block.type === 'output_text' && typeof block.text === 'string') return [block.text];
        if (block.type === 'refusal' && typeof block.refusal === 'string') return [block.refusal];
        return [];
      });
    }).join('\n');
    return { history, text, calls };
  },
  results(calls) {
    return calls.map(({ call, result }) => ({
      type: 'function_call_output', call_id: call.id,
      output: result.image ? [{ type: 'input_image', image_url: result.image, detail: 'auto' }] : result.text,
    }));
  },
};

// 适配 Anthropic Messages 的内容块和工具结果。
const anthropicMessages: Adapter = {
  request(settings, system, messages, includeTools, disableReadScreen) {
    const level = effort(settings);
    const officialEndpoint = /^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(settings.baseURL);
    const adaptive = (level && !officialEndpoint) ||
      /^(?:claude-(?:opus|sonnet)-4-[6-9]|claude-(?:opus|sonnet|haiku)-[5-9])(?:-|$)/.test(settings.model);
    return {
      model: settings.model, system, messages, max_tokens: adaptive ? 16384 : 4096, stream: true,
      ...(adaptive ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(level ? { output_config: { effort: level } } : {}),
      ...(includeTools ? {
        tools: toolsForLevel(disableReadScreen).map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })),
        tool_choice: { type: 'auto' },
      } : {}),
    };
  },
  read(value) {
    const response = object(value);
    const reason = response.stop_reason;
    if (reason !== 'end_turn' && reason !== 'tool_use' && reason !== 'stop_sequence' && reason !== 'refusal') {
      throw new Error('Anthropic Messages 的响应未完成');
    }
    const content = items(response.content);
    const calls = content.filter((item) => item.type === 'tool_use')
      .map((item) => tool(item.id, item.name, item.input, false));
    if ((calls.length > 0) !== (reason === 'tool_use')) throw new Error('Anthropic Messages 的工具调用不完整');
    return {
      history: [{ role: 'assistant', content }], text: textBlocks(content, 'text'),
      calls,
    };
  },
  results(calls) {
    const content = calls.map(({ call, result }) => ({
      type: 'tool_result', tool_use_id: call.id,
      content: result.image ? [{
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.image.slice('data:image/png;base64,'.length) },
      }] : result.text,
      ...(result.error ? { is_error: true } : {}),
    }));
    return [{ role: 'user', content }];
  },
};

// 适配 Ollama 的聊天消息及原生工具参数。
const ollamaChat: Adapter = {
  request(settings, prompt, history, includeTools, disableReadScreen) {
    const level = settings.reasoningEffort;
    const think = level === 'true' ? true : level === 'false' || level === 'none' ? false : level;
    return {
      model: settings.model, messages: [{ role: 'system', content: prompt }, ...history], stream: true,
      ...(level ? { think } : {}),
      ...(includeTools ? { tools: toolsForLevel(disableReadScreen).map((definition) => ({ type: 'function', function: definition })) } : {}),
    };
  },
  read(value) {
    const response = object(value);
    if (response.done !== true || (response.done_reason && response.done_reason !== 'stop')) {
      throw new Error('Ollama Chat 的响应未完成');
    }
    const message = object(response.message);
    const invocations = message.tool_calls == null ? [] : items(message.tool_calls);
    const text = string(message.content);
    const generationNS = tokens(response.eval_duration);
    return {
      history: [{ role: 'assistant', ...message }], text,
      calls: invocations.map((invocation, index) => {
        const fn = object(invocation.function);
        return tool(`ollama-tool-call-${index}`, fn.name, fn.arguments, false);
      }),
      inputTokens: tokens(response.prompt_eval_count),
      cachedTokens: tokens(response.prompt_eval_cached_count),
      outputTokens: tokens(response.eval_count),
      generationSeconds: generationNS ? generationNS / 1e9 : undefined,
    };
  },
  results(calls) {
    const history: Item[] = calls.map(({ call, result }) => ({ role: 'tool', tool_name: call.name, content: result.text }));
    for (const { result } of calls) {
      if (result.image) history.push({
        role: 'user', content: screenshotPrompt,
        images: [result.image.slice('data:image/png;base64,'.length)],
      });
    }
    return history;
  },
};

/** 根据配置选择请求和回复的协议适配器。 */
export const adapters: Record<Protocol, Adapter> = {
  OpenAIChatCompletions: chatCompletions,
  OpenAIResponses: responses,
  AnthropicMessages: anthropicMessages,
  OllamaChat: ollamaChat,
};

// 读取可发送给上游的思考强度。
function effort(settings: ModelSettings) {
  if (settings.reasoningEffort === 'ultra' &&
      /^https:\/\/api\.(?:openai|anthropic)\.com(?:\/|$)/i.test(settings.baseURL)) return 'max';
  return settings.reasoningEffort;
}

// 为缺失或非字符串的字段提供统一默认值。
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// 过滤无效的用量字段。
function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// 从 OpenAI 的输入用量明细读取缓存命中数。
function cachedTokens(details: unknown): number | undefined {
  return isRecord(details) ? tokens(details.cached_tokens) : undefined;
}

// 按调用索引累积 Chat Completions 的工具参数增量。
function chatStream(emit: EmitDelta): Accumulator {
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let finishReason: unknown;
  let content = '';
  let refusal = '';
  let reasoning = '';
  let usage: Item = {};
  return {
    push(event) {
      // 计量事件可能没有候选项，先合并用量再处理消息内容。
      if (isRecord(event.usage)) usage = { ...usage, ...event.usage };
      const choice = items(event.choices)[0];
      if (!choice) return;
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      if (!isRecord(choice.delta)) return;
      const delta = choice.delta;
      const thought = string(delta.reasoning_content) || string(delta.reasoning);
      const text = string(delta.content);
      const denied = string(delta.refusal);
      reasoning += string(delta.reasoning_content);
      content += text;
      refusal += denied;

      if (thought) emit('thinking', thought);
      if (text || denied) emit('assistant', text + denied);

      // 同一调用的 ID、名称和参数可能分多帧到达，按索引拼接。
      if (!Array.isArray(delta.tool_calls)) return;
      for (const part of items(delta.tool_calls)) {
        if (typeof part.index !== 'number') throw new Error('Chat Completions 的工具调用缺少序号');
        const current = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        current.id += string(part.id);
        if (isRecord(part.function)) {
          current.function.name += string(part.function.name);
          current.function.arguments += string(part.function.arguments);
        }
        calls.set(part.index, current);
      }
    },
    finish() {
      const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      const message = { content: content || null, refusal, reasoning_content: reasoning, tool_calls };
      return {
        ...chatCompletions.read({ choices: [{ message, finish_reason: finishReason }] }),
        inputTokens: tokens(usage.prompt_tokens),
        cachedTokens: cachedTokens(usage.prompt_tokens_details) ?? tokens(usage.prompt_cache_hit_tokens),
        outputTokens: tokens(usage.completion_tokens),
      };
    },
  };
}

// 接收 Responses 输出增量并交由完成事件组装历史。
function responsesStream(emit: EmitDelta): Accumulator {
  let response: Item | undefined;
  return {
    push(event) {
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        emit('assistant', string(event.delta));
      } else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
        emit('thinking', string(event.delta));
      } else if (event.type === 'response.completed') {
        // 最终事件提供协议原生历史，之前的增量已经实时显示给玩家。
        response = object(event.response);
        return true;
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        throw new Error('Responses 的响应未完成');
      }
    },
    finish() {
      const reply = responses.read(response);
      const usage = isRecord(response?.usage) ? response.usage : {};
      return {
        ...reply,
        inputTokens: tokens(usage.input_tokens),
        cachedTokens: cachedTokens(usage.input_tokens_details),
        outputTokens: tokens(usage.output_tokens),
      };
    },
  };
}

// 按内容块索引组装 Anthropic 文本、思考及工具增量。
function anthropicStream(emit: EmitDelta): Accumulator {
  const blocks = new Map<number, Item>();
  const openBlocks = new Set<number>();
  const partialInput = new Map<number, string>();
  const invalidToolInputs = new Map<unknown, string>();
  const usageFields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'] as const;
  const reported: Partial<Record<typeof usageFields[number], number>> = {};
  let stopReason: unknown;
  let stopped = false;
  return {
    push(event) {
      // 起始消息和后续事件均可能提供用量，逐字段保存最新值。
      const usage = (isRecord(event.message) ? event.message : event).usage;
      if (isRecord(usage)) {
        for (const field of usageFields) {
          const count = tokens(usage[field]);
          if (count !== undefined) reported[field] = count;
        }
      }

      if (event.type === 'message_delta') {
        stopReason = object(event.delta).stop_reason;
      } else if (event.type === 'message_stop') {
        stopped = true;
        return true;
      }
      if (typeof event.index !== 'number') return;
      const index = event.index;
      if (event.type === 'content_block_start') {
        const block = { ...object(event.content_block) };
        blocks.set(index, block);
        openBlocks.add(index);
        if (block.type === 'text') emit('assistant', string(block.text));
        if (block.type === 'thinking') emit('thinking', string(block.thinking));
        return;
      }

      // 按索引把文字、思考签名和参数片段写回各自的内容块。
      const block = blocks.get(index);
      if (!block) return;
      if (event.type === 'content_block_delta') {
        const delta = object(event.delta);
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          const field = delta.type === 'text_delta' ? 'text' : 'thinking';
          const text = string(delta[field]);
          block[field] = string(block[field]) + text;
          emit(field === 'text' ? 'assistant' : 'thinking', text);
        } else if (delta.type === 'signature_delta') {
          block.signature = string(block.signature) + string(delta.signature);
        } else if (delta.type === 'input_json_delta') {
          partialInput.set(index, (partialInput.get(index) ?? '') + string(delta.partial_json));
        }
      } else if (event.type === 'content_block_stop') {
        // 内容块结束时才解析已收齐的工具参数。
        const json = partialInput.get(index);
        if (json && block.type === 'tool_use') {
          try {
            block.input = JSON.parse(json);
          } catch {
            // Keep the initial input in history so a tool error can be sent back to the model.
            invalidToolInputs.set(block.id, json);
          }
        }
        partialInput.delete(index);
        openBlocks.delete(index);
      }
    },
    finish() {
      if (!stopped || openBlocks.size) throw new Error('Anthropic Messages 的响应未完成');
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);

      // Anthropic 将普通输入、缓存读取和缓存创建的用量分别报告。
      const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = reported;
      const inputTokens = input_tokens === undefined && cache_read_input_tokens === undefined && cache_creation_input_tokens === undefined
        ? undefined : tokens((input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0));
      const reply = anthropicMessages.read({ content, stop_reason: stopReason });

      // 单独恢复非法参数的原始字符串，使该调用能返回错误并保留其他调用。
      const calls = reply.calls.map((call) => {
        const args = invalidToolInputs.get(call.id);
        return args === undefined ? call : { ...call, args, serialized: true };
      });
      return { ...reply, calls, inputTokens, cachedTokens: cache_read_input_tokens, outputTokens: output_tokens };
    },
  };
}

// 将 Ollama 的 NDJSON 消息片段累积为完整回复。
function ollamaStream(emit: EmitDelta): Accumulator {
  const calls: Item[] = [];
  let content = '';
  let thinking = '';
  let completed: Item | undefined;
  let inputTokens: number | undefined;
  return {
    push(event) {
      // 用量可能早于结束帧到达，保存最近一次提供的输入计数。
      inputTokens = tokens(event.prompt_eval_count) ?? inputTokens;
      if (isRecord(event.message)) {
        const text = string(event.message.content);
        const thought = string(event.message.thinking);
        content += text;
        thinking += thought;

        if (thought) emit('thinking', thought);
        if (text) emit('assistant', text);
        if (event.message.tool_calls != null) calls.push(...items(event.message.tool_calls));
      }

      if (event.done === true) {
        completed = event;
        return true;
      }
    },
    finish() {
      return ollamaChat.read({
        ...completed, prompt_eval_count: inputTokens,
        message: { content, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
      });
    },
  };
}

/** 为所选协议创建流式回复累加器。 */
export function streamReply(protocol: Protocol, emit: EmitDelta): Accumulator {
  switch (protocol) {
    case 'OpenAIChatCompletions': return chatStream(emit);
    case 'OpenAIResponses': return responsesStream(emit);
    case 'AnthropicMessages': return anthropicStream(emit);
    case 'OllamaChat': return ollamaStream(emit);
  }
}

/** 解析一个事件并在流结束时通知读取方。 */
export function acceptStreamEvent(stream: Accumulator, data: string): boolean | void {
  if (data === '[DONE]') return true;
  const event = object(JSON.parse(data));
  if (event.type === 'error' || event.error) throw new Error('上游模型报告生成失败');
  return stream.push(event);
}
