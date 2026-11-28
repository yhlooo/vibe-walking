import { isRecord } from '../level/definition.ts';

export const protocols = {
  OpenAIChatCompletions: { label: 'OpenAI Chat Completions', baseURL: 'https://api.openai.com/v1', path: '/llm/proxies/openai/v1/chat/completions' },
  OpenAIResponses: { label: 'OpenAI Responses', baseURL: 'https://api.openai.com/v1', path: '/llm/proxies/openai/v1/responses' },
  AnthropicMessages: { label: 'Anthropic Messages', baseURL: 'https://api.anthropic.com', path: '/llm/proxies/anthropic/v1/messages' },
  OllamaChat: { label: 'Ollama Chat', baseURL: 'http://localhost:11434/api', path: '/llm/proxies/ollama/api/chat' },
};

export type Protocol = keyof typeof protocols;
export const defaultProtocol: Protocol = 'OpenAIResponses';
export const defaultMaxInputToken = 1_000_000;
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'true', 'false'];

export type ModelSettings = {
  api: Protocol;
  baseURL: string;
  model: string;
  maxInputToken: number;
  reasoningEffort: string;
  name: string;
};

export type Model = {
  id: string;
  name?: string;
  maxInputToken: number;
  reasoningEffort?: string;
  vision: boolean;
};

export type ModelConnection = { protocol: Protocol; baseURL: string; apiKey?: string };
export type ProviderUpdate = ModelConnection & { id: string; name?: string; models: Model[]; previousID?: string };
export type ModelProvider = Omit<ProviderUpdate, 'apiKey' | 'previousID'> & { hasAPIKey: boolean };
export type ModelCatalog = { defaultModel: string; modelProviders: ModelProvider[] };
export type Settings = ModelCatalog & { username: string };
export type SettingsUpdate = { username?: string; defaultModel?: string; modelProviders?: ProviderUpdate[] };

export function modelSettings(provider: ModelProvider, model: Model): ModelSettings {
  return {
    api: provider.protocol, baseURL: provider.baseURL, model: `${provider.id}/${model.id}`,
    name: model.name || model.id, maxInputToken: model.maxInputToken, reasoningEffort: model.reasoningEffort ?? '',
  };
}

export function findModel(catalog: ModelCatalog, id: string): ModelSettings | null {
  const separator = id.indexOf('/');
  if (separator < 0) return null;
  const provider = catalog.modelProviders.find((entry) => entry.id === id.slice(0, separator));
  const model = provider?.models.find((entry) => entry.id === id.slice(separator + 1));
  return provider && model ? modelSettings(provider, model) : null;
}

export function formatModelOptions(model: ModelSettings) {
  const tokens = model.maxInputToken;
  const context = tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}m`
    : tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
  return `[${model.reasoningEffort || '默认'}, ${context}]`;
}

function isModel(value: unknown): value is Model {
  return isRecord(value) && typeof value.id === 'string' && typeof value.vision === 'boolean' &&
    typeof value.maxInputToken === 'number' && Number.isSafeInteger(value.maxInputToken) && value.maxInputToken > 0 &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string');
}

function isProvider(value: unknown): value is ModelProvider {
  return isRecord(value) && typeof value.id === 'string' && typeof value.protocol === 'string' &&
    Object.hasOwn(protocols, value.protocol) && typeof value.baseURL === 'string' &&
    typeof value.hasAPIKey === 'boolean' && (value.name === undefined || typeof value.name === 'string') &&
    Array.isArray(value.models) && value.models.every(isModel);
}

function parseSettings(value: unknown): Settings {
  if (isRecord(value)) {
    const modelProviders = value.modelProviders ?? [];
    if (Array.isArray(modelProviders) && modelProviders.every(isProvider)) {
      return {
        username: typeof value.username === 'string' ? value.username : '',
        defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel : '',
        modelProviders,
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

async function readResponse(response: Response, fallback: string): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(value) && value.error;
    throw new Error(isRecord(error) && typeof error.message === 'string' ? error.message : fallback);
  }
  return value;
}

export async function saveSettings(update: SettingsUpdate, signal?: AbortSignal): Promise<Settings> {
  const response = await fetch('/api/v1/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update), signal,
  });
  return parseSettings(await readResponse(response, '无法保存设置'));
}

export async function listModels(connection: ModelConnection, signal: AbortSignal, providerID?: string): Promise<string[]> {
  const response = await fetch('/llm/providers/models', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...connection, providerID }), signal,
  });
  const value = await readResponse(response, '无法读取模型列表');
  if (isRecord(value) && Array.isArray(value.models) && value.models.every((id) => typeof id === 'string')) {
    return value.models;
  }
  throw new Error('模型列表格式不正确');
}

export async function discoverProviderModels(providerID: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`/llm/providers/${encodeURIComponent(providerID)}/models`, { cache: 'no-store', signal });
  const value = await readResponse(response, '无法读取模型列表');
  if (isRecord(value) && Array.isArray(value.models) &&
      value.models.every((model) => isRecord(model) && typeof model.id === 'string')) {
    return value.models.map((model) => model.id);
  }
  throw new Error('模型列表格式不正确');
}
