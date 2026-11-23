import { compileActions } from '../game/actions.ts';
import { isRecord } from '../level/definition.ts';
import { contextToSummarize, estimateContext } from './context.ts';
import type { ContextUsage } from './context.ts';
import { acceptStreamEvent, adapters, streamReply } from './protocols.ts';
import type { OutputKind, ToolCall, ToolResult } from './protocols.ts';
import {
  compressionInput, compressionPrompt, execActionSequenceTool, interruptionInfo, modelErrorMessages, personalizePrompt,
  readScreenTool, summarizedHistoryPrompt, thinkingContext, toolMessages,
} from './prompts.ts';
import { defaultMaxInputToken, protocols } from './settings.ts';
import type { ModelSettings, Protocol } from './settings.ts';
import { readModelStream } from './stream.ts';
import type { Outcome, StepInput } from '../game/world.ts';

function userContent(text: string, systemInfo?: string) {
  return systemInfo ? `${systemInfo}\n${text}` : text;
}

export type ChatEvent =
  | { kind: 'player'; text: string; systemInfo?: string; hidden?: boolean }
  | { kind: OutputKind | 'error'; text: string }
  | { kind: 'tool'; text: string; detail?: string; image?: string };

export type Conversation = {
  events: ChatEvent[];
  history: Record<string, unknown>[];
  protocol?: Protocol;
  pendingSystemInfo?: string;
  interrupted?: boolean;
  usage?: ContextUsage;
  summary?: Record<string, unknown>;
};

type GameTools = {
  isReadScreenDisabled?: () => boolean;
  readScreen: (disabled: boolean) => string;
  execute: (steps: StepInput[], signal: AbortSignal) => Promise<void>;
  whenActive: (signal: AbortSignal) => Promise<void>;
  outcome: () => Outcome;
};

export class Agent {
  private readonly model: ModelSettings;
  private readonly prompt: string;
  private readonly tools: GameTools;
  private readonly onEvent: (event: ChatEvent) => void;
  private readonly conversation: Conversation;
  private readonly username: string;
  private turn?: AbortController;
  private disposed = false;
  busy = false;

  constructor(model: ModelSettings, prompt: string, tools: GameTools, emit: (event: ChatEvent) => void,
    conversation: Conversation = { events: [], history: [] }, username = '') {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.onEvent = emit;
    this.conversation = conversation;
    this.username = username;
  }

  dispose() {
    this.disposed = true;
    this.turn?.abort();
  }

  interrupt() {
    if (!this.turn || this.turn.signal.aborted) return;
    this.conversation.interrupted = true;
    this.turn.abort();
  }

