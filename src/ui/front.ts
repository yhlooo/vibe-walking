import { builtInLevels } from '../level/builtin.ts';
import { drawScene } from '../render/scene.ts';
import { completion, recentLevel } from '../storage/local.ts';
import { element } from './elements.ts';

export function renderHome(root: HTMLElement) {
  root.innerHTML = `
    <section class="home-scene">
      <div class="home-content">
        <h1>
          <span class="home-title-line">
            <svg class="home-character" viewBox="0 0 1 1" aria-hidden="true" focusable="false">
              <path fill="#f8f3f1" d="M0 0h1v1H0z"/>
              <path fill="#27233e" d="M.49 .3h.085v.2H.49zm.18 0h.085v.2H.67z"/>
            </svg>VIBE
          </span>
          <span>WALKING</span>
        </h1>
        <p>用对话引导 Agent 踩下红色按钮。</p>
        <nav class="home-actions" aria-label="主界面">
          <a class="scene-action primary" data-start></a>
          <a class="scene-action" href="#/levels">关卡</a>
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

export function renderLevels(root: HTMLElement) {
  root.innerHTML = `
    <section class="scene-content levels-scene">
      <a class="scene-back" href="#/">← 主界面</a>
      <h1>选择关卡</h1>
      <div class="level-list" data-level-list></div>
    </section>`;
  const list = element(root, '[data-level-list]');
  for (const { id, name, description, level } of builtInLevels) {
    const card = document.createElement('a');
    card.href = `#/play/${id}`;
    card.className = 'level-card';
    card.innerHTML = `
      <canvas width="480" height="270" aria-hidden="true"></canvas>
      <div class="level-caption">
        <div class="level-caption-title"><h2></h2><span data-level-state></span></div>
        <p data-level-description></p>
        <p class="level-best" data-level-best></p><time hidden></time>
      </div>`;
    element(card, 'h2').textContent = name;
    element(card, '[data-level-description]').textContent = description;
    const { completedAt, bestDurationMS } = completion(id) ?? {};
    element(card, '[data-level-best]').textContent = `最佳通关耗时 · ${bestDurationMS === undefined ? '暂无记录' : formatDuration(bestDurationMS)}`;
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
      level, player: { ...level.spawn, facing: 1 }, outcome: 'active',
    }, undefined, Math.round(375 * (window.devicePixelRatio || 1)));
    list.append(card);
  }
}

function formatDuration(durationMS: number) {
  const seconds = Math.round(durationMS / 100) / 10;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${(seconds % 60).toFixed(1)} 秒` : `${seconds.toFixed(1)} 秒`;
}
