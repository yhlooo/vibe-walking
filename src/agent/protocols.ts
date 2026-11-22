import { isRecord } from '../level/definition.ts';
import type { ModelSettings, Protocol } from './settings.ts';

type Item = Record<string, unknown>;
export type ToolCall = { id: string; name: string; args: unknown; serialized: boolean };
export type ToolResult = { text: string; image?: string; error?: boolean };
export type Reply = { history: Item[]; text: string; call?: ToolCall; inputTokens?: number };
export type OutputKind = 'assistant' | 'thinking';
type EmitDelta = (kind: OutputKind, text: string) => void;
type Accumulator = { push(event: Item): boolean | void; finish(): Reply };

type Adapter = {
  request(settings: ModelSettings, prompt: string, history: Item[], tools: 'auto' | 'none' | 'omit'): Item;
  read(value: unknown): Reply;
  result(call: ToolCall, value: ToolResult): Item[];
};

const functions = [
  {
    name: 'ReadScreen', description: '观察包含角色、地形和红色按钮的完整游戏画面。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ExecActionSequence',
    description: '按顺序执行动作。moveLeft、moveRight 的 value 是格数（0.01～24），sleep 的 value 是秒数（0.001～10），jump 可省略 value。一次最多 32 个动作、30 秒。',
    parameters: {
      type: 'object', required: ['actions'], additionalProperties: false,
      properties: {
        actions: {
          type: 'array', minItems: 1, maxItems: 32,
          items: {
            type: 'object', required: ['key'], additionalProperties: false,
            properties: { key: { type: 'string', enum: ['jump', 'moveLeft', 'moveRight', 'sleep'] }, value: { type: 'number' } },
          },
        },
      },
    },
  },
];

const openAIFunctions = functions.map((tool) => ({ ...tool, strict: false }));

function object(value: unknown): Item {
  if (!isRecord(value)) throw new Error('模型响应格式不正确');
  return value;
}

function items(value: unknown): Item[] {
  if (!Array.isArray(value)) throw new Error('模型响应缺少预期的消息');
  return value.map(object);
}

function tool(id: unknown, name: unknown, args: unknown, serialized: boolean): ToolCall {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) {
    throw new Error('模型返回的工具调用缺少名称或 ID');
  }
  return { id, name, args, serialized };
}

function onlyCall(calls: Item[]): Item | undefined {
  if (calls.length > 1) throw new Error('模型在一次响应中发起了多个工具调用');
  return calls[0];
}