  async send(text: string, prompt = this.prompt, { hidden = false } = {}) {
    if (this.busy || this.disposed) return;
    const turn = this.turn = new AbortController();
    const { signal } = turn;
    this.busy = true;
    const protocol = this.model.api;
    const adapter = adapters[protocol];
    const conversation = this.conversation;
    if (conversation.protocol && conversation.protocol !== protocol) {
      conversation.history = conversation.events.flatMap((event) => {
        if (event.kind === 'player') return [{ role: 'user', content: userContent(event.text, event.systemInfo) }];
        if (event.kind === 'assistant') return [{ role: 'assistant', content: event.text }];
        if (event.kind === 'thinking') return [{ role: 'assistant', content: thinkingContext(event.text) }];
        return [];
      });
      delete conversation.usage;
    }
    conversation.protocol = protocol;
    const { history } = conversation;
    prompt = personalizePrompt(prompt, this.username);
    const systemInfo = [
      conversation.pendingSystemInfo && personalizePrompt(conversation.pendingSystemInfo, this.username),
      conversation.interrupted && personalizePrompt(interruptionInfo, this.username),
    ].filter(Boolean).join('\n');
    delete conversation.pendingSystemInfo;
    delete conversation.interrupted;
    const userMessage = { role: 'user', content: userContent(text, systemInfo) };
    history.push(userMessage);
    this.emit({ kind: 'player', text, ...(systemInfo ? { systemInfo } : {}), ...(hidden ? { hidden } : {}) });

    let output: ChatEvent[] = [];
    let completedTool: { history: Record<string, unknown>[]; call: ToolCall } | undefined;
    const retainOutput = () => {
      if (completedTool) {
        history.push(...completedTool.history, ...adapter.result(completedTool.call, { text: toolMessages.interrupted, error: true }));
      } else {
        const content = output.map((event) => event.kind === 'thinking' ? thinkingContext(event.text) : event.text).join('\n');
        if (content) history.push({ role: 'assistant', content });
      }
      output = [];
      completedTool = undefined;
    };
    signal.addEventListener('abort', retainOutput, { once: true });

    const onDelta = (kind: OutputKind, delta: string) => {
      if (!delta) return;
      const current = output.at(-1);
      if (current?.kind === kind) {
        current.text += delta;
        this.onEvent(current);
      } else {
        const event = { kind, text: delta };
        output.push(event);
        this.emit(event);
      }
    };

    const threshold = this.model.maxInputToken ?? defaultMaxInputToken;
    const usageKey = JSON.stringify([protocol, this.model.baseURL, this.model.model, this.model.reasoningEffort, prompt]);
    let compressionFailed = false;
    try {
      while (true) {
        await this.tools.whenActive(signal);
        signal.throwIfAborted();
        let estimate = estimateContext(prompt, history);
        const usage = conversation.usage;
        const inputTokens = usage?.key === usageKey ? usage.tokens + estimate - usage.estimate : estimate;
        const currentIndex = history.indexOf(userMessage);
        const hasPriorTurns = currentIndex > 0 && !(currentIndex === 1 && history[0] === conversation.summary);
        const hasToolHistory = currentIndex < history.length - 1;
        if (!compressionFailed && inputTokens >= threshold && (hasPriorTurns || hasToolHistory)) {
          const prefix = hasPriorTurns ? history.slice(0, currentIndex) : history;
          try {
            const summary = await this.compress(prefix, threshold, signal);
            signal.throwIfAborted();
            const entry = { role: 'user', content: summarizedHistoryPrompt(summary) };
            if (hasPriorTurns) history.splice(0, currentIndex, entry);
            else history.splice(0, history.length, entry, userMessage);
            conversation.summary = entry;
            delete conversation.usage;
            estimate = estimateContext(prompt, history);
          } catch (error) {
            signal.throwIfAborted();
            compressionFailed = true;
            this.emit({ kind: 'error', text: `无法压缩对话上下文：${message(error)}` });
          }
        }
        const reply = await this.generate(prompt, history, true, signal, onDelta);
        signal.throwIfAborted();
        if (reply.inputTokens) conversation.usage = { key: usageKey, estimate, tokens: reply.inputTokens };
        if (!output.some((event) => event.kind === 'assistant')) onDelta('assistant', reply.text);
        if (!reply.call) {
          history.push(...reply.history);
          output = [];
          return;
        }
        completedTool = { history: reply.history, call: reply.call };
        await this.tools.whenActive(signal);
        signal.throwIfAborted();
        const toolResult = await this.runTool(reply.call, signal);
        signal.throwIfAborted();
        history.push(...reply.history, ...adapter.result(reply.call, toolResult));
        completedTool = undefined;
        output = [];
      }
    } catch (error) {
      if (!signal.aborted) {
        retainOutput();
        this.emit({ kind: 'error', text: message(error) });
      }
    } finally {
      signal.removeEventListener('abort', retainOutput);
      this.turn = undefined;
      this.busy = false;
    }
  }

  private async compress(history: Record<string, unknown>[], threshold: number, signal: AbortSignal) {
    const instruction = personalizePrompt(compressionPrompt, this.username);
    const transcript = Array.from(contextToSummarize(history));
    const chunkSize = Math.max(1000, Math.min(24000, Math.floor(threshold / 2)));
    let summary = '';
    for (let start = 0; start < transcript.length; start += chunkSize) {
      const chunk = transcript.slice(start, start + chunkSize).join('');
      const reply = await this.generate(instruction, [{
        role: 'user', content: compressionInput(summary, chunk),
      }], false, signal, () => {});
      if (!reply.text.trim()) throw new Error('模型未返回摘要');
      summary = reply.text.trim();
    }
    return summary;
  }

