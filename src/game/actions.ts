import { isRecord } from '../level/definition.ts';
import { idleInput, movePerStep, stepMS } from './world.ts';
import type { StepInput } from './world.ts';

type Key = 'jump' | 'moveLeft' | 'moveRight' | 'sleep';
type Action = { key: Key; value?: number };

const maxSteps = 30000 / stepMS;
const maxActions = 32;
const moveUnits = Math.round(movePerStep * 100);

export function compileActions(value: unknown): StepInput[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.actions) ||
      value.actions.length === 0 || value.actions.length > maxActions) {
    throw new Error('actions 必须包含 1 到 32 个动作');
  }
  const steps: StepInput[] = [];
  let jump = false;
  for (const [index, action] of value.actions.entries()) {
    const invalid = () => new Error(`第 ${index + 1} 个动作的类型或参数无效`);
    if (!isRecord(action) || Object.keys(action).some((key) => key !== 'key' && key !== 'value')) throw invalid();
    const { key, value: amount } = action;
    if (key === 'jump') {
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) throw invalid();
      jump = true;
      continue;
    }
    const sleep = key === 'sleep';
    if (!sleep && key !== 'moveLeft' && key !== 'moveRight') throw invalid();
    const scale = sleep ? 1000 : 100;
    const precision = sleep ? 3 : 2;
    if (typeof amount !== 'number' || !(amount >= 1 / scale && amount <= (sleep ? 10 : 24)) ||
        amount !== Number(amount.toFixed(precision))) throw invalid();
    const direction = sleep ? 0 : key === 'moveLeft' ? -1 : 1;
    const perStep = sleep ? stepMS : moveUnits;
    for (let remaining = Math.round(amount * scale); remaining > 0; remaining -= perStep) {
      steps.push({ direction, jump, distance: sleep ? 0 : Math.min(remaining, perStep) / scale });
      jump = false;
    }
    if (steps.length > maxSteps) throw new Error('动作序列最长为 30 秒');
  }
  // A trailing jump still needs a physics step when there is no timed action after it.
  if (jump) steps.push({ ...idleInput, jump });
  if (steps.length > maxSteps) throw new Error('动作序列最长为 30 秒');
  return steps;
}

type Segment = { key: Key; ticks: number };

export class Recorder {
  private segments: Segment[] = [];
  private totalSteps = 0;

  record(input: StepInput) {
    if (!this.started && !input.jump && input.direction === 0) return;
    if (input.jump) this.segments.push({ key: 'jump', ticks: 0 });
    const key = input.direction === 0 ? 'sleep' : input.direction === -1 ? 'moveLeft' : 'moveRight';
    const limit = key === 'sleep' ? 1000 : 600;
    const last = this.segments.at(-1);
    if (last?.key === key && last.ticks < limit) last.ticks++;
    else this.segments.push({ key, ticks: 1 });
    this.totalSteps++;
  }

  get started(): boolean {
    return this.totalSteps > 0;
  }

  get tooLong(): boolean {
    return this.totalSteps > maxSteps || this.segments.length > maxActions;
  }

  actions(): Action[] {
    return this.segments.map(({ key, ticks }) => {
      if (key === 'jump') return { key };
      const value = key === 'sleep' ? ticks * stepMS / 1000 : ticks * moveUnits / 100;
      return { key, value };
    });
  }
}