function textBlocks(value: unknown, type: string): string {
  return items(value).flatMap((block) => block.type === type && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

const chatCompletions: Adapter = {
  request(settings, prompt, history, tools) {
    return {
      model: settings.model, messages: [{ role: 'developer', content: prompt }, ...history], stream: true,
      stream_options: { include_usage: true },
      ...(effort(settings) ? { reasoning_effort: effort(settings) } : {}),
      ...(tools !== 'omit' ? {
        tools: openAIFunctions.map((definition) => ({ type: 'function', function: definition })),
        parallel_tool_calls: false, tool_choice: tools,
      } : {}),
    };
  },
  read(value) {
    const choice = object(items(object(value).choices)[0]);
    if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') {
      throw new Error('Chat Completions 的响应未完成');
    }
    const message = object(choice.message);
    const calls = message.tool_calls === undefined || message.tool_calls === null ? [] : items(message.tool_calls);
    const call = onlyCall(calls);
    if (Boolean(call) !== (choice.finish_reason === 'tool_calls')) throw new Error('Chat Completions 的工具调用不完整');
    const invocation = call && object(call.function);
    const text = typeof message.content === 'string' ? message.content : typeof message.refusal === 'string' ? message.refusal : '';
    const history = [{
      role: 'assistant', content: message.content ?? (call ? null : text),
      ...(call ? { tool_calls: calls } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    }];
    return { history, text, call: call && invocation ? tool(call.id, invocation.name, invocation.arguments, true) : undefined };
  },
  result(call, result) {
    const history: Item[] = [{ role: 'tool', tool_call_id: call.id, content: result.text }];
    if (result.image) {
      history.push({ role: 'user', content: [
        { type: 'text', text: '这是刚才 ReadScreen 工具返回的游戏画面。' },
        { type: 'image_url', image_url: { url: result.image, detail: 'auto' } },
      ] });
    }
    return history;
  },
};

const responses: Adapter = {
  request(settings, instructions, input, tools) {
    const level = effort(settings);
    const summary = level !== 'none' && (level || /^(?:o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(settings.model));
    return {
      model: settings.model, instructions, input, store: false, stream: true,
      include: ['reasoning.encrypted_content'],
      ...(summary || level ? { reasoning: { ...(summary ? { summary: 'auto' } : {}), ...(level ? { effort: level } : {}) } } : {}),
      ...(tools !== 'omit' ? {
        parallel_tool_calls: false, tools: openAIFunctions.map((definition) => ({ type: 'function', ...definition })),
        tool_choice: tools,
      } : {}),
    };
  },
  read(value) {
    const response = object(value);
    if (response.status !== 'completed') throw new Error('Responses 的响应未完成');
    const history = items(response.output);
    const invocation = onlyCall(history.filter((item) => item.type === 'function_call'));
    const text = history.flatMap((item) => {
      if (item.type !== 'message') return [];
      return items(item.content).flatMap((block) => {
        if (block.type === 'output_text' && typeof block.text === 'string') return [block.text];
        if (block.type === 'refusal' && typeof block.refusal === 'string') return [block.refusal];
        return [];
      });
    }).join('\n');
    return { history, text, call: invocation && tool(invocation.call_id, invocation.name, invocation.arguments, true) };
  },
  result(call, result) {
    return [{
      type: 'function_call_output', call_id: call.id,
      output: result.image ? [{ type: 'input_image', image_url: result.image, detail: 'auto' }] : result.text,
    }];
  },
};

const anthropicMessages: Adapter = {
  request(settings, system, messages, tools) {
    const level = effort(settings);
    const officialEndpoint = /^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(settings.baseURL);
    const adaptive = (level && !officialEndpoint) ||
      /^(?:claude-(?:opus|sonnet)-4-[6-9]|claude-(?:opus|sonnet|haiku)-[5-9])(?:-|$)/.test(settings.model);
    return {
      model: settings.model, system, messages, max_tokens: adaptive ? 16384 : 4096, stream: true,
      ...(adaptive ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(level ? { output_config: { effort: level } } : {}),
      ...(tools !== 'omit' ? {
        tools: functions.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })),
        tool_choice: tools === 'auto' ? { type: 'auto', disable_parallel_tool_use: true } : { type: 'none' },
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
    const invocation = onlyCall(content.filter((item) => item.type === 'tool_use'));
    if (Boolean(invocation) !== (reason === 'tool_use')) throw new Error('Anthropic Messages 的工具调用不完整');
    return {
      history: [{ role: 'assistant', content }], text: textBlocks(content, 'text'),
      call: invocation && tool(invocation.id, invocation.name, invocation.input, false),
    };
  },
  result(call, result) {
    const content = result.image ? [{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.image.slice('data:image/png;base64,'.length) },
    }] : result.text;
    return [{ role: 'user', content: [{
      type: 'tool_result', tool_use_id: call.id, content,
      ...(result.error ? { is_error: true } : {}),
    }] }];
  },
};

export const adapters: Record<Protocol, Adapter> = {
  OpenAIChatCompletions: chatCompletions,
  OpenAIResponses: responses,
  AnthropicMessages: anthropicMessages,
};

function effort(settings: ModelSettings) {
  if (settings.reasoningEffort === 'ultra' &&
      /^https:\/\/api\.(?:openai|anthropic)\.com(?:\/|$)/i.test(settings.baseURL)) return 'max';
  return settings.reasoningEffort;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function chatStream(emit: EmitDelta): Accumulator {
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let finishReason: unknown;
  let content = '';
  let refusal = '';
  let reasoning = '';
  let inputTokens: number | undefined;
  return {
    push(event) {
      if (isRecord(event.usage)) inputTokens = tokens(event.usage.prompt_tokens) ?? inputTokens;
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
      const message = {
        content: content || null, refusal, reasoning_content: reasoning, tool_calls: [...calls.values()],
      };
      return { ...chatCompletions.read({ choices: [{ message, finish_reason: finishReason }] }), inputTokens };
    },
  };
}

function responsesStream(emit: EmitDelta): Accumulator {
  let response: Item | undefined;
  return {
    push(event) {
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        emit('assistant', string(event.delta));
      } else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
        emit('thinking', string(event.delta));
      } else if (event.type === 'response.completed') {
        response = object(event.response);
        return true;
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        throw new Error('Responses 的响应未完成');
      }
    },
    finish() {
      const reply = responses.read(response);
      const usage = response?.usage;
      return { ...reply, inputTokens: isRecord(usage) ? tokens(usage.input_tokens) : undefined };
    },
  };
}

function anthropicStream(emit: EmitDelta): Accumulator {
  const blocks = new Map<number, Item>();
  const openBlocks = new Set<number>();
  const partialInput = new Map<number, string>();
  const inputFields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  const reported = new Map<string, number>();
  let stopReason: unknown;
  let stopped = false;
  return {
    push(event) {
      const usage = (isRecord(event.message) ? event.message : event).usage;
      if (isRecord(usage)) {
        for (const field of inputFields) {
          const count = usage[field];
          if (typeof count === 'number') reported.set(field, count);
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
        const json = partialInput.get(index);
        if (json) block.input = JSON.parse(json);
        partialInput.delete(index);
        openBlocks.delete(index);
      }
    },
    finish() {
      if (!stopped || openBlocks.size) throw new Error('Anthropic Messages 的响应未完成');
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
      const inputTokens = tokens([...reported.values()].reduce((sum, count) => sum + count, 0));
      return { ...anthropicMessages.read({ content, stop_reason: stopReason }), inputTokens };
    },
  };
}

export function streamReply(protocol: Protocol, emit: EmitDelta): Accumulator {
  switch (protocol) {
    case 'OpenAIChatCompletions': return chatStream(emit);
    case 'OpenAIResponses': return responsesStream(emit);
    case 'AnthropicMessages': return anthropicStream(emit);
  }
}

export function acceptStreamEvent(stream: Accumulator, data: string): boolean | void {
  if (data === '[DONE]') return true;
  const event = object(JSON.parse(data));
  if (event.type === 'error' || event.error) throw new Error('上游模型报告生成失败');
  return stream.push(event);
}