  private async generate(
    prompt: string, history: Record<string, unknown>[], includeTools: boolean,
    signal: AbortSignal, emit: (kind: OutputKind, text: string) => void,
  ) {
    signal.throwIfAborted();
    const protocol = this.model.api;
    const body = adapters[protocol].request(this.model, prompt, history, includeTools, this.tools.isReadScreenDisabled?.());
    const idle = new AbortController();
    const requestSignal = AbortSignal.any([signal, idle.signal]);
    let timer: ReturnType<typeof setTimeout>;
    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException(modelErrorMessages.timeout, 'TimeoutError')), 65000);
    }
    resetTimer();
    try {
      const response = await fetch(protocols[protocol].path, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: requestSignal,
      });
      if (requestSignal.aborted) {
        void response.body?.cancel().catch(() => {});
        requestSignal.throwIfAborted();
      }
      if (!response.ok) throw new Error(await proxyError(response));
      const stream = streamReply(protocol, emit);
      resetTimer();
      await readModelStream(response, (data) => acceptStreamEvent(stream, data), requestSignal, resetTimer, protocol === 'OllamaChat');
      return stream.finish();
    } catch (error) {
      requestSignal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }

  private emit(event: ChatEvent) {
    this.conversation.events.push(event);
    this.onEvent(event);
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== readScreenTool && call.name !== execActionSequenceTool) {
      const detail = typeof call.args === 'string' && call.serialized ? call.args : JSON.stringify(call.args, null, 2);
      this.emit({ kind: 'tool', text: '不支持的行动', detail: detail ?? '未提供参数' });
      return { text: toolMessages.notFound, error: true };
    }

    let actionDetail: string | undefined;
    let actionEvent: ChatEvent | undefined;
    try {
      const args: unknown = call.serialized ? JSON.parse(typeof call.args === 'string' ? call.args : '') : call.args;
      if (call.name === readScreenTool) {
        if (!isRecord(args) || Object.keys(args).length) throw new Error(toolMessages.invalidReadScreenArgs);
        const image = this.tools.readScreen(this.tools.isReadScreenDisabled?.() ?? false);
        this.emit({ kind: 'tool', text: '看了一眼', image });
        return { text: toolMessages.ok, image };
      }

      actionDetail = describeActions(args);
      if (this.tools.outcome() !== 'active') throw new Error(toolMessages.levelEnded);
      const steps = compileActions(args);
      actionEvent = { kind: 'tool', text: '执行动作', detail: actionDetail };
      this.emit(actionEvent);
      await this.tools.execute(steps, signal);
      signal.throwIfAborted();
      return { text: toolMessages.ok };
    } catch (error) {
      signal.throwIfAborted();
      const text = error instanceof SyntaxError ? toolMessages.invalidJSON : message(error);
      if (actionEvent) {
        actionEvent.text = '执行动作失败';
        this.onEvent(actionEvent);
      } else if (call.name === execActionSequenceTool) {
        this.emit({ kind: 'tool', text: '执行动作失败', detail: actionDetail ?? text });
      } else {
        this.emit({ kind: 'tool', text: '查看画面失败', detail: text });
      }
      return { text: toolMessages.error(text), error: true };
    }
  }
}

function describeActions(args: unknown): string | undefined {
  if (!isRecord(args) || !Array.isArray(args.actions) || !args.actions.length) return;
  return args.actions.map((action: unknown) => {
    if (!isRecord(action)) return '无法识别的动作';
    const { key, value, hold } = action;
    switch (key) {
      case 'jump': return '跳起';
      case 'moveLeft':
      case 'moveRight': {
        const direction = key === 'moveLeft' ? '向左' : '向右';
        if (typeof hold === 'number') return `按住${direction} ${hold}s`;
        return typeof value === 'number' ? `${direction}移动 ${value}` : `${direction}移动（距离无效）`;
      }
      case 'sleep': return typeof value === 'number' ? `等待 ${value}s` : '等待（时长无效）';
      default: return '无法识别的动作';
    }
  }).join('\n');
}

function message(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return modelErrorMessages.timeout;
  if (error instanceof TypeError) return modelErrorMessages.connection;
  return error instanceof Error ? error.message : modelErrorMessages.failed;
}

async function proxyError(response: Response): Promise<string> {
  const value: unknown = await response.json().catch(() => undefined);
  const code = isRecord(value) && isRecord(value.error) ? value.error.code : undefined;
  if (code === 'model_not_configured') return '请先配置模型连接';
  if (code === 'proxy_not_enabled') return '模型协议已切换，请重新打开模型连接';
  if (response.status === 401 || response.status === 403) return '模型鉴权失败，请检查 API Key 和访问权限';
  if (response.status === 404) return '模型接口或模型 ID 不存在';
  if (response.status === 429) return '模型接口已限流或额度不足';
  if (response.status === 502) return '无法连接上游模型接口';
  if (response.status === 504) return '上游模型请求超时';
  if (response.status === 400 || response.status === 422) return '上游未接受模型请求，请检查模型支持的思考长度、截图和工具调用';
  return `模型请求失败（HTTP ${response.status}）`;
}
