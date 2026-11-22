import { compileActions } from '../game/actions.ts';
import { isRecord } from '../level/definition.ts';
import { adapters } from './protocols.ts';
import type { ToolCall, ToolResult } from './protocols.ts';
import { protocols } from './settings.ts';
import type { ModelSettings, Protocol } from './settings.ts';
import type { Outcome, StepInput } from '../game/world.ts';

export const defaultPrompt = `你操控画面中有两只眼睛的浅色方块，角色边长为一格。

- 使用 ReadScreen 查看完整画面。使用 ExecActionSequence 按顺序执行动作。
- moveLeft 和 moveRight 的 value 是移动距离，单位为格。sleep 的 value 是等待时间，单位为秒。jump 无需 value，可和紧随其后的移动同时开始。
- 重力持续生效，角色落回支撑面后恢复起跳机会；走出边缘时，若尚未起跳，仍可跳一次。实心方块和地图顶边阻挡移动，地图两侧限制水平移动。停止水平输入后，角色可能因惯性继续滑动。角色完全跌出地图底边即死亡。`;

export const respawnInfo = '<system-info>你刚刚跌落悬崖，现在游戏重新开始了</system-info>';

function userContent(text: string, systemInfo?: string) {
  return systemInfo ? `${systemInfo}\n${text}` : text;
}

export type ChatEvent =
  | { kind: 'player'; text: string; systemInfo?: string }
  | { kind: 'assistant' | 'error'; text: string }
  | { kind: 'tool'; text: string; detail?: string; image?: string };

export type Conversation = {
  events: ChatEvent[];
  history: Record<string, unknown>[];
  protocol?: Protocol;
  pendingSystemInfo?: string;
};

type GameTools = {
  readScreen: () => string;
  execute: (steps: StepInput[]) => Promise<void>;
  whenActive: (signal: AbortSignal) => Promise<void>;
  outcome: () => Outcome;
};

export class Agent {
  private readonly model: ModelSettings;
  private readonly prompt: string;
  private readonly tools: GameTools;
  private readonly onEvent: (event: ChatEvent) => void;
  private readonly conversation: Conversation;
  private readonly controller = new AbortController();
  busy = false;

  constructor(model: ModelSettings, prompt: string, tools: GameTools, emit: (event: ChatEvent) => void,
    conversation: Conversation = { events: [], history: [] }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.onEvent = emit;
    this.conversation = conversation;
  }

  dispose() {
    this.controller.abort();
  }

  async send(text: string, prompt = this.prompt) {
    const signal = this.controller.signal;
    if (this.busy || signal.aborted) return;
    this.busy = true;
    const protocol = this.model.api;
    const adapter = adapters[protocol];
    const conversation = this.conversation;
    if (conversation.protocol && conversation.protocol !== protocol) {
      conversation.history = conversation.events.flatMap((event) => {
        if (event.kind === 'player') return [{ role: 'user', content: userContent(event.text, event.systemInfo) }];
        if (event.kind === 'assistant') return [{ role: 'assistant', content: event.text }];
        return [];
      });
    }
    conversation.protocol = protocol;
    const { history } = conversation;
    const systemInfo = conversation.pendingSystemInfo;
    delete conversation.pendingSystemInfo;
    const userMessage = { role: 'user', content: userContent(text, systemInfo) };
    history.push(userMessage);
    this.emit({ kind: 'player', text, ...(systemInfo ? { systemInfo } : {}) });

    let uncommittedText: string | undefined;
    try {
      for (let request = 0; request < 8; request++) {
        await this.tools.whenActive(signal);
        signal.throwIfAborted();
        const toolsEnabled = request < 7;
        const body = adapter.request(this.model.model, prompt, history, toolsEnabled);
        const result = await fetch(protocols[protocol].path, {
          method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
        });
        if (!result.ok) throw new Error(await proxyError(result));
        const payload: unknown = await result.json();
        await this.tools.whenActive(signal);
        signal.throwIfAborted();
        const reply = adapter.read(payload);
        if (!reply.call) {
          history.push(...reply.history);
          if (reply.text) this.emit({ kind: 'assistant', text: reply.text });
          return;
        }
        if (!toolsEnabled) throw new Error('模型在回合结束时仍请求执行工具');
        uncommittedText = reply.text;
        if (uncommittedText) this.emit({ kind: 'assistant', text: uncommittedText });
        const toolResult = await this.runTool(reply.call, signal);
        signal.throwIfAborted();
        history.push(...reply.history, ...adapter.result(reply.call, toolResult));
        uncommittedText = undefined;
      }
    } catch (error) {
      if (signal.aborted) {
        if (uncommittedText && history.includes(userMessage)) {
          history.push({ role: 'assistant', content: uncommittedText });
        }
        return;
      }
      await this.tools.whenActive(signal).catch(() => undefined);
      if (!signal.aborted) this.emit({ kind: 'error', text: message(error) });
    } finally {
      this.busy = false;
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
        await this.tools.execute(steps);
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
  if (response.status === 400 || response.status === 422) return '上游未接受模型请求，请确认模型支持截图和工具调用';
  return `模型请求失败（HTTP ${response.status}）`;
}
