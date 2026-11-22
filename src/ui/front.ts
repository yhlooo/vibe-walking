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
              <rect fill="#f8f3f1" width="1" height="1" rx=".02"/>
              <path fill="#27233e" d="M.49 .3h.085v.2H.49zm.18 0h.085v.2H.67z"/>
            </svg>VIBE
          </span>
          <span>WALKING</span>
        </h1>
        <p>踩下红色按钮</p>
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
  saveOrder: (ids: string[]) => Promise<void>,
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
    if (levels.length > 1) {
      enableLevelSorting(list, createButton, saveOrder, (message) => showNotice(message || warnings.join('；')));
    }
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
    card.dataset.levelId = id;
    card.innerHTML = `
      ${custom && levels.length > 1 ? `
        <button class="scene-action level-drag" type="button" title="拖动排序" data-level-drag aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true" focusable="false">
            <circle cx="6" cy="4" r="1.3"/><circle cx="12" cy="4" r="1.3"/>
            <circle cx="6" cy="9" r="1.3"/><circle cx="12" cy="9" r="1.3"/>
            <circle cx="6" cy="14" r="1.3"/><circle cx="12" cy="14" r="1.3"/>
          </svg>
        </button>` : ''}
      ${custom ? `
        <a class="scene-action level-edit" title="编辑" data-level-edit>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M15 5l4 4M4 20l1-5L16 4a2.8 2.8 0 0 1 4 4L9 19l-5 1z"/>
          </svg>
        </a>` : ''}
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
      card.querySelector('[data-level-drag]')?.setAttribute('aria-label', `调整 ${level.name} 的顺序`);
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
    }, { preview: true, pixelHeight: Math.round(375 * (window.devicePixelRatio || 1)) });
    list.append(card);
  }
}

function enableLevelSorting(
  list: HTMLElement, createButton: HTMLButtonElement,
  saveOrder: (ids: string[]) => Promise<void>, showNotice: (message: string) => void,
) {
  let drag: { from: HTMLElement; target?: HTMLElement; pointer: number; x: number; y: number } | undefined;
  let scrollFrame = 0;

  async function move(from: HTMLElement, target: HTMLElement) {
    if (from === target || createButton.disabled) return;
    const cards = [...list.querySelectorAll<HTMLElement>('[data-level-id]')];
    const start = cards.indexOf(from);
    const end = cards.indexOf(target);
    cards.splice(start, 1);
    cards.splice(end, 0, from);
    createButton.disabled = true;
    list.setAttribute('aria-busy', 'true');
    showNotice('');
    try {
      await saveOrder(cards.map((card) => card.dataset.levelId!));
      const focused = from.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      list.insertBefore(from, start < end ? target.nextSibling : target);
      focused?.focus();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '无法保存关卡顺序');
    } finally {
      createButton.disabled = false;
      list.removeAttribute('aria-busy');
    }
  }

  function updateTarget() {
    if (!drag) return;
    const card = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>('[data-level-id]');
    const target = card && card.parentElement === list && card !== drag.from ? card : undefined;
    if (drag.target === target) return;
    drag.target?.classList.remove('level-drop-target');
    target?.classList.add('level-drop-target');
    drag.target = target;
  }

  function scrollWhileDragging() {
    if (!drag || !list.isConnected) return;
    const edge = 56;
    const delta = Math.max(0, drag.y - window.innerHeight + edge) - Math.max(0, edge - drag.y);
    if (delta) {
      window.scrollBy(0, delta / 4);
      updateTarget();
    }
    scrollFrame = requestAnimationFrame(scrollWhileDragging);
  }

  list.addEventListener('pointerdown', (event) => {
    const handle = (event.target as Element).closest<HTMLButtonElement>('[data-level-drag]');
    if (!handle || event.button !== 0 || drag || createButton.disabled) return;
    const from = handle.parentElement!;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    list.setPointerCapture(event.pointerId);
    drag = { from, pointer: event.pointerId, x: event.clientX, y: event.clientY };
    from.classList.add('level-dragging');
    scrollFrame = requestAnimationFrame(scrollWhileDragging);
  });
  list.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateTarget();
  });

  function finishDrag(event: PointerEvent) {
    if (drag?.pointer !== event.pointerId) return;
    if (event.type === 'pointerup') {
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateTarget();
    }
    const { from, target } = drag;
    drag = undefined;
    cancelAnimationFrame(scrollFrame);
    from.classList.remove('level-dragging');
    target?.classList.remove('level-drop-target');
    if (event.type === 'pointerup' && target) void move(from, target);
  }
  list.addEventListener('pointerup', finishDrag);
  list.addEventListener('lostpointercapture', finishDrag);
  list.addEventListener('keydown', (event) => {
    const handle = (event.target as Element).closest('[data-level-drag]');
    if (!handle || drag || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const previous = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!previous && event.key !== 'ArrowDown' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = handle.parentElement!;
    const target = previous ? from.previousElementSibling : from.nextElementSibling;
    if (target instanceof HTMLElement) void move(from, target);
  });
}
