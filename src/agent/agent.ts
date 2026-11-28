import { compileActions } from '../game/actions.ts';
import { isRecord } from '../level/definition.ts';
import { contextToSummarize, estimateContext } from './context.ts';
import type { ContextUsage } from './context.ts';
import { acceptStreamEvent, adapters, streamReply } from './protocols.ts';
import type { OutputKind, Reply, ToolCall, ToolResult } from './protocols.ts';
import {
  compressionInput, compressionPrompt, execActionSequenceTool, interruptionInfo, modelErrorMessages, personalizePrompt,
  readScreenTool, summarizedHistoryPrompt, thinkingContext, toolMessages,
} from './prompts.ts';
import { defaultMaxInputToken, protocols } from './settings.ts';
import type { ModelSettings, Protocol } from './settings.ts';
import { readModelStream } from './stream.ts';
import type { Outcome, StepInput } from '../game/world.ts';

// 将待发的系统事件和玩家消息拼成模型输入。
function userContent(text: string, systemInfo?: string) {
  return systemInfo ? `${systemInfo}\n${text}` : text;
}

/** 定义供聊天记录展示和回放的事件。 */
export type ChatEvent =
  | { kind: 'player'; text: string; systemInfo?: string; hidden?: boolean }
  | { kind: OutputKind | 'error'; text: string }
  | { kind: 'tool'; text: string; detail?: string; image?: string };

/** 保存跨 Agent 实例共享的可见事件与协议历史。 */
export type Conversation = {
  events: ChatEvent[];
  // 保留当前协议的原生消息项及工具往返记录。
  history: Record<string, unknown>[];
  protocol?: Protocol;
  modelSource?: string;
  // 暂存应附在下一条玩家消息前的系统事件。
  pendingSystemInfo?: string;
  interrupted?: boolean;
  // 保存最近一次可用于校准本地估算的上游输入用量。
  usage?: ContextUsage;
  summary?: Record<string, unknown>;
};

/** 汇总游玩界面调试面板所需的模型请求指标。 */
export type RequestStats = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  // 仅累计供应商提供缓存明细的请求输入，用作缓存命中率分母。
  inputTokensWithCacheData: number;
  lastCacheRatio?: number;
  lastOutputRate?: number;
};

// 绑定累计用量与界面更新通知。
type RequestTracker = { stats: RequestStats; onChange: () => void };

/** 创建一组新的请求统计计数器。 */
export function emptyRequestStats(): RequestStats {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, inputTokensWithCacheData: 0 };
}

// 定义 Agent 执行游戏工具所需的运行时能力。
type GameTools = {
  isReadScreenDisabled?: () => boolean;
  readScreen: (disabled: boolean) => string;
  execute: (steps: StepInput[], signal: AbortSignal) => Promise<void>;
  whenActive: (signal: AbortSignal) => Promise<void>;
  outcome: () => Outcome;
};

/** 管理一轮玩家对话、模型流式生成和游戏工具执行。 */
export class Agent {
  private readonly model: ModelSettings;
  private readonly prompt: string;
  private readonly tools: GameTools;
  private readonly onEvent: (event: ChatEvent) => void;
  private readonly conversation: Conversation;
  private readonly username: string;
  private readonly requestTracker?: RequestTracker;
  private turn?: AbortController;
  private disposed = false;
  busy = false;

