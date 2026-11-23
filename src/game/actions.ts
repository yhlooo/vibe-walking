import { toolMessages } from '../agent/prompts.ts';
import { isRecord } from '../level/definition.ts';
import { idleInput, moveTime, stepMS } from './world.ts';
import type { StepInput } from './world.ts';

type Key = 'jump' | 'moveLeft' | 'moveRight' | 'sleep';
type Action = { key: Key; value?: number; hold?: number };

const maxSteps = 30000 / stepMS;
const maxActions = 32;
const maxHoldMS = 6000;
const maxSleepMS = 10000;

export function compileActions(value: unknown): StepInput[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.actions) ||
      value.actions.length === 0 || value.actions.length > maxActions) {
    throw new Error(toolMessages.invalidActionCount);
  }
  const steps: StepInput[] = [];
  let totalSteps = 0;
  let jump = false;
  for (const [index, action] of value.actions.entries()) {
    const invalid = () => new Error(toolMessages.invalidAction(index));
    if (!isRecord(action) || Object.keys(action).some((key) => key !== 'key' && key !== 'value' && key !== 'hold')) throw invalid();
    const { key, value: amount, hold } = action;
    if (hold !== undefined && ((key !== 'moveLeft' && key !== 'moveRight') || amount !== undefined)) throw invalid();
    if (key === 'jump') {
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) throw invalid();
      jump = true;
      continue;
    }
    const sleep = key === 'sleep';
    if (!sleep && key !== 'moveLeft' && key !== 'moveRight') throw invalid();
    const direction = sleep ? 0 : key === 'moveLeft' ? -1 : 1;
    if (sleep || hold !== undefined) {
      const seconds = sleep ? amount : hold;
      const maxMS = sleep ? maxSleepMS : maxHoldMS;
      if (typeof seconds !== 'number' || !(seconds >= 0.001 && seconds <= maxMS / 1000) ||
          seconds !== Number(seconds.toFixed(3))) throw invalid();
      const ticks = Math.ceil(Math.round(seconds * 1000) / stepMS);
      for (let tick = 0; tick < ticks; tick++) steps.push({ direction, jump: jump && tick === 0 });
      totalSteps += ticks;
    } else {
      if (typeof amount !== 'number' || !(amount >= 0.01 && amount <= 24) ||
          amount !== Number(amount.toFixed(2))) throw invalid();
      steps.push({ direction, jump, distance: amount });
      // Starting from rest is the longest a move of this distance can take.
      totalSteps += Math.ceil(moveTime(amount) * 1000 / stepMS - 1e-9);
    }
    jump = false;
    if (totalSteps > maxSteps) throw new Error(toolMessages.actionSequenceTooLong);
  }
  // A trailing jump still needs a physics step when there is no timed action after it.
  if (jump) steps.push({ ...idleInput, jump });
  if (totalSteps + Number(jump) > maxSteps) throw new Error(toolMessages.actionSequenceTooLong);
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
    const limit = (key === 'sleep' ? maxSleepMS : maxHoldMS) / stepMS;
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
      const seconds = ticks * stepMS / 1000;
      return key === 'sleep' ? { key, value: seconds } : { key, hold: seconds };
    });
  }
}
