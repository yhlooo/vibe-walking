import { findButton, gravityDirection, gridSize } from '../level/definition.ts';
import type { LevelDefinition, Point } from '../level/definition.ts';

export type Direction = -1 | 0 | 1;
export type StepInput = { direction: Direction; jump: boolean; distance: number };
export type Outcome = 'active' | 'won' | 'lost';
export type Player = Point & { facing: -1 | 1 };
export type WorldState = {
  player: Player;
  velocityY: number;
  canJump: boolean;
  previousDirection: Direction;
  slideDirection: Direction;
  slideRemaining: number;
};
export type Snapshot = { level: LevelDefinition; player: Player; outcome: Outcome };

export const stepMS = 10;
export const movePerStep = 0.04;
export const idleInput: StepInput = { direction: 0, jump: false, distance: 0 };

const stepSeconds = stepMS / 1000;
const jumpSpeed = Math.sqrt(48);
const epsilon = 1e-9;

function overlaps(start: number, tile: number): boolean {
  return start < tile + 1 - epsilon && start + 1 > tile + epsilon;
}

export class World {
  readonly level: LevelDefinition;
  private readonly solids: Point[];
  private readonly button?: Point;
  private readonly size: ReturnType<typeof gridSize>;
  private player: Player;
  private velocityY = 0;
  private canJump = true;
  private previousDirection: Direction = 0;
  private slideDirection: Direction = 0;
  private slideRemaining = 0;
  outcome: Outcome = 'active';

  constructor(level: LevelDefinition, saved?: WorldState) {
    this.level = level;
    this.button = findButton(level);
    this.size = gridSize(level.tiles);
    this.player = saved ? { ...saved.player } : { ...level.spawn, facing: 1 };
    if (saved) {
      this.velocityY = saved.velocityY;
      this.canJump = saved.canJump;
      this.previousDirection = saved.previousDirection;
      this.slideDirection = saved.slideDirection;
      this.slideRemaining = saved.slideRemaining;
    }
    this.solids = level.tiles.flatMap((row, y) => Array.from(row).flatMap((tile, x) => tile === '#' ? [{ x, y }] : []));
  }

  save(): WorldState {
    return {
      player: { ...this.player }, velocityY: this.velocityY, canJump: this.canJump,
      previousDirection: this.previousDirection, slideDirection: this.slideDirection, slideRemaining: this.slideRemaining,
    };
  }

  snapshot(): Snapshot {
    return { level: this.level, player: { ...this.player }, outcome: this.outcome };
  }

  step(input: StepInput = idleInput): Outcome {
    if (this.outcome !== 'active') return this.outcome;
    const gravity = gravityDirection(this.level.gravity);
    if (input.jump && this.canJump) {
      this.canJump = false;
      this.velocityY = -gravity * jumpSpeed;
    }
    this.moveHorizontally(input);
    this.velocityY = Math.max(-20, Math.min(20, this.velocityY + (16 * this.level.gravity * stepSeconds)));
    const dy = this.velocityY * stepSeconds;
    const y = Math.max(0, this.sweep(this.player.y, this.player.x, dy, 'y'));
    if (Math.abs(y - (this.player.y + dy)) > epsilon) this.velocityY = 0;
    this.player.y = y;

    const support = (gravity < 0 && y === 0) || this.solids.some((solid) =>
      overlaps(this.player.x, solid.x) && Math.abs(y - (solid.y - gravity)) < epsilon);
    if (support && this.velocityY * gravity >= 0) {
      this.canJump = true;
      this.velocityY = 0;
      if (this.button && Math.abs(y - this.button.y) < epsilon && overlaps(this.player.x, this.button.x) &&
          this.level.tiles[this.button.y + gravity]?.[this.button.x] === '#') {
        this.outcome = 'won';
      }
    }
    if (y >= this.size.rows) this.outcome = 'lost';
    return this.outcome;
  }

  private moveHorizontally(input: StepInput) {
    let dx = input.direction * input.distance;
    if (input.direction !== 0) {
      this.slideRemaining = 0;
    } else {
      if (this.previousDirection !== 0) {
        this.slideDirection = this.previousDirection;
        this.slideRemaining = this.level.inertia;
      }
      const distance = Math.min(this.slideRemaining, movePerStep);
      dx = this.slideDirection * distance;
      this.slideRemaining -= distance;
    }
    this.previousDirection = input.direction;

    const start = this.player.x;
    const end = Math.max(0, Math.min(this.size.columns - 1, this.sweep(start, this.player.y, dx, 'x')));
    if (Math.abs(end - start) > epsilon) this.player.facing = end < start ? -1 : 1;
    if (input.direction === 0 && Math.abs(end - (start + dx)) > epsilon) this.slideRemaining = 0;
    this.player.x = end;
  }

  private sweep(start: number, across: number, delta: number, axis: 'x' | 'y'): number {
    let end = start + delta;
    if (delta === 0) return end;
    const otherAxis = axis === 'x' ? 'y' : 'x';
    for (const solid of this.solids) {
      if (!overlaps(across, solid[otherAxis])) continue;
      const edge = solid[axis] + (delta > 0 ? -1 : 1);
      if (delta > 0 && edge >= start - epsilon) end = Math.min(end, Math.max(start, edge));
      if (delta < 0 && edge <= start + epsilon) end = Math.max(end, Math.min(start, edge));
    }
    return end;
  }
}
