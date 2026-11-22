import { isRecord } from '../level/definition.ts';
import type { Protocol } from './settings.ts';

type Item = Record<string, unknown>;
export type ToolCall = { id: string; name: string; args: unknown; serialized: boolean };
export type ToolResult = { text: string; image?: string; error?: boolean };
type Reply = { history: Item[]; text: string; call?: ToolCall };

type Adapter = {
  request(model: string, prompt: string, history: Item[], toolsEnabled: boolean): Item;
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
  request(model, prompt, history, toolsEnabled) {
    return {
      model, messages: [{ role: 'developer', content: prompt }, ...history], stream: false,
      tools: openAIFunctions.map((definition) => ({ type: 'function', function: definition })),
      parallel_tool_calls: false, tool_choice: toolsEnabled ? 'auto' : 'none',
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
  request(model, instructions, input, toolsEnabled) {
    return {
      model, instructions, input, store: false, stream: false, parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
      tools: openAIFunctions.map((definition) => ({ type: 'function', ...definition })),
      tool_choice: toolsEnabled ? 'auto' : 'none',
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
  request(model, system, messages, toolsEnabled) {
    return {
      model, system, messages, max_tokens: 4096, stream: false,
      tools: functions.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })),
      tool_choice: toolsEnabled ? { type: 'auto', disable_parallel_tool_use: true } : { type: 'none' },
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
