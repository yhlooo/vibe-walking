import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileActions, Recorder } from '../src/game/actions.ts';
import { Runtime } from '../src/game/runtime.ts';
import { idleInput, World } from '../src/game/world.ts';
import { gridSize, gridSizes, playableError, readLevel, resizeLevel } from '../src/level/definition.ts';
import { exportLevel, importLevel } from '../src/level/json.ts';
import { drawScene } from '../src/render/scene.ts';

const firstLevel = readLevel(JSON.parse(readFileSync(new URL('./fixtures/legacy-level.json', import.meta.url))));
const right = { direction: 1, jump: false };

function repeat(world, input, count) {
  for (let index = 0; index < count; index++) world.step(input);
}

function runActions(world, ...actions) {
  for (const input of compileActions({ actions })) {
    let remaining = world.step(input);
    while (remaining > 0 && world.outcome === 'active') {
      remaining = world.step({ ...input, jump: false, distance: remaining });
    }
  }
}

function near(value, expected) {
  assert.ok(Math.abs(value - expected) < 1e-8, `expected ${value} to be near ${expected}`);
}

test('a level stops at positive overlap with the supported button', () => {
  const world = new World(firstLevel);
  runActions(world, { key: 'moveRight', value: 10 });
  const { player, outcome } = world.snapshot();
  assert.equal(outcome, 'won');
  assert.ok(player.x > 11 && player.x < 11.05);
  assert.equal(player.y, 7);
  world.step({ ...right, jump: true });
  assert.deepEqual(world.snapshot().player, player);
});

test('jumping over the button leaves it unpressed, while inverted support can be pressed', () => {
  const world = new World(firstLevel);
  repeat(world, right, 247);
  world.step({ ...right, jump: true });
  repeat(world, right, 102);
  assert.equal(world.outcome, 'active');
  assert.equal(world.snapshot().player.y, 7);
  assert.ok(world.snapshot().player.x >= 14);

  const ceiling = readLevel({ ...firstLevel, gravity: -1, tiles: [...firstLevel.tiles].reverse(), spawn: { x: 2, y: 1 } });
  assert.equal(playableError(ceiling), undefined);
  const inverted = new World(ceiling);
  repeat(inverted, right, 275);
  assert.equal(inverted.outcome, 'won');
  assert.equal(inverted.snapshot().player.y, 1);
});

test('blocked moves run for their commanded distance, then a jump can cross the block', () => {
  const tiles = [...firstLevel.tiles];
  tiles[7] = '.....#......B...';
  const world = new World(readLevel({ ...firstLevel, tiles }));
  runActions(world, { key: 'moveRight', value: 6.01 });
  assert.equal(world.snapshot().player.x, 4);
  world.step({ ...right, jump: true });
  repeat(world, right, 300);
  assert.equal(world.outcome, 'won');
});

test('a character can jump once after walking off a ledge', () => {
  const tiles = [...firstLevel.tiles];
  tiles[8] = '..#.........#...';
  const level = readLevel({ ...firstLevel, tiles, inertia: 0 });
  const world = new World(level);
  const comparison = new World(level);
  for (const state of [world, comparison]) {
    repeat(state, right, 53);
    assert.ok(state.snapshot().player.y > 7);
    state.step({ ...right, jump: true });
    repeat(state, right, 12);
    assert.ok(state.snapshot().player.y < 7);
  }
  world.step({ ...right, jump: true });
  comparison.step(right);
  assert.deepEqual(world.snapshot(), comparison.snapshot());
});

test('the roof stops jumps and reversed gravity while the bottom remains open', () => {
  const tiles = firstLevel.tiles.map((row) => '.'.repeat(row.length));
  const world = new World({ ...firstLevel, tiles, spawn: { x: 2, y: 0 } });
  world.step({ ...idleInput, jump: true });
  assert.equal(world.snapshot().player.y, 0);
  repeat(world, idleInput, 50);
  assert.equal(world.outcome, 'active');
  repeat(world, idleInput, 100);
  assert.equal(world.outcome, 'lost');

  const inverted = new World({ ...firstLevel, tiles, gravity: -1 });
  repeat(inverted, idleInput, 200);
  assert.equal(inverted.outcome, 'active');
  assert.equal(inverted.snapshot().player.y, 0);
  inverted.step({ ...idleInput, jump: true });
  assert.ok(inverted.snapshot().player.y > 0);
});