  // 绑定当前模型、共享对话和关卡运行时。
  constructor(model: ModelSettings, prompt: string, tools: GameTools, emit: (event: ChatEvent) => void,
    conversation: Conversation = { events: [], history: [] }, username = '', requestTracker?: RequestTracker) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.onEvent = emit;
    this.conversation = conversation;
    this.username = username;
    this.requestTracker = requestTracker;
  }

  // 释放实例并终止当前对话。
  dispose() {
    this.disposed = true;
    this.turn?.abort();
  }

  // 中断玩家当前回合，留待下一条指示说明中断。
  interrupt() {
    if (!this.turn || this.turn.signal.aborted) return;
    this.conversation.interrupted = true;
    this.turn.abort();
  }

  // 提交玩家指示并反复生成回复和执行工具，直到模型停止调用。
  async send(text: string, prompt = this.prompt, { hidden = false } = {}) {
    if (this.busy || this.disposed) return;

    const turn = this.turn = new AbortController();
    const { signal } = turn;
    this.busy = true;
    const protocol = this.model.api;
    const adapter = adapters[protocol];
    const conversation = this.conversation;

    // 切换协议或模型来源时，从聊天事件重建可移植的消息历史。
    const modelSource = JSON.stringify([this.model.baseURL, this.model.model]);
    if ((conversation.protocol && conversation.protocol !== protocol) ||
        (conversation.modelSource && conversation.modelSource !== modelSource)) {
      // 从聊天事件保留可跨协议的玩家文字、答复和思考，舍弃原协议的工具结构。
      conversation.history = conversation.events.flatMap((event) => {
        if (event.kind === 'player') return [{ role: 'user', content: userContent(event.text, event.systemInfo) }];
        if (event.kind === 'assistant') return [{ role: 'assistant', content: event.text }];
        if (event.kind === 'thinking') return [{ role: 'assistant', content: thinkingContext(event.text) }];
        return [];
      });
      delete conversation.usage;
      delete conversation.summary;
    }

    conversation.protocol = protocol;
    conversation.modelSource = modelSource;
    const { history } = conversation;
    prompt = personalizePrompt(prompt, this.username);

    // 仅在下一次发言带上待处理的关卡事件和中断说明。
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
    let pendingTools: { reply: Reply; results: ToolResult[]; running: boolean } | undefined;

    // 保留流式输出和已完成工具结果，并为中断的调用补齐对应结果。
    const retainOutput = () => {
      if (pendingTools) {
        const { reply, results, running } = pendingTools;

        // 已有结果原样入历史，余下调用按是否正在执行填入中断或未执行结果。
        const completed = reply.calls.map((call, index) => ({
          call,
          result: results[index] ?? {
            text: running && index === results.length ? toolMessages.interrupted : toolMessages.notExecuted,
            error: true,
          },
        }));
        history.push(...reply.history, ...adapter.results(completed));
      } else {
        const content = output.map((event) => event.kind === 'thinking' ? thinkingContext(event.text) : event.text).join('\n');
        if (content) history.push({ role: 'assistant', content });
      }
      output = [];
      pendingTools = undefined;
    };
    signal.addEventListener('abort', retainOutput, { once: true });

    // 原地更新同一类连续输出，让界面复用消息节点。
    const onDelta = (kind: OutputKind, delta: string) => {
      if (!delta) return;

      // 仅合并相邻同类增量，中途插入思考或答复时另开事件。
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

    // 用最近一次匹配的上游用量校准上下文估算。
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

        // 用当前指令在历史中的位置区分旧回合和本轮产生的工具往返。
        const currentIndex = history.indexOf(userMessage);
        const hasPriorTurns = currentIndex > 0 && !(currentIndex === 1 && history[0] === conversation.summary);
        const hasToolHistory = currentIndex < history.length - 1;

        if (!compressionFailed && inputTokens >= threshold && (hasPriorTurns || hasToolHistory)) {
          // 优先压缩旧消息，保留本轮玩家原始指示。
          const prefix = hasPriorTurns ? history.slice(0, currentIndex) : history;
          try {
            const summary = await this.compress(prefix, threshold, signal);
            signal.throwIfAborted();
            const entry = { role: 'user', content: summarizedHistoryPrompt(summary) };

            // 更新历史时用摘要替代旧内容，并保留原始用户消息对象。
            if (hasPriorTurns) history.splice(0, currentIndex, entry);
            else history.splice(0, history.length, entry, userMessage);
            conversation.summary = entry;
            delete conversation.usage;
            estimate = estimateContext(prompt, history);
          } catch (error) {
            signal.throwIfAborted();

            // 本回合余下请求跳过压缩，避免同一个压缩错误反复阻塞对话。
            compressionFailed = true;
            this.emit({ kind: 'error', text: `无法压缩对话上下文：${message(error)}` });
          }
        }

        // 模型请求完成后立即检查取消，再决定是否接受输出和工具调用。
        const reply = await this.generate(prompt, history, true, signal, onDelta);
        signal.throwIfAborted();
        if (reply.inputTokens) conversation.usage = { key: usageKey, estimate, tokens: reply.inputTokens };
        if (reply.calls.length) pendingTools = { reply, results: [], running: false };
        if (!output.some((event) => event.kind === 'assistant')) onDelta('assistant', reply.text);
        signal.throwIfAborted();

        // 普通答复直接写入协议历史，工具答复须等结果齐备后一起写入。
        if (!pendingTools) {
          history.push(...reply.history);
          output = [];
          return;
        }

        // 依次完成工具调用，暂停时等待关卡恢复。
        const batch = pendingTools;
        for (const call of reply.calls) {
          await this.tools.whenActive(signal);
          signal.throwIfAborted();
          batch.running = true;
          const result = await this.runTool(call, signal);
          signal.throwIfAborted();
          batch.results.push(result);
          batch.running = false;
        }
        retainOutput();
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

  // 分批压缩历史，逐批更新同一份摘要。
  private async compress(history: Record<string, unknown>[], threshold: number, signal: AbortSignal) {
    const instruction = personalizePrompt(compressionPrompt, this.username);
    const transcript = Array.from(contextToSummarize(history));
    const chunkSize = Math.max(1000, Math.min(24000, Math.floor(threshold / 2)));
    let summary = '';

    // 按字符分段，把上一段的摘要一并交给下一次压缩请求。
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

  // 通过本地代理接收一个模型流，并按需计入调试统计。
  private async generate(
    prompt: string, history: Record<string, unknown>[], includeTools: boolean,
    signal: AbortSignal, emit: (kind: OutputKind, text: string) => void,
  ) {
    signal.throwIfAborted();
    const protocol = this.model.api;
    const body = adapters[protocol].request(this.model, prompt, history, includeTools, this.tools.isReadScreenDisabled?.());
    const idle = new AbortController();

    // 将玩家主动中断和网络空闲超时接到同一个 Fetch 请求。
    const requestSignal = AbortSignal.any([signal, idle.signal]);
    let timer: ReturnType<typeof setTimeout>;

    // 将超时计时从最近一次收到数据开始计算。
    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException(modelErrorMessages.timeout, 'TimeoutError')), 65000);
    }
    resetTimer();
    try {
      const payload = JSON.stringify(body);
      const tracker = this.requestTracker;
      const stats = tracker?.stats;
      if (stats) {
        stats.turns++;
        tracker.onChange();
      }
      const startedAt = tracker ? performance.now() : 0;
      const response = await fetch(protocols[protocol].path, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: payload, signal: requestSignal,
      });

      // 即使取消发生在 Fetch 返回时，也主动关闭迟到的响应体。
      if (requestSignal.aborted) {
        void response.body?.cancel().catch(() => {});
        requestSignal.throwIfAborted();
      }

      if (!response.ok) throw new Error(await proxyError(response));
      const stream = streamReply(protocol, emit);
      resetTimer();
      await readModelStream(response, (data) => acceptStreamEvent(stream, data), requestSignal, resetTimer, protocol === 'OllamaChat');
      requestSignal.throwIfAborted();
      const reply = stream.finish();
      if (stats) {
        recordUsage(stats, reply, (performance.now() - startedAt) / 1000);
        tracker.onChange();
      }
      return reply;
    } catch (error) {
      requestSignal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }

  // 将新事件加入共享历史并通知界面。
  private emit(event: ChatEvent) {
    this.conversation.events.push(event);
    this.onEvent(event);
  }

  // 验证并运行一个模型工具，同时生成聊天可见记录。
  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== readScreenTool && call.name !== execActionSequenceTool) {
      const detail = typeof call.args === 'string' && call.serialized ? call.args : JSON.stringify(call.args, null, 2);
      this.emit({ kind: 'tool', text: '不支持的行动', detail: detail ?? '未提供参数' });
      return { text: toolMessages.notFound, error: true };
    }

    // 保留动作描述，使工具失败时仍能展示模型尝试执行的动作。
    let actionDetail: string | undefined;
    let actionEvent: ChatEvent | undefined;
    try {
      // 先解码协议传来的字符串参数，再按工具分别校验。
      const args: unknown = call.serialized ? JSON.parse(typeof call.args === 'string' ? call.args : '') : call.args;
      if (call.name === readScreenTool) {
        if (!isRecord(args) || Object.keys(args).length) throw new Error(toolMessages.invalidReadScreenArgs);
        const image = this.tools.readScreen(this.tools.isReadScreenDisabled?.() ?? false);
        this.emit({ kind: 'tool', text: '看了一眼', image });
        return { text: toolMessages.ok, image };
      }

      // 先生成展示用动作描述，再验证关卡状态和整批动作。
      actionDetail = describeActions(args);
      if (this.tools.outcome() !== 'active') throw new Error(toolMessages.levelEnded);
      const steps = compileActions(args);
      actionEvent = { kind: 'tool', text: '执行动作', detail: actionDetail };
      this.emit(actionEvent);
      signal.throwIfAborted();
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

// 更新累计用量，并计算最新的缓存命中率和输出速率。
function recordUsage(stats: RequestStats, { inputTokens, outputTokens, cachedTokens, generationSeconds }: Reply, elapsedSeconds: number) {
  stats.inputTokens += inputTokens ?? 0;
  stats.outputTokens += outputTokens ?? 0;
  stats.lastCacheRatio = undefined;
  if (inputTokens && cachedTokens !== undefined && cachedTokens <= inputTokens) {
    stats.inputTokensWithCacheData += inputTokens;
    stats.cachedTokens += cachedTokens;
    stats.lastCacheRatio = cachedTokens / inputTokens;
  }
  const seconds = generationSeconds ?? elapsedSeconds;
  stats.lastOutputRate = outputTokens !== undefined && seconds > 0 ? outputTokens / seconds : undefined;
}

// 把工具参数中的关键动作转换成可阅读的描述。
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

// 将运行时错误转换成玩家提示。
function message(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return modelErrorMessages.timeout;
  if (error instanceof TypeError) return modelErrorMessages.connection;
  return error instanceof Error ? error.message : modelErrorMessages.failed;
}

// 按代理错误代码和 HTTP 状态生成提示。
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
