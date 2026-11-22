import { builtInBoard, builtInLevels } from '../level/builtin.ts';
import { drawScene } from '../render/scene.ts';
import { completion, recentLevel } from '../storage/local.ts';
import { element } from './elements.ts';

export function drawBackdrop(canvas: HTMLCanvasElement) {
  const { level } = builtInLevels[0];
  const tiles = Array<string>(9).fill('.'.repeat(16));
  tiles[5] = '...........###..';
  tiles[7] = '...............B';
  tiles[8] = '#'.repeat(16);
  drawScene(canvas, {
    level: { ...level, tiles }, player: { x: 12, y: 4, facing: 1 }, outcome: 'active',
  });
}

export function renderHome(root: HTMLElement) {
  root.innerHTML = `
    <section class="home-scene">
      <div class="home-content">
        <h1>VIBE<br>WALKING</h1>
        <p>用对话引导 Agent 踩下红色按钮。</p>
        <nav class="home-actions" aria-label="主界面">
          <a class="scene-action primary" data-start></a>
          <a class="scene-action" href="#/levels">选择关卡</a>
          <a class="scene-action" href="#/create">创作</a>
          <a class="scene-action" href="#/settings">设置</a>
        </nav>
      </div>
    </section>`;
  const last = recentLevel();
  const unfinished = builtInLevels.find(({ id }) => id === last && !completion(id));
  const first = builtInLevels.find(({ id }) => !completion(id)) ?? builtInLevels[0];
  const start = element<HTMLAnchorElement>(root, '[data-start]');
  start.textContent = unfinished ? '继续游戏' : '开始游戏';
  start.href = `#/play/${unfinished?.id ?? first.id}`;
}

export function renderLevels(root: HTMLElement, size: { rows: number; columns: number }) {
  root.innerHTML = `
    <section class="scene-content levels-scene">
      <a class="scene-back" href="#/">← 主界面</a>
      <h1>选择关卡</h1>
      <div class="level-list" data-level-list></div>
    </section>`;
  const list = element(root, '[data-level-list]');
  for (const { id, name, description, level } of builtInLevels) {
    const board = builtInBoard(level, size.rows, size.columns);
    const card = document.createElement('a');
    card.href = `#/play/${id}`;
    card.className = 'level-card';
    card.innerHTML = `
      <canvas width="480" height="270" aria-hidden="true"></canvas>
      <div class="level-caption">
        <div class="level-caption-title"><h2></h2><span data-level-state></span></div>
        <p data-level-description></p><time hidden></time>
      </div>`;
    element(card, 'h2').textContent = name;
    element(card, '[data-level-description]').textContent = description;
    const completedAt = completion(id);
    const state = element(card, '[data-level-state]');
    state.textContent = completedAt ? '已通关' : '未通关';
    state.classList.toggle('success', Boolean(completedAt));
    if (completedAt) {
      const time = element<HTMLTimeElement>(card, 'time');
      time.dateTime = completedAt;
      time.textContent = `首次通关 · ${new Date(completedAt).toLocaleString()}`;
      time.hidden = false;
    }
    drawScene(element<HTMLCanvasElement>(card, 'canvas'), {
      level: board, player: { ...board.spawn, facing: 1 }, outcome: 'active',
    });
    list.append(card);
  }
}
