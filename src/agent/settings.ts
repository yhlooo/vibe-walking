import { isRecord } from '../level/definition.ts';

/** 关联供应商协议的显示名称及生成代理路径。 */
export const protocols = {
  OpenAIChatCompletions: { label: 'OpenAI Chat Completions', baseURL: 'https://api.openai.com/v1', path: '/llm/proxies/openai/v1/chat/completions' },
  OpenAIResponses: { label: 'OpenAI Responses', baseURL: 'https://api.openai.com/v1', path: '/llm/proxies/openai/v1/responses' },
  AnthropicMessages: { label: 'Anthropic Messages', baseURL: 'https://api.anthropic.com', path: '/llm/proxies/anthropic/v1/messages' },
  OllamaChat: { label: 'Ollama Chat', baseURL: 'http://localhost:11434/api', path: '/llm/proxies/ollama/api/chat' },
};

/** 限制为应用已实现的协议。 */
export type Protocol = keyof typeof protocols;
/** 设置表单使用的初始协议。 */
export const defaultProtocol: Protocol = 'OpenAIResponses';
/** 未指定输入上限时使用的默认值。 */
export const defaultMaxInputToken = 1_000_000;
/** 列出表单可建议的思考强度值。 */
const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const reasoningEffortOptions = [
  { value: '', label: '默认' },
  ...reasoningEfforts.map((value) => ({ value, label: value })),
];

/** 是 Agent 所需的有效连接与模型配置。 */
export type ModelSettings = {
  api: Protocol;
  baseURL: string;
  model: string;
  maxInputToken: number;
  reasoningEffort: string;
  name: string;
};

/** 描述供应商下单个模型的能力及默认参数。 */
export type Model = {
  id: string;
  name?: string;
  maxInputToken: number;
  reasoningEffort?: string;
  vision: boolean;
};

/** 描述模型发现所需的连接信息。 */
export type ModelConnection = { protocol: Protocol; baseURL: string; apiKey?: string };
/** 提交一个供应商及其模型，支持通过旧 ID 保留连接设置。 */
export type ProviderUpdate = ModelConnection & { id: string; name?: string; models: Model[]; previousID?: string };
/** 是服务返回的可公开供应商配置。 */
export type ModelProvider = Omit<ProviderUpdate, 'apiKey' | 'previousID'> & { hasAPIKey: boolean };
/** 包含供应商目录及默认模型 ID。 */
export type ModelCatalog = { defaultModel: string; modelProviders: ModelProvider[] };
/** 组合用户名设置和模型目录。 */
export type Settings = ModelCatalog & { username: string };
/** 只携带此次要更新的设置字段。 */
export type SettingsUpdate = { username?: string; defaultModel?: string; modelProviders?: ProviderUpdate[] };

/** 合并供应商连接和单模型参数，生成 Agent 配置。 */
export function modelSettings(provider: ModelProvider, model: Model): ModelSettings {
  return {
    api: provider.protocol, baseURL: provider.baseURL, model: `${provider.id}/${model.id}`,
    name: model.name || model.id, maxInputToken: model.maxInputToken, reasoningEffort: model.reasoningEffort ?? '',
  };
}

/** 从复合 ID 找到供应商及其模型。 */
export function findModel(catalog: ModelCatalog, id: string): ModelSettings | null {
  const separator = id.indexOf('/');
  if (separator < 0) return null;
  const provider = catalog.modelProviders.find((entry) => entry.id === id.slice(0, separator));
  const model = provider?.models.find((entry) => entry.id === id.slice(separator + 1));
  return provider && model ? modelSettings(provider, model) : null;
}

/** 格式化供界面显示的模型参数摘要。 */
export function formatModelOptions(model: ModelSettings) {
  const tokens = model.maxInputToken;
  const context = tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M`
    : tokens % 1000 === 0 ? `${tokens / 1000}K` : String(tokens);
  return `${model.reasoningEffort.toUpperCase() || '默认'} ${context}`;
}

// 核验设置响应中的单个模型条目。
function isModel(value: unknown): value is Model {
  return isRecord(value) && typeof value.id === 'string' && typeof value.vision === 'boolean' &&
    typeof value.maxInputToken === 'number' && Number.isSafeInteger(value.maxInputToken) && value.maxInputToken > 0 &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string');
}

// 核验供应商配置及其模型列表。
function isProvider(value: unknown): value is ModelProvider {
  return isRecord(value) && typeof value.id === 'string' && typeof value.protocol === 'string' &&
    Object.hasOwn(protocols, value.protocol) && typeof value.baseURL === 'string' &&
    typeof value.hasAPIKey === 'boolean' && (value.name === undefined || typeof value.name === 'string') &&
    Array.isArray(value.models) && value.models.every(isModel);
}

// 检查设置响应的形状并生成前端设置。
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

/** 加载本地服务保存的设置。 */
export async function readSettings(signal?: AbortSignal): Promise<Settings> {
  const response = await fetch('/api/v1/settings', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('无法读取设置');
  return parseSettings(await response.json());
}

// 解码接口响应，并优先使用服务返回的错误说明。
async function readResponse(response: Response, fallback: string): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(value) && value.error;
    throw new Error(isRecord(error) && typeof error.message === 'string' ? error.message : fallback);
  }
  return value;
}

/** 提交部分设置并读取归一化后的配置。 */
export async function saveSettings(update: SettingsUpdate, signal?: AbortSignal): Promise<Settings> {
  const response = await fetch('/api/v1/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update), signal,
  });
  return parseSettings(await readResponse(response, '无法保存设置'));
}

/** 使用尚未保存的连接信息发现模型。 */
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

/** 通过已保存的供应商连接发现模型。 */
export async function discoverProviderModels(providerID: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`/llm/providers/${encodeURIComponent(providerID)}/models`, { cache: 'no-store', signal });
  const value = await readResponse(response, '无法读取模型列表');
  if (isRecord(value) && Array.isArray(value.models) &&
      value.models.every((model) => isRecord(model) && typeof model.id === 'string')) {
    return value.models.map((model) => model.id);
  }
  throw new Error('模型列表格式不正确');
}
