import { findButton, gravityDirection, gridSize } from '../level/definition.ts';
import type { LevelDefinition, Point } from '../level/definition.ts';

/** 表示左右方向或没有水平输入。 */
export type Direction = -1 | 0 | 1;
/** 未指定距离的方向输入表示在该物理步持续按键。 */
export type StepInput = { direction: Direction; jump: boolean; distance?: number };
/** 区分进行中、通关和坠落。 */
export type Outcome = 'active' | 'won' | 'lost';
/** 保存角色的位置和水平朝向。 */
export type Player = Point & { facing: -1 | 1 };
/** 提供渲染所需的关卡、角色与结局。 */
export type Snapshot = { level: LevelDefinition; player: Player; outcome: Outcome };

/** 固定一次物理模拟步长，单位为毫秒。 */
export const stepMS = 10;
/** 表示本步没有主动输入。 */
export const idleInput: StepInput = { direction: 0, jump: false };

// 将步长换算成秒并集中定义运动常量。
const stepSeconds = stepMS / 1000;
const moveSpeed = 4;
const accelerationDistance = 1;
const accelerationTime = 2 * accelerationDistance / moveSpeed;
const jumpSpeed = Math.sqrt(48);
const epsilon = 1e-9;

/** 计算从静止开始移动指定距离所需的时间。 */
export function moveTime(distance: number): number {
  if (distance <= accelerationDistance) return accelerationTime * Math.sqrt(distance / accelerationDistance);
  return accelerationTime + (distance - accelerationDistance) / moveSpeed;
}

// 按先加速再匀速的规则计算移动距离。
function distanceAtTime(time: number): number {
  if (time <= accelerationTime) return accelerationDistance * (time / accelerationTime) ** 2;
  return accelerationDistance + (time - accelerationTime) * moveSpeed;
}

// 检查玩家与单格在某轴上是否重叠，排除边缘相接。
function overlaps(start: number, tile: number): boolean {
  return start < tile + 1 - epsilon && start + 1 > tile + epsilon;
}