function zeroGravityLevel(blocks, spawn = { x: 5, y: 4 }) {
  const tiles = firstLevel.tiles.map((row, y) =>
    Array.from(row, (_, x) => blocks.some(([dx, dy]) => x === spawn.x + dx && y === spawn.y + dy) ? '#' : '.').join(''));
  return { ...firstLevel, tiles, spawn, gravity: 0 };
}

test('zero-gravity jumps use solids in down, up, left, right priority order', () => {
  for (const [blocks, dy] of [
    [[], -1],
    [[[0, 1]], -1],
    [[[0, -1]], 1],
    [[[-1, 0]], -1],
    [[[1, 0]], 1],
    [[[0, 1], [1, 0]], -1],
    [[[0, -1], [-1, 0]], 1],
    [[[-1, 0], [1, 0]], -1],
    [[[0, 1], [0, -1]], 0],
    [[[-1, -1], [1, 1]], -1],
  ]) {
    const world = new World(zeroGravityLevel(blocks));
    runActions(world, { key: 'jump' });
    const { x, y } = world.snapshot().player;
    near(x, 5);
    near(y, 4 + dy * Math.sqrt(48) / 100);
  }
});

test('zero-gravity jumps also use the side walls and roof as supports', () => {
  const { columns, rows } = gridSize(firstLevel.tiles);
  for (const [x, y, blocks, dy] of [
    [0, 4, [], -1],
    [columns - 1, 4, [], 1],
    [5, 0, [], 1],
    [0, 0, [], 1],
    [columns - 1, 0, [], 1],
    [columns - 1, 4, [[0, 1]], -1],
    [0, 4, [[0, -1]], 1],
    [5, rows - 1, [], -1],
  ]) {
    const world = new World(zeroGravityLevel(blocks, { x, y }));
    runActions(world, { key: 'jump' });
    const { player } = world.snapshot();
    near(player.x, x);
    near(player.y, y + dy * Math.sqrt(48) / 100);
  }
});

test('a downward jump from right support continues until the next support restores jumping', () => {
  const level = { ...zeroGravityLevel([[1, 0], [0, 3]]), inertia: 0 };
  const world = new World(level);
  const jump = { ...idleInput, jump: true };
  world.step({ ...jump, direction: -1 });
  const { x } = world.snapshot().player;
  near(x, 5 - 0.0004);
  near(world.snapshot().player.y, 4 + Math.sqrt(48) / 100);
  const restored = new World(level, JSON.parse(JSON.stringify(world.save())));
  for (const state of [world, restored]) {
    assert.equal(state.save().canJump, false);
    state.step(jump);
    near(state.snapshot().player.x, x);
    near(state.snapshot().player.y, 4 + 2 * Math.sqrt(48) / 100);
    repeat(state, idleInput, 50);
    near(state.snapshot().player.y, 6);
    assert.equal(state.save().canJump, true);
    state.step(jump);
    near(state.snapshot().player.x, x);
    near(state.snapshot().player.y, 6 - Math.sqrt(48) / 100);
  }
  assert.deepEqual(restored.save(), world.save());
});

test('zero gravity allows one upward jump after spawning unsupported or moving off a platform', () => {
  const jump = { ...idleInput, jump: true };
  for (const blocks of [[], [[0, 1]]]) {
    const world = new World(zeroGravityLevel(blocks));
    runActions(world, { key: 'moveRight', value: 2 });
    near(world.snapshot().player.y, 4);
    world.step(jump);
    near(world.snapshot().player.y, 4 - Math.sqrt(48) / 100);
    assert.equal(world.save().canJump, false);
    repeat(world, idleInput, 60);
    near(world.snapshot().player.y, 0);
    assert.equal(world.save().canJump, true);
    world.step(jump);
    near(world.snapshot().player.y, Math.sqrt(48) / 100);
    assert.equal(world.save().canJump, false);
  }
});

