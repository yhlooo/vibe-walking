import { isRecord } from '../level/definition.ts';

export const protocols = {
  OpenAIChatCompletions: { label: 'OpenAI Chat Completions', baseURL: 'https://api.openai.com/v1', path: '/llmproxies/chat/completions' },
  OpenAIResponses: { label: 'OpenAI Responses', baseURL: 'https://api.openai.com/v1', path: '/llmproxies/responses' },
  AnthropicMessages: { label: 'Anthropic Messages', baseURL: 'https://api.anthropic.com/v1', path: '/llmproxies/messages' },
};

export type Protocol = keyof typeof protocols;
export type ModelSettings = { api: Protocol; baseURL: string; model: string; hasAPIKey: boolean };
type Update = Omit<ModelSettings, 'hasAPIKey'> & { apiKey?: string };

function parseSettings(value: unknown): ModelSettings | null {
  if (isRecord(value)) {
    const model = value.model;
    if (model === null) return null;
    if (isRecord(model) && typeof model.api === 'string' && Object.hasOwn(protocols, model.api) &&
        typeof model.baseURL === 'string' && typeof model.model === 'string' && typeof model.hasAPIKey === 'boolean') {
      return { api: model.api as Protocol, baseURL: model.baseURL, model: model.model, hasAPIKey: model.hasAPIKey };
    }
  }
  throw new Error('模型设置响应格式不正确');
}

export async function readSettings(signal?: AbortSignal): Promise<ModelSettings | null> {
  const response = await fetch('/api/v1/settings', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('无法读取模型设置');
  return parseSettings(await response.json());
}

export async function saveSettings(model: Update | null, signal?: AbortSignal): Promise<ModelSettings | null> {
  const response = await fetch('/api/v1/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal,
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(value) && value.error;
    throw new Error(isRecord(error) && typeof error.message === 'string' ? error.message : '无法保存模型设置');
  }
  return parseSettings(value);
}
