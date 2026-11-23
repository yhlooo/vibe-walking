import { findButton, gravityDirection, gridSize } from '../level/definition.ts';
import type { LevelDefinition, Point } from '../level/definition.ts';

export type Direction = -1 | 0 | 1;
// A direction without a distance is a held key for this physics step.
export type StepInput = { direction: Direction; jump: boolean; distance?: number };
export type Outcome = 'active' | 'won' | 'lost';
export type Player = Point & { facing: -1 | 1 };
export type WorldState = {
  player: Player;
  velocityY: number;
  canJump: boolean;
  previousDirection: Direction;
  moveDistance?: number;
  slideDirection: Direction;
  slideRemaining: number;
};
export type Snapshot = { level: LevelDefinition; player: Player; outcome: Outcome };

export const stepMS = 10;
export const idleInput: StepInput = { direction: 0, jump: false };

const stepSeconds = stepMS / 1000;
const moveSpeed = 4;
const accelerationDistance = 1;
const accelerationTime = 2 * accelerationDistance / moveSpeed;
const jumpSpeed = Math.sqrt(48);
const epsilon = 1e-9;

export function moveTime(distance: number): number {
  if (distance <= accelerationDistance) return accelerationTime * Math.sqrt(distance / accelerationDistance);
  return accelerationTime + (distance - accelerationDistance) / moveSpeed;
}

function distanceAtTime(time: number): number {
  if (time <= accelerationTime) return accelerationDistance * (time / accelerationTime) ** 2;
  return accelerationDistance + (time - accelerationTime) * moveSpeed;
}

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
  private moveDistance = 0;
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
      this.moveDistance = saved.moveDistance ?? Math.abs(saved.previousDirection);
      this.slideDirection = saved.slideDirection;
      this.slideRemaining = saved.slideRemaining;
    }
    this.solids = level.tiles.flatMap((row, y) => Array.from(row).flatMap((tile, x) => tile === '#' ? [{ x, y }] : []));
  }

  save(): WorldState {
    return {
      player: { ...this.player }, velocityY: this.velocityY, canJump: this.canJump,
      previousDirection: this.previousDirection, moveDistance: this.moveDistance,
      slideDirection: this.slideDirection, slideRemaining: this.slideRemaining,
    };
  }

  snapshot(): Snapshot {
    return { level: this.level, player: { ...this.player }, outcome: this.outcome };
  }

  // Returns the unspent distance of a move command, if any.
  step(input: StepInput = idleInput): number {
    if (this.outcome !== 'active') return 0;
    const gravity = gravityDirection(this.level.gravity);
    if (input.jump && this.canJump) {
      this.canJump = false;
      this.velocityY = -gravity * jumpSpeed;
    }
    const remaining = this.moveHorizontally(input);
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
    return remaining;
  }

  private moveHorizontally({ direction, distance }: StepInput): number {
    if (this.previousDirection !== 0 && direction !== this.previousDirection) {
      this.slideDirection = this.previousDirection;
      this.slideRemaining = this.level.inertia * (this.moveDistance / accelerationDistance);
      if (this.slideRemaining < epsilon) this.clearSlide();
      this.previousDirection = 0;
      this.moveDistance = 0;
    }

    if (direction === 0) {
      this.slide();
      return 0;
    }

    let time = stepSeconds;
    // A slide pressed against a wall has no distance to cancel.
    if (this.slideDirection === -direction && this.horizontalEnd(this.slideDirection * this.slideRemaining) === this.player.x) {
      this.clearSlide();
    }
    if (this.slideDirection === -direction) {
      const cancelled = Math.min(distance ?? moveSpeed * stepSeconds, this.slideRemaining);
      this.slideRemaining -= cancelled;
      if (this.slideRemaining < epsilon) this.clearSlide();
      if (distance === undefined) {
        time -= cancelled / moveSpeed;
        if (this.slideRemaining > 0) {
          this.slide();
          return 0;
        }
        if (time < epsilon) return 0;
      } else {
        distance -= cancelled;
        if (distance < epsilon) return 0;
      }
    }

    this.clearSlide();
    this.previousDirection = direction;
    const available = distanceAtTime(moveTime(this.moveDistance) + time) - this.moveDistance;
    const travel = Math.min(distance ?? available, available);
    this.moveDistance = Math.min(accelerationDistance, this.moveDistance + travel);
    this.translate(direction * travel);
    return distance !== undefined && distance - travel > epsilon ? distance - travel : 0;
  }

  private slide() {
    if (this.slideRemaining === 0 || this.level.inertia === 0) return;
    // Constant deceleration: the current speed is determined by the stopping distance.
    const deceleration = moveSpeed ** 2 / (2 * this.level.inertia);
    const speed = Math.sqrt(2 * deceleration * this.slideRemaining);
    const time = Math.min(stepSeconds, speed / deceleration);
    const travel = (speed - deceleration * time / 2) * time;
    this.slideRemaining -= travel;
    const unobstructed = this.translate(this.slideDirection * travel);
    if (!unobstructed || this.slideRemaining < epsilon) this.clearSlide();
  }

  private clearSlide() {
    this.slideDirection = 0;
    this.slideRemaining = 0;
  }

  private horizontalEnd(dx: number): number {
    return Math.max(0, Math.min(this.size.columns - 1, this.sweep(this.player.x, this.player.y, dx, 'x')));
  }

  private translate(dx: number): boolean {
    const start = this.player.x;
    const end = this.horizontalEnd(dx);
    if (Math.abs(end - start) > epsilon) this.player.facing = end < start ? -1 : 1;
    this.player.x = end;
    return Math.abs(end - (start + dx)) <= epsilon;
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