test('scene orientation and button artwork stay the same under any gravity', () => {
  const gradient = { addColorStop() {} };
  function draw(gravity, outcome) {
    const rectangles = [];
    const context = {
      setTransform() {}, createLinearGradient: () => gradient,
      beginPath() {}, roundRect() {}, fill() {},
      fillRect(...coordinates) { rectangles.push([this.fillStyle, ...coordinates]); },
    };
    const canvas = { style: { getPropertyValue() {}, setProperty() {} }, getContext: () => context };
    drawScene(canvas, {
      level: { ...firstLevel, gravity }, player: { ...firstLevel.spawn, facing: 1 }, outcome,
    }, { pixelHeight: 512 });
    return rectangles;
  }
  for (const outcome of ['active', 'won']) {
    const original = draw(1, outcome);
    assert.deepEqual(draw(-1, outcome), original);
    assert.deepEqual(draw(0, outcome), original);
  }
});

test('all three map presets round-trip with a supported goal and a valid spawn', () => {
  const builtIn = readLevel(JSON.parse(readFileSync(new URL('../levels/definitions/05-trust.json', import.meta.url))));
  assert.deepEqual(gridSize(builtIn.tiles), { rows: 10, columns: 15 });
  for (const { rows, columns } of gridSizes) {
    const board = resizeLevel(builtIn, rows, columns);
    assert.deepEqual(gridSize(board.tiles), { rows, columns });
    assert.deepEqual(importLevel(exportLevel(board)), board);
    const world = new World(board);
    repeat(world, right, 800);
    assert.equal(world.outcome, 'won');
  }
});

test('recorded keyboard inputs replay exactly, and invalid sequences are rejected as a unit', () => {
  const left = { direction: -1, jump: false };
  const inputs = [
    ...Array(36).fill(right), { ...right, jump: true },
    ...Array(29).fill(right), ...Array(5).fill(left), ...Array(63).fill(idleInput),
  ];
  const initial = new World(firstLevel);
  const recorder = new Recorder();
  for (let index = 0; index < 19; index++) recorder.record(idleInput);
  assert.deepEqual(recorder.actions(), []);
  const snapshots = inputs.map((step) => {
    recorder.record(step);
    initial.step(step);
    return initial.snapshot();
  });
  const replay = new World(firstLevel);
  assert.deepEqual(compileActions({ actions: recorder.actions() }).map((step) => {
    replay.step(step);
    return replay.snapshot();
  }), snapshots);
  assert.throws(() => compileActions({ actions: [{ key: 'moveRight', value: 5 }, { key: 'sleep', value: 0.0001 }] }));
  assert.throws(() => compileActions({ actions: [{ key: 'moveRight', value: 1, hold: 1 }] }));
  assert.throws(() => compileActions({ actions: Array(5).fill({ key: 'moveRight', value: 24 }) }), /30 秒/);
  assert.throws(() => compileActions({ actions: Array(4).fill({ key: 'sleep', value: 10 }) }), /30 秒/);
});

test('JSON round trips and rejects invalid maps and unsupported buttons', () => {
  const json = exportLevel(firstLevel);
  assert.deepEqual(importLevel(json), firstLevel);
  assert.throws(() => importLevel(`${json}{}`));
  assert.throws(() => importLevel(JSON.stringify({ ...firstLevel, extra: true })), /未知字段/);
  assert.throws(() => importLevel(json.replace('################', '############.###')), /支撑|实心块/);
});

const inertiaLevel = { ...firstLevel, spawn: { x: 7, y: 7 }, inertia: 5 };
const moveRight = (value) => ({ key: 'moveRight', value });
const moveLeft = (value) => ({ key: 'moveLeft', value });
const sleep = (value) => ({ key: 'sleep', value });
const x = (world) => world.snapshot().player.x;

test('normal motion accelerates over the first tile and then holds its speed', () => {
  const world = new World(inertiaLevel);
  repeat(world, right, 25);
  near(x(world), 7.25);
  repeat(world, right, 25);
  near(x(world), 8);
  repeat(world, right, 25);
  near(x(world), 9);
});