/** 维护玩家物理状态并逐步计算碰撞和结局。 */
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

  // 收集固体格和按钮，并把玩家放在出生点。
  constructor(level: LevelDefinition) {
    this.level = level;
    this.button = findButton(level);
    this.size = gridSize(level.tiles);
    this.player = { ...level.spawn, facing: 1 };
    this.solids = level.tiles.flatMap((row, y) => Array.from(row).flatMap((tile, x) => tile === '#' ? [{ x, y }] : []));
  }

  // 返回当前跳跃与滑行状态，供物理规则测试检查。
  motionState() {
    return { canJump: this.canJump, slideRemaining: this.slideRemaining };
  }

  // 返回供场景绘制使用的角色快照。
  snapshot(): Snapshot {
    return { level: this.level, player: { ...this.player }, outcome: this.outcome };
  }

  // 推进一个物理步并返回移动指令剩余的距离。
  step(input: StepInput = idleInput): number {
    if (this.outcome !== 'active') return 0;

    // 有重力时逆重力起跳，无重力时按附近支撑决定起跳方向。
    const gravity = gravityDirection(this.level.gravity);
    const zeroGravity = this.level.gravity === 0;
    const jumpDirection = zeroGravity && input.jump ? this.zeroGravityJumpDirection() : undefined;
    if (input.jump && (this.canJump || jumpDirection !== undefined)) {
      this.canJump = false;
      this.velocityY = (jumpDirection ?? -gravity) * jumpSpeed;
    }

    // 先移动水平方向，再在新横坐标上计算竖向碰撞。
    const remaining = this.moveHorizontally(input);
    this.velocityY = Math.max(-20, Math.min(20, this.velocityY + (16 * this.level.gravity * stepSeconds)));
    const dy = this.velocityY * stepSeconds;
    const y = Math.max(0, this.sweep(this.player.y, this.player.x, dy, 'y'));
    if (Math.abs(y - (this.player.y + dy)) > epsilon) this.velocityY = 0;
    this.player.y = y;

    // 落在重力方向的支撑面时恢复跳跃，再判断是否踩中按钮。
    const support = (gravity < 0 && y === 0) || this.touchesSolid('y', gravity);
    if (support && this.velocityY * gravity >= 0) {
      this.canJump = true;
      this.velocityY = 0;
      if (this.button && Math.abs(y - this.button.y) < epsilon && overlaps(this.player.x, this.button.x) &&
          this.level.tiles[this.button.y + gravity]?.[this.button.x] === '#') {
        this.outcome = 'won';
      }
    }

    // 零重力时接触侧墙或屋顶也能恢复跳跃。
    if (zeroGravity && !this.canJump && this.zeroGravityJumpDirection() !== undefined) this.canJump = true;

    if (y >= this.size.rows) this.outcome = 'lost';
    return remaining;
  }

  // 按下、上、左、右的顺序查找无重力跳跃支撑。
  private zeroGravityJumpDirection(): -1 | 1 | undefined {
    if (this.touchesSolid('y', 1)) return -1;
    if (this.player.y < epsilon || this.touchesSolid('y', -1)) return 1;
    if (this.player.x < epsilon || this.touchesSolid('x', -1)) return -1;
    if (this.size.columns - 1 - this.player.x < epsilon || this.touchesSolid('x', 1)) return 1;
  }

  // 检查角色沿指定轴和方向是否紧贴实心格。
  private touchesSolid(axis: 'x' | 'y', direction: -1 | 1): boolean {
    const across = axis === 'x' ? 'y' : 'x';
    return this.solids.some((solid) =>
      Math.abs(this.player[axis] + direction - solid[axis]) < epsilon && overlaps(this.player[across], solid[across]));
  }

  // 推进主动移动或惯性滑行，返回尚未执行的指令距离。
  private moveHorizontally({ direction, distance }: StepInput): number {
    // 松键或换向时，将本轮累积的加速距离换算成可用滑行距离。
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

    // 反向输入先抵消原滑行，剩余时间或指令距离可用于反向移动。
    let time = stepSeconds;

    // A slide pressed against a wall has no distance to cancel.
    if (this.slideDirection === -direction && this.horizontalEnd(this.slideDirection * this.slideRemaining) === this.player.x) {
      this.clearSlide();
    }
    if (this.slideDirection === -direction) {
      const cancelled = Math.min(distance ?? moveSpeed * stepSeconds, this.slideRemaining);
      this.slideRemaining -= cancelled;
      if (this.slideRemaining < epsilon) this.clearSlide();

      // 按住方向时用本步时间抵消滑行，定距指令则消耗指定的距离。
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

    // 用位移曲线计算本步可消费的距离，再按碰撞限制实际位移。
    const available = distanceAtTime(moveTime(this.moveDistance) + time) - this.moveDistance;
    const travel = Math.min(distance ?? available, available);
    this.moveDistance = Math.min(accelerationDistance, this.moveDistance + travel);
    this.translate(direction * travel);
    return distance !== undefined && distance - travel > epsilon ? distance - travel : 0;
  }

  // 按当前剩余滑行距离计算本步减速和位移。
  private slide() {
    if (this.slideRemaining === 0 || this.level.inertia === 0) return;

    // Constant deceleration: the current speed is determined by the stopping distance.
    const deceleration = moveSpeed ** 2 / (2 * this.level.inertia);
    const speed = Math.sqrt(2 * deceleration * this.slideRemaining);
    const time = Math.min(stepSeconds, speed / deceleration);
    const travel = (speed - deceleration * time / 2) * time;
    this.slideRemaining -= travel;
    const unobstructed = this.translate(this.slideDirection * travel);

    // 撞墙或耗尽滑行距离后清理惯性，避免后续输入继续处理该滑行。
    // 撞墙或耗尽滑行距离后清理惯性，避免后续输入继续处理该滑行。
    if (!unobstructed || this.slideRemaining < epsilon) this.clearSlide();
  }

  // 重置剩余滑行距离及方向。
  private clearSlide() {
    this.slideDirection = 0;
    this.slideRemaining = 0;
  }

  // 计算经过地形和左右边界限制后的目标坐标。
  private horizontalEnd(dx: number): number {
    return Math.max(0, Math.min(this.size.columns - 1, this.sweep(this.player.x, this.player.y, dx, 'x')));
  }

  // 应用水平位移并同步角色朝向。
  private translate(dx: number): boolean {
    const start = this.player.x;
    const end = this.horizontalEnd(dx);
    if (Math.abs(end - start) > epsilon) this.player.facing = end < start ? -1 : 1;
    this.player.x = end;
    return Math.abs(end - (start + dx)) <= epsilon;
  }

  // 沿一个轴扫描可能阻挡角色的固体边缘。
  private sweep(start: number, across: number, delta: number, axis: 'x' | 'y'): number {
    let end = start + delta;
    if (delta === 0) return end;

    // 只扫描另一轴上与角色重叠的格子，再取移动方向上最先碰到的边缘。
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
