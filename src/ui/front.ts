import { playableError } from '../level/definition.ts';
import { drawScene } from '../render/scene.ts';
import type { LevelEntry, Progress } from '../storage/game.ts';
import { element, formatDuration } from './elements.ts';

export function renderHome(root: HTMLElement, builtInLevels: LevelEntry[], progress: Progress) {
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
          <a class="scene-action" href="#/levels/custom">创作</a>
          <a class="scene-action" href="#/settings">设置</a>
        </nav>
      </div>
    </section>`;
  const unfinished = builtInLevels.filter(({ id, revision }) => {
    const record = progress.levels[id];
    return record?.revision === revision && record.run;
  }).sort((a, b) => (progress.levels[b.id].savedAt ?? 0) - (progress.levels[a.id].savedAt ?? 0));
  const resume = unfinished.find(({ id }) => id === progress.recentBuiltin) ?? unfinished[0];
  const first = builtInLevels.find(({ id }) => !progress.levels[id]?.completedAt) ?? builtInLevels[0];
  const start = element<HTMLAnchorElement>(root, '[data-start]');
  start.textContent = resume ? '继续游戏' : '开始游戏';
  start.href = `#/play/${resume?.id ?? first.id}`;
}

export function renderLevels(
  root: HTMLElement, levels: LevelEntry[], progress: Progress, custom: boolean,
  warnings: string[], create: () => Promise<void>,
) {
  root.innerHTML = `
    <section class="scene-content levels-scene">
      <a class="scene-back" href="#/">← 主界面</a>
      <h1>选择关卡</h1>
      <div class="levels-toolbar">
        <nav class="level-tabs" aria-label="关卡类型">
          <a class="scene-action" href="#/levels" ${custom ? '' : 'aria-current="page"'}>内置关卡</a>
          <a class="scene-action" href="#/levels/custom" ${custom ? 'aria-current="page"' : ''}>自定义关卡</a>
        </nav>
        ${custom ? '<button class="primary" type="button" data-create-level>创建</button>' : ''}
      </div>
      <p class="invalid levels-notice" role="status" data-level-notice hidden></p>
      <p class="muted levels-notice" data-empty-levels hidden>还没有自定义关卡。</p>
      <div class="level-list" data-level-list></div>
    </section>`;
  const list = element(root, '[data-level-list]');
  if (custom) {
    const createButton = element<HTMLButtonElement>(root, '[data-create-level]');
    const notice = element(root, '[data-level-notice]');
    function showNotice(message: string) {
      notice.textContent = message;
      notice.hidden = !message;
    }
    showNotice(warnings.join('；'));
    element(root, '[data-empty-levels]').hidden = levels.length !== 0;
    createButton.addEventListener('click', async () => {
      createButton.disabled = true;
      try {
        await create();
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '无法创建关卡');
      } finally {
        createButton.disabled = false;
      }
    });
  }
  for (const { id, description, level } of levels) {
    const problem = playableError(level);
    const card = document.createElement('article');
    card.className = 'level-card';
    card.innerHTML = `
      ${custom ? '<a class="scene-action level-edit" data-level-edit>编辑</a>' : ''}
      ${problem ? '<div data-level-content>' : '<a data-level-content>'}
      <canvas width="480" height="270" aria-hidden="true"></canvas>
      <div class="level-caption">
        <div class="level-caption-title"><h2></h2><span data-level-state></span></div>
        <p data-level-description></p>
        <p class="level-best" data-level-best></p><time hidden></time>
      </div>
      ${problem ? '</div>' : '</a>'}`;
    if (!problem) element<HTMLAnchorElement>(card, '[data-level-content]').href = `#/play/${id}`;
    if (custom) {
      const edit = element<HTMLAnchorElement>(card, '[data-level-edit]');
      edit.href = `#/create/${id}`;
      edit.setAttribute('aria-label', `编辑 ${level.name}`);
    }
    element(card, 'h2').textContent = level.name;
    const detail = element(card, '[data-level-description]');
    detail.textContent = problem ?? description ?? '';
    detail.hidden = !detail.textContent;
    const { completedAt, bestDurationMS } = progress.levels[id] ?? {};
    element(card, '[data-level-best]').textContent = `最佳通关耗时 · ${bestDurationMS === undefined ? '暂无记录' : formatDuration(bestDurationMS)}`;
    const state = element(card, '[data-level-state]');
    state.textContent = problem ? '待完善' : completedAt ? '已通关' : '未通关';
    state.classList.toggle('success', Boolean(completedAt) && !problem);
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
