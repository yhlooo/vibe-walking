import { compileActions } from '../game/actions.ts';
import { isRecord } from '../level/definition.ts';
import { contextToSummarize, estimateContext } from './context.ts';
import type { ContextUsage } from './context.ts';
import { acceptStreamEvent, adapters, streamReply } from './protocols.ts';
import type { OutputKind, ToolCall, ToolResult } from './protocols.ts';
import { defaultMaxInputToken, protocols } from './settings.ts';
import type { ModelSettings, Protocol } from './settings.ts';
import { readEventStream } from './stream.ts';
import type { Outcome, StepInput } from '../game/world.ts';

export const defaultPrompt = `## 你是谁

你叫 Vibe ，是一个正方形白色方块，有两个眼睛。你不爱说话，沉默寡言，但是善于思考，行动敏捷。

## 你所在的世界

你在一个二维世界中，你可以左右移动，或向上跳。

- 使用 ReadScreen 工具可以查看你所处的环境，你是画面中那个白色正方形方块。你的边长为 1 。
- 用 ExecActionSequence 可以按顺序执行动作。
  每个行动序列中 key 是行动类型， value 是表示行动程度的值，对于不同行动不同：
  - \`jump\` : 进行一次跳跃。 value 无意义。起跳后操作就结束，可执行下一个操作，无需等待落地。起跳后仍然可以左右移动。起跳后在触地前不能再次起跳，但是在空中可以起跳（比如从边缘落下过程中可以进行一次起跳）。
  - \`moveLeft\` / \`moveRight\` : 移动指定距离。 value 1 约为 1 个你的边长。精确到 0.01 。视场景中惯性设置可能会有额外移动，移动完对应距离操作就结束，可执行下一个操作，无需等待惯性位移。立刻接与惯性等量的反向移动可以取消惯性。如果被障碍物阻挡仍会正常消耗移动量但不会移动，也不会反弹。
  - \`sleep\` : 等待指定时长。 value 单位秒。最多精确到毫秒，即 0.001 。

画面两侧和上方是硬边界无法穿过，画面底边下发是虚空，坠入会死亡。

## 关于和你对话的人

与你对话的人叫 {{user}} ，他将指导你在这个世界中的行动。目前来看，你或许应该信任这个人？`;

export const respawnInfo = '<system-info>你刚刚跌落悬崖，现在游戏重新开始了</system-info>';

const interruptionInfo = '<system-info>{{user}} 刚刚中断了你的行动，以下是 ta 的新指示</system-info>';

function personalize(text: string, username: string) {
  return text.replaceAll('{{user}}', () => username);
}

function userContent(text: string, systemInfo?: string) {
  return systemInfo ? `${systemInfo}\n${text}` : text;
}

