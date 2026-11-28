import { toolMessages } from '../agent/prompts.ts';
import { Recorder } from './actions.ts';
import { idleInput, stepMS, World } from './world.ts';
import type { Direction, Outcome, Snapshot, StepInput, WorldState } from './world.ts';
import type { LevelDefinition } from '../level/definition.ts';

// 将 WASD、方向键和空格映射到游戏动作。
const leftKeys = ['KeyA', 'ArrowLeft'];
const rightKeys = ['KeyD', 'ArrowRight'];
const jumpKeys = ['KeyW', 'ArrowUp', 'Space'];
const controlKeys = new Set([...leftKeys, ...rightKeys, ...jumpKeys]);

// 保存工具动作队列、当前步和任务完成回调。
type Sequence = {
  steps: StepInput[];
  index: number;
  pending?: StepInput;
  resolve: () => void;
  reject: (error: DOMException) => void;
};

/** 推进固定步长的世界，并在手动输入和模型动作之间切换。 */
export class Runtime {
  world: World;
  recorder?: Recorder;
  private manual: boolean;
  private readonly listeners = new AbortController();
  private readonly events = new EventTarget();
  private readonly pressed = new Set<string>();
  private jump = false;
  private sequence?: Sequence;
  private paused = false;
  private previousFrame?: number;
  private accumulator = 0;
  private frame: number;

  // 建立世界、绑定输入监听并启动渲染时钟。
  constructor(level: LevelDefinition, manual: boolean, draw: (snapshot: Snapshot) => void, ended: (outcome: Outcome) => void, saved?: WorldState) {
    this.world = new World(level, saved);
    this.manual = manual;
    if (manual) this.recorder = new Recorder();

    const signal = this.listeners.signal;

    // 切换页面可见性时重置时钟，窗口失焦时清除残留按键。
    document.addEventListener('visibilitychange', () => this.updateClock(), { signal });
    window.addEventListener('keydown', (event) => this.keyDown(event), { signal });
    window.addEventListener('keyup', (event) => this.pressed.delete(event.code), { signal });
    window.addEventListener('blur', () => this.clearKeys(), { signal });

    // 每帧补算固定步长，并限制浏览器卡顿后的追赶时长。
    const tick = (now: number) => {
      if (!this.frozen && this.world.outcome === 'active') {
        const elapsed = this.previousFrame === undefined ? 0 : now - this.previousFrame;
        this.accumulator += Math.min(elapsed, 100);

        // 只执行完整的物理步，把不足一步的时间留给下一帧。
        while (this.accumulator >= stepMS) {
          this.accumulator -= stepMS;
          const outcome = this.step();
          if (outcome !== 'active') {
            ended(outcome);
            break;
          }
        }
      }

      this.previousFrame = now;
      draw(this.world.snapshot());
      if (!signal.aborted) this.frame = requestAnimationFrame(tick);
    };
    draw(this.world.snapshot());
    this.frame = requestAnimationFrame(tick);
  }

  // 暂停或恢复模拟，清除切换时的按键和计时状态。
  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.updateClock();
  }

  // 终止当前动作并从给定关卡创建新一局。
  reset(level: LevelDefinition, manual = this.manual) {
    this.cancelSequence();
    this.world = new World(level);
    this.manual = manual;
    this.recorder = manual ? new Recorder() : undefined;
    this.accumulator = 0;
    this.updateClock();
  }

  // 退出手动模式并清除当前按键状态。
  releaseManualControl() {
    this.manual = false;
    this.clearKeys();
  }

  // 等待游戏解除暂停，并响应对话取消。
  async whenActive(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    while (this.frozen) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          this.events.removeEventListener('resume', resume);
          reject(signal.reason);
        };
        this.events.addEventListener('resume', resume, { once: true });
        signal.addEventListener('abort', cancel, { once: true });
      });
      signal.throwIfAborted();
    }
  }

  // 装载动作队列并等待模拟执行完成。
  async execute(steps: StepInput[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.manual || this.sequence || !steps.length || this.world.outcome !== 'active') {
      throw new Error(toolMessages.cannotExecute);
    }

    const cancel = () => this.cancelSequence();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await new Promise<void>((resolve, reject) => { this.sequence = { steps, index: 0, resolve, reject }; });
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  // 丢弃待执行动作并通知等待方。
  cancelSequence() {
    this.sequence?.reject(new DOMException(toolMessages.cancelled, 'AbortError'));
    this.sequence = undefined;
  }

  // 移除输入监听，停止渲染并取消动作。
  dispose() {
    this.cancelSequence();
    this.listeners.abort();
    cancelAnimationFrame(this.frame);
  }

  // 判断当前是否应停止推进游戏。
  private get frozen(): boolean {
    return this.paused || document.hidden;
  }

  // 重置物理步计时并通知活动状态变动。
  private updateClock() {
    this.previousFrame = undefined;
    this.clearKeys();
    if (!this.frozen) this.events.dispatchEvent(new Event('resume'));
  }

  // 丢弃当前按键和待处理的跳跃输入。
  private clearKeys() {
    this.pressed.clear();
    this.jump = false;
  }

  // 记录移动按键及单次跳跃输入。
  private keyDown(event: KeyboardEvent) {
    if (!this.manual || !controlKeys.has(event.code) || this.frozen || this.world.outcome !== 'active' ||
        event.altKey || event.ctrlKey || event.metaKey ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]'))) return;
    event.preventDefault();
    if (event.repeat) return;
    if (jumpKeys.includes(event.code) && !jumpKeys.some((key) => this.pressed.has(key))) this.jump = true;
    this.pressed.add(event.code);
  }

  // 根据控制模式或当前工具动作推进一次世界模拟。
  private step(): Outcome {
    const current = this.sequence;
    let input = idleInput;
    if (this.manual && this.recorder) {
      const left = leftKeys.some((key) => this.pressed.has(key));
      const right = rightKeys.some((key) => this.pressed.has(key));
      const direction: Direction = left === right ? 0 : left ? -1 : 1;
      input = { direction, jump: this.jump };
      this.jump = false;
      this.recorder.record(input);

      // 手动试玩等到首次有效操作才开始推进世界。
      if (!this.recorder.started) return this.world.outcome;
    } else if (current) {
      input = current.pending ?? current.steps[current.index++];
    }

    const remaining = this.world.step(input);
    const outcome = this.world.outcome;
    if (current) {
      // 尚有移动距离时，下一步继续移动，跳跃输入只使用一次。
      current.pending = remaining > 0 ? { direction: input.direction, jump: false, distance: remaining } : undefined;
      if (outcome !== 'active' || (!current.pending && current.index === current.steps.length)) {
        this.sequence = undefined;
        current.resolve();
      }
    }
    return outcome;
  }
}