test('slide distance scales with short moves and slide speed decays to zero', () => {
  const world = new World(inertiaLevel);
  runActions(world, moveRight(0.2));
  near(x(world), 7.2);
  repeat(world, idleInput, 1);
  const initial = x(world) - 7.2;
  assert.ok(initial > 0 && initial < 0.02);
  repeat(world, idleInput, 1);
  assert.ok(x(world) - 7.2 - initial < initial);
  repeat(world, idleInput, 150);
  near(x(world), 8.2);
  assert.equal(world.save().slideRemaining, 0);

  const split = new World(inertiaLevel);
  runActions(split, moveRight(0.07), moveRight(0.13), sleep(2));
  near(x(split), 8.2);

  for (const distance of [1, 2]) {
    const full = new World({ ...inertiaLevel, spawn: { x: 2, y: 7 } });
    runActions(full, moveRight(distance), sleep(3));
    near(x(full), 2 + distance + 5);
  }
});

test('reverse commands cancel the remaining slide before moving in the opposite direction', () => {
  const stop = new World(inertiaLevel);
  runActions(stop, moveRight(2), moveLeft(5), sleep(3));
  near(x(stop), 9);

  const partial = new World(inertiaLevel);
  runActions(partial, moveRight(2), moveLeft(3));
  near(x(partial), 9);
  near(partial.save().slideRemaining, 2);
  repeat(partial, idleInput, 1);
  const speed = 4 * Math.sqrt(2 / 5);
  near(x(partial), 9 + speed * 0.01 - 0.8 * 0.01 ** 2);
  repeat(partial, idleInput, 250);
  near(x(partial), 11);

  const reverse = new World(inertiaLevel);
  runActions(reverse, moveRight(2), moveLeft(6));
  near(x(reverse), 8);
  runActions(reverse, sleep(3));
  near(x(reverse), 3);
});

test('commands can cancel a slide after waiting and reverse away from a wall', () => {
  const waited = new World(inertiaLevel);
  runActions(waited, moveRight(2), sleep(0.5));
  near(x(waited), 10.8);
  near(waited.save().slideRemaining, 3.2);
  runActions(waited, moveLeft(1.2));
  near(waited.save().slideRemaining, 2);
  runActions(waited, moveLeft(2), sleep(3));
  near(x(waited), 10.8);

  const tiles = [...inertiaLevel.tiles];
  tiles[7] = '.........#..B...';
  const wall = new World({ ...inertiaLevel, tiles });
  runActions(wall, moveRight(2), moveLeft(1));
  near(x(wall), 7);
});

test('restoring a checkpoint resumes position, jump and inertia on an identical map', () => {
  const world = new World(firstLevel);
  repeat(world, right, 10);
  world.step({ ...right, jump: true });
  const accelerating = new World(firstLevel, JSON.parse(JSON.stringify(world.save())));
  world.step(right);
  accelerating.step(right);
  assert.deepEqual(accelerating.save(), world.save());
  repeat(world, idleInput, 3);
  const restored = new World(firstLevel, JSON.parse(JSON.stringify(world.save())));
  for (let i = 0; i < 80; i++) {
    const input = i < 10 ? right : idleInput;
    assert.equal(restored.step(input), world.step(input));
    assert.deepEqual(restored.save(), world.save());
  }
});

test('legacy checkpoints retain an active slide or a full-speed run', () => {
  const world = new World(inertiaLevel);
  repeat(world, right, 25);
  const { moveDistance, ...legacy } = world.save();
  const running = new World(inertiaLevel, legacy);
  running.step(right);
  near(x(running), 7.29);
  runActions(running, sleep(0.5));
  const { moveDistance: _, ...legacySlide } = running.save();
  const sliding = new World(inertiaLevel, legacySlide);
  runActions(sliding, moveLeft(3.2), sleep(3));
  near(x(sliding), 9.09);
});

test('pausing freezes an in-flight action and resumes it without elapsed time', async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  let frame;
  globalThis.document = doc;
  globalThis.window = new EventTarget();
  globalThis.requestAnimationFrame = (next) => { frame = next; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const runtime = new Runtime(firstLevel, false, () => {}, () => {});
  try {
    const movement = runtime.execute(compileActions({ actions: [moveRight(0.08), moveLeft(0.04)] }));
    frame(0);
    frame(10);
    near(x(runtime.world), 2.0004);
    runtime.setPaused(true);
    frame(10000);
    near(x(runtime.world), 2.0004);
    runtime.setPaused(false);
    frame(20000);
    near(x(runtime.world), 2.0004);
    for (let step = 1; step <= 15; step++) frame(20000 + step * 10);
    await movement;
    near(x(runtime.world), 2.08);
  } finally {
    runtime.dispose();
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