export type ChatEvent =
  | { kind: 'player'; text: string; systemInfo?: string }
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
  readScreen: () => string;
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

  async send(text: string, prompt = this.prompt) {
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
    prompt = personalize(prompt, this.username);
    const systemInfo = [
      conversation.pendingSystemInfo && personalize(conversation.pendingSystemInfo, this.username),
      conversation.interrupted && personalize(interruptionInfo, this.username),
    ].filter(Boolean).join('\n');
    delete conversation.pendingSystemInfo;
    delete conversation.interrupted;
    const userMessage = { role: 'user', content: userContent(text, systemInfo) };
    history.push(userMessage);
    this.emit({ kind: 'player', text, ...(systemInfo ? { systemInfo } : {}) });

    let output: ChatEvent[] = [];
    let completedTool: { history: Record<string, unknown>[]; call: ToolCall } | undefined;
    const retainOutput = () => {
      if (completedTool) {
        history.push(...completedTool.history, ...adapter.result(completedTool.call, { text: '动作已中断', error: true }));
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
      for (let request = 0; request < 8; request++) {
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
            const entry = { role: 'user', content: `<system-info>此前对话与行动摘要：\n${summary}\n</system-info>` };
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
        const toolsEnabled = request < 7;
        const reply = await this.generate(prompt, history, toolsEnabled ? 'auto' : 'none', signal, onDelta);
        signal.throwIfAborted();
        if (reply.inputTokens) conversation.usage = { key: usageKey, estimate, tokens: reply.inputTokens };
        if (!output.some((event) => event.kind === 'assistant')) onDelta('assistant', reply.text);
        if (!reply.call) {
          history.push(...reply.history);
          output = [];
          return;
        }
        if (!toolsEnabled) throw new Error('模型在回合结束时仍请求执行工具');
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
    const instruction = personalize(
      '压缩 Vibe 和 {{user}} 的对话及游戏记录，简明保留 {{user}} 的指示、目标、已知关卡状态、已执行的动作和结果。' +
      '保留上一段摘要中的有效信息，只输出更新后的摘要，控制在 500 字以内。', this.username,
    );
    const transcript = Array.from(contextToSummarize(history));
    const chunkSize = Math.max(1000, Math.min(24000, Math.floor(threshold / 2)));
    let summary = '';
    for (let start = 0; start < transcript.length; start += chunkSize) {
      const chunk = transcript.slice(start, start + chunkSize).join('');
      const reply = await this.generate(instruction, [{
        role: 'user', content: summary ? `上一段摘要：\n${summary}\n\n后续记录：\n${chunk}` : chunk,
      }], 'omit', signal, () => {});
      if (!reply.text.trim()) throw new Error('模型未返回摘要');
      summary = reply.text.trim();
    }
    return summary;
  }

  private async generate(
    prompt: string, history: Record<string, unknown>[], tools: 'auto' | 'none' | 'omit',
    signal: AbortSignal, emit: (kind: OutputKind, text: string) => void,
  ) {
    signal.throwIfAborted();
    const protocol = this.model.api;
    const body = adapters[protocol].request(this.model, prompt, history, tools);
    const idle = new AbortController();
    const requestSignal = AbortSignal.any([signal, idle.signal]);
    let timer: ReturnType<typeof setTimeout>;
    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException('模型请求超时', 'TimeoutError')), 65000);
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
      await readEventStream(response, (data) => acceptStreamEvent(stream, data), requestSignal, resetTimer);
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
    try {
      const args: unknown = call.serialized ? JSON.parse(typeof call.args === 'string' ? call.args : '') : call.args;
      if (call.name === 'ReadScreen') {
        if (!isRecord(args) || Object.keys(args).length) throw new Error('ReadScreen 只接受空对象');
        const image = this.tools.readScreen();
        this.emit({ kind: 'tool', text: '读取画面', detail: 'ReadScreen', image });
        return { text: 'Ok', image };
      }
      if (call.name === 'ExecActionSequence') {
        if (this.tools.outcome() !== 'active') throw new Error('关卡已结束');
        const steps = compileActions(args);
        this.emit({ kind: 'tool', text: '执行动作', detail: JSON.stringify(args, null, 2) });
        await this.tools.execute(steps, signal);
        signal.throwIfAborted();
        return { text: 'Ok' };
      }
      throw new Error('工具不存在');
    } catch (error) {
      signal.throwIfAborted();
      const text = error instanceof SyntaxError ? '工具参数必须是有效的 JSON' : message(error);
      this.emit({ kind: 'tool', text: '工具执行失败', detail: `${call.name} · ${text}` });
      return { text: `Error: ${text}`, error: true };
    }
  }
}

function thinkingContext(text: string): string {
  return `<thinking>${text}</thinking>`;
}

function message(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '模型请求超时';
  if (error instanceof TypeError) return '无法连接本地模型代理';
  return error instanceof Error ? error.message : '模型请求失败';
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
  if (response.status === 400 || response.status === 422) return '上游未接受模型请求，请检查模型支持的思考强度、截图和工具调用';
  return `模型请求失败（HTTP ${response.status}）`;
}
