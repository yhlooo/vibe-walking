import { isRecord } from '../level/definition.ts';

export const protocols = {
  OpenAIChatCompletions: { label: 'OpenAI Chat Completions', baseURL: 'https://api.openai.com/v1', path: '/llmproxies/chat/completions' },
  OpenAIResponses: { label: 'OpenAI Responses', baseURL: 'https://api.openai.com/v1', path: '/llmproxies/responses' },
  AnthropicMessages: { label: 'Anthropic Messages', baseURL: 'https://api.anthropic.com/v1', path: '/llmproxies/messages' },
};

export type Protocol = keyof typeof protocols;
export const defaultMaxInputToken = 1_000_000;
export type ModelSettings = {
  api: Protocol;
  baseURL: string;
  model: string;
  hasAPIKey: boolean;
  maxInputToken: number;
  reasoningEffort: string;
};
type Settings = { username: string; model: ModelSettings | null };
type ModelUpdate = Omit<ModelSettings, 'hasAPIKey'> & { apiKey?: string };
export type SettingsUpdate = { username?: string; model?: ModelUpdate | null };

function parseSettings(value: unknown): Settings {
  if (isRecord(value)) {
    const model = value.model;
    const username = typeof value.username === 'string' ? value.username : '';
    if (model === null) return { username, model };
    if (isRecord(model) && typeof model.api === 'string' && Object.hasOwn(protocols, model.api) &&
        typeof model.baseURL === 'string' && typeof model.model === 'string' && typeof model.hasAPIKey === 'boolean') {
      return {
        username,
        model: {
          api: model.api as Protocol, baseURL: model.baseURL, model: model.model, hasAPIKey: model.hasAPIKey,
          maxInputToken: typeof model.maxInputToken === 'number' ? model.maxInputToken : defaultMaxInputToken,
          reasoningEffort: typeof model.reasoningEffort === 'string' ? model.reasoningEffort : '',
        },
      };
    }
  }
  throw new Error('设置响应格式不正确');
}

export async function readSettings(signal?: AbortSignal): Promise<Settings> {
  const response = await fetch('/api/v1/settings', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('无法读取设置');
  return parseSettings(await response.json());
}

export async function saveSettings(update: SettingsUpdate, signal?: AbortSignal): Promise<Settings> {
  const response = await fetch('/api/v1/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update), signal,
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(value) && value.error;
    throw new Error(isRecord(error) && typeof error.message === 'string' ? error.message : '无法保存设置');
  }
  return parseSettings(value);
}
