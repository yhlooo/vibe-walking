import { Recorder } from './actions.ts';
import { idleInput, movePerStep, stepMS, World } from './world.ts';
import type { Direction, Outcome, Snapshot, StepInput, WorldState } from './world.ts';
import type { LevelDefinition } from '../level/definition.ts';

const leftKeys = ['KeyA', 'ArrowLeft'];
const rightKeys = ['KeyD', 'ArrowRight'];
const jumpKeys = ['KeyW', 'ArrowUp', 'Space'];
const controlKeys = new Set([...leftKeys, ...rightKeys, ...jumpKeys]);

type Sequence = {
  steps: StepInput[];
  index: number;
  resolve: () => void;
  reject: (error: DOMException) => void;
};

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

  constructor(level: LevelDefinition, manual: boolean, draw: (snapshot: Snapshot) => void, ended: (outcome: Outcome) => void, saved?: WorldState) {
    this.world = new World(level, saved);
    this.manual = manual;
    if (manual) this.recorder = new Recorder();
    const signal = this.listeners.signal;
    document.addEventListener('visibilitychange', () => this.updateClock(), { signal });
    window.addEventListener('keydown', (event) => this.keyDown(event), { signal });
    window.addEventListener('keyup', (event) => this.pressed.delete(event.code), { signal });
    window.addEventListener('blur', () => this.clearKeys(), { signal });

    const tick = (now: number) => {
      if (!this.frozen && this.world.outcome === 'active') {
        const elapsed = this.previousFrame === undefined ? 0 : now - this.previousFrame;
        this.accumulator += Math.min(elapsed, 100);
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

  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.updateClock();
  }

  reset(level: LevelDefinition, manual = this.manual) {
    this.cancelSequence();
    this.world = new World(level);
    this.manual = manual;
    this.recorder = manual ? new Recorder() : undefined;
    this.accumulator = 0;
    this.updateClock();
  }

  releaseManualControl() {
    this.manual = false;
    this.clearKeys();
  }

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

  async execute(steps: StepInput[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.manual || this.sequence || !steps.length || this.world.outcome !== 'active') {
      throw new Error('当前无法执行动作');
    }
    const cancel = () => this.cancelSequence();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await new Promise<void>((resolve, reject) => { this.sequence = { steps, index: 0, resolve, reject }; });
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  cancelSequence() {
    this.sequence?.reject(new DOMException('动作已取消', 'AbortError'));
    this.sequence = undefined;
  }

  dispose() {
    this.cancelSequence();
    this.listeners.abort();
    cancelAnimationFrame(this.frame);
  }

  private get frozen(): boolean {
    return this.paused || document.hidden;
  }

  private updateClock() {
    this.previousFrame = undefined;
    this.clearKeys();
    if (!this.frozen) this.events.dispatchEvent(new Event('resume'));
  }

  private clearKeys() {
    this.pressed.clear();
    this.jump = false;
  }

  private keyDown(event: KeyboardEvent) {
    if (!this.manual || !controlKeys.has(event.code) || this.frozen || this.world.outcome !== 'active' ||
        event.altKey || event.ctrlKey || event.metaKey ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]'))) return;
    event.preventDefault();
    if (event.repeat) return;
    if (jumpKeys.includes(event.code) && !jumpKeys.some((key) => this.pressed.has(key))) this.jump = true;
    this.pressed.add(event.code);
  }

  private step(): Outcome {
    const current = this.sequence;
    let input = idleInput;
    if (this.manual && this.recorder) {
      const left = leftKeys.some((key) => this.pressed.has(key));
      const right = rightKeys.some((key) => this.pressed.has(key));
      const direction: Direction = left === right ? 0 : left ? -1 : 1;
      input = { direction, jump: this.jump, distance: direction === 0 ? 0 : movePerStep };
      this.jump = false;
      this.recorder.record(input);
      if (!this.recorder.started) return this.world.outcome;
    } else if (current) {
      input = current.steps[current.index++];
    }
    const outcome = this.world.step(input);
    if (current && (current.index === current.steps.length || outcome !== 'active')) {
      this.sequence = undefined;
      current.resolve();
    }
    return outcome;
  }
}
