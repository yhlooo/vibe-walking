import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileActions, Recorder } from '../src/game/actions.ts';
import { Runtime } from '../src/game/runtime.ts';
import { idleInput, movePerStep, World } from '../src/game/world.ts';
import { gridSize, gridSizes, playableError, readLevel, resizeLevel } from '../src/level/definition.ts';
import { exportLevel, importLevel } from '../src/level/yaml.ts';

const firstLevel = readLevel(JSON.parse(readFileSync(new URL('./fixtures/legacy-level.json', import.meta.url))));
const right = { direction: 1, jump: false, distance: movePerStep };

function repeat(world, input, count) {
  for (let index = 0; index < count; index++) world.step(input);
}

test('a level stops at positive overlap with the supported button', () => {
  const world = new World(firstLevel);
  for (const step of compileActions({ actions: [{ key: 'moveRight', value: 10 }] })) world.step(step);
  const { player, outcome } = world.snapshot();
  assert.equal(outcome, 'won');
  assert.ok(player.x > 11 && player.x < 11.05);
  assert.equal(player.y, 7);
  world.step({ ...right, jump: true });
  assert.deepEqual(world.snapshot().player, player);
});

test('jumping over the button leaves it unpressed, while inverted support can be pressed', () => {
  const world = new World(firstLevel);
  repeat(world, right, 222);
  world.step({ ...right, jump: true });
  repeat(world, right, 102);
  assert.equal(world.outcome, 'active');
  assert.equal(world.snapshot().player.y, 7);
  assert.ok(world.snapshot().player.x >= 14);

  const ceiling = readLevel({ ...firstLevel, gravity: -1, tiles: [...firstLevel.tiles].reverse(), spawn: { x: 2, y: 1 } });
  assert.equal(playableError(ceiling), undefined);
  const inverted = new World(ceiling);
  repeat(inverted, right, 250);
  assert.equal(inverted.outcome, 'won');
  assert.equal(inverted.snapshot().player.y, 1);
});

test('blocked moves run for their commanded distance, then a jump can cross the block', () => {
  const tiles = [...firstLevel.tiles];
  tiles[7] = '.....#......B...';
  const world = new World(readLevel({ ...firstLevel, tiles }));
  const steps = compileActions({ actions: [{ key: 'moveRight', value: 6.01 }] });
  assert.equal(steps.length, 151);
  assert.equal(steps.at(-1).distance, 0.01);
  for (const step of steps) world.step(step);
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
    repeat(state, right, 28);
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

test('all three map presets round-trip with a supported goal and a valid spawn', () => {
  const builtIn = readLevel(JSON.parse(readFileSync(new URL('../levels/definitions/0001-walk-to-button.json', import.meta.url))));
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
  const inputs = [
    ...Array(36).fill(right), { ...right, jump: true },
    ...Array(29).fill(right), ...Array(63).fill(idleInput),
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
  assert.throws(() => compileActions({ actions: Array(4).fill({ key: 'sleep', value: 10 }) }), /30 秒/);
});

test('YAML round trips and rejects duplicate keys, aliases and invalid button support', () => {
  const yaml = exportLevel(firstLevel);
  assert.deepEqual(importLevel(yaml), firstLevel);
  assert.throws(() => importLevel(`${yaml}\nname: duplicate`));
  assert.throws(() => importLevel('name: &first example\nsystemPrompt: *first'));
  assert.throws(() => importLevel(yaml.replace('################', '############.###')), /支撑|实心块/);
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
    const movement = runtime.execute(compileActions({ actions: [{ key: 'moveRight', value: 0.08 }] }));
    frame(0);
    frame(10);
    assert.equal(runtime.world.snapshot().player.x, 2.04);
    runtime.setPaused(true);
    frame(10000);
    assert.equal(runtime.world.snapshot().player.x, 2.04);
    runtime.setPaused(false);
    frame(20000);
    assert.equal(runtime.world.snapshot().player.x, 2.04);
    frame(20010);
    await movement;
    assert.equal(runtime.world.snapshot().player.x, 2.08);
  } finally {
    runtime.dispose();
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
