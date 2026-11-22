import { defaultPrompt } from '../agent/agent.ts';
import { findButton, gridSize, gridSizes, playableError, readLevel, resizeLevel } from '../level/definition.ts';
import type { LevelDefinition, Point, Tile } from '../level/definition.ts';
import { exportLevel, importLevel, maxLevelBytes } from '../level/json.ts';
import { drawScene } from '../render/scene.ts';
import { element } from '../ui/elements.ts';
import { mountRun } from '../ui/run.ts';

type Brush = 'solid' | 'button' | 'erase' | 'spawn';
type Stroke = { pointer: number; previous?: Point; original: LevelDefinition; brush: Brush };
type EditorOptions = Pick<Parameters<typeof mountRun>[1], 'model' | 'conversation' | 'openSettings'> & {
  level: LevelDefinition;
  save: (level: LevelDefinition) => Promise<void>;
};

export function mountEditor(root: HTMLElement, options: EditorOptions) {
  const controller = new AbortController();
  const { signal } = controller;
  root.innerHTML = `
    <a class="scene-back" href="#/levels/custom">← 返回关卡列表</a>
    <div class="editor-layout">
      <div class="editor-play" data-editor-play></div>
      <aside class="panel editor-tools" aria-label="关卡编辑">
        <h2>关卡创作</h2>
        <label>关卡名<input data-level-name maxlength="80" required></label>
        <label>地图尺寸（行 × 列）<select data-grid-size></select></label>
        <p class="editor-status" data-status role="status" hidden></p>
        <p class="editor-status" data-save-status aria-live="polite" hidden></p>
        <button type="button" data-retry-save hidden>重试保存</button>
        <div class="editor-tool-title"><h2>画笔</h2><span class="subtle" data-coordinate></span></div>
        <div class="brushes" role="group" aria-label="地图画笔">
          <button type="button" data-brush="solid" aria-pressed="true"><i class="swatch solid"></i>实心块</button>
          <button type="button" data-brush="button" aria-pressed="false"><i class="swatch target"></i>红色按钮</button>
          <button type="button" data-brush="erase" aria-pressed="false"><i class="swatch eraser"></i>橡皮</button>
          <button type="button" data-brush="spawn" aria-pressed="false"><i class="swatch spawn"></i>出生点</button>
        </div>
        <div class="physics-fields">
          <h2>物理参数</h2>
          <label>重力<input data-gravity type="number" min="-10" max="10" step="any" required></label>
          <label>惯性<input data-inertia type="number" min="0" max="10" step="any" required></label>
        </div>
        <button class="prompt-button" type="button" data-open-prompt aria-haspopup="dialog">
          <span>System Prompt</span><span class="subtle" data-prompt-state></span>
        </button>
        <div class="editor-actions">
          <input data-import-file type="file" accept=".json,application/json" hidden>
          <button type="button" data-import>导入 JSON</button>
          <button type="button" data-export>导出 JSON</button>
        </div>
      </aside>
    </div>
    <dialog class="prompt-dialog" aria-labelledby="prompt-title" data-prompt-dialog>
      <div class="dialog-header">
        <h2 id="prompt-title">System Prompt <span class="subtle" data-prompt-mode></span></h2>
        <form method="dialog"><button class="icon-button" aria-label="关闭 System Prompt">×</button></form>
      </div>
      <textarea aria-labelledby="prompt-title" data-prompt maxlength="4096" rows="13" readonly></textarea>
      <div class="dialog-actions">
        <button type="button" data-reset-prompt>重置</button>
        <button type="button" class="primary" data-edit-prompt>编辑</button>
        <button type="button" class="primary" data-save-prompt hidden>保存</button>
      </div>
    </dialog>`;

  const coordinate = element(root, '[data-coordinate]');
  const status = element(root, '[data-status]');
  const saveStatus = element(root, '[data-save-status]');
  const retrySave = element<HTMLButtonElement>(root, '[data-retry-save]');
  const name = element<HTMLInputElement>(root, '[data-level-name]');
  const size = element<HTMLSelectElement>(root, '[data-grid-size]');
  const promptDialog = element<HTMLDialogElement>(root, '[data-prompt-dialog]');
  const prompt = element<HTMLTextAreaElement>(promptDialog, '[data-prompt]');
  const promptState = element(root, '[data-prompt-state]');
  const promptMode = element(promptDialog, '[data-prompt-mode]');
  const editPrompt = element<HTMLButtonElement>(promptDialog, '[data-edit-prompt]');
  const savePrompt = element<HTMLButtonElement>(promptDialog, '[data-save-prompt]');
  const resetPrompt = element<HTMLButtonElement>(promptDialog, '[data-reset-prompt]');
  const gravity = element<HTMLInputElement>(root, '[data-gravity]');
  const inertia = element<HTMLInputElement>(root, '[data-inertia]');
  const file = element<HTMLInputElement>(root, '[data-import-file]');
  const exportButton = element<HTMLButtonElement>(root, '[data-export]');
  const brushes = root.querySelectorAll<HTMLButtonElement>('[data-brush]');

  let draft = options.level;
  let brush: Brush = 'solid';
  let hover: Point | undefined;
  let stroke: Stroke | undefined;
  let fieldError = '';
  let notice = '';
  let saveNumber = 0;
  let scenePaused = false;

  const view = mountRun(element(root, '[data-editor-play]'), {
    ...options,
    editor: {
      draw(canvas, snapshot) {
        drawScene(canvas, {
          ...snapshot, level: draft, outcome: stroke ? 'active' : snapshot.outcome,
        }, { hover, spawn: draft.spawn });
      },
    },
  });
  const { canvas } = view;
  canvas.setAttribute('aria-label', '游戏画面和地图编辑网格');

  function refresh() {
    const { rows, columns } = gridSize(draft.tiles);
    const problem = fieldError || playableError(draft);
    exportButton.disabled = Boolean(problem);
    status.textContent = [problem, notice].filter(Boolean).join(' · ');
    status.hidden = !status.textContent;
    status.classList.toggle('invalid', Boolean(problem));
    coordinate.textContent = hover ? `(${hover.x}, ${hover.y})` : `${rows} × ${columns}`;
    view.redraw();
  }

  function persist() {
    view.updateLevel(draft);
    const number = ++saveNumber;
    saveStatus.hidden = false;
    saveStatus.classList.remove('invalid');
    saveStatus.textContent = '正在保存…';
    retrySave.hidden = true;
    void options.save(draft).then(() => {
      if (signal.aborted || number !== saveNumber) return;
      saveStatus.hidden = true;
    }, (error: unknown) => {
      if (signal.aborted || number !== saveNumber) return;
      saveStatus.textContent = error instanceof Error ? error.message : '无法保存关卡';
      saveStatus.classList.add('invalid');
      retrySave.hidden = false;
    });
  }

  retrySave.addEventListener('click', persist, { signal });

  function loadFields() {
    name.value = draft.name;
    showPrompt(false);
    gravity.value = String(draft.gravity);
    inertia.value = String(draft.inertia);
    loadSizes();
    fieldError = '';
  }

  function showPrompt(editing: boolean) {
    const edited = editing || draft.systemPrompt !== undefined;
    prompt.value = draft.systemPrompt ?? defaultPrompt;
    prompt.readOnly = !editing;
    promptMode.textContent = promptState.textContent = edited ? '已编辑' : '内置';
    editPrompt.hidden = editing;
    savePrompt.hidden = !editing;
    resetPrompt.hidden = !edited;
  }

  element(root, '[data-open-prompt]').addEventListener('click', () => {
    showPrompt(false);
    promptDialog.showModal();
    view.setPaused(true);
  }, { signal });
  promptDialog.addEventListener('close', () => {
    if (promptDialog.open) return;
    showPrompt(false);
    view.setPaused(scenePaused);
  }, { signal });
  editPrompt.addEventListener('click', () => {
    showPrompt(true);
    prompt.focus();
  }, { signal });
  savePrompt.addEventListener('click', () => {
    draft = { ...draft, systemPrompt: prompt.value };
    persist();
    showPrompt(false);
    editPrompt.focus();
  }, { signal });
  resetPrompt.addEventListener('click', () => {
    if (draft.systemPrompt !== undefined) {
      draft = { ...draft };
      delete draft.systemPrompt;
      persist();
    }
    showPrompt(false);
    editPrompt.focus();
  }, { signal });

  function loadSizes() {
    const current = gridSize(draft.tiles);
    const sizes = gridSizes.some(({ rows }) => rows === current.rows) ? gridSizes : [{ ...current, label: '旧版' }, ...gridSizes];
    size.replaceChildren(...sizes.map(({ rows, columns, label }) => new Option(`${label} · ${rows} × ${columns}`, String(rows))));
    size.value = String(current.rows);
  }

  function editFields() {
    notice = '';
    try {
      draft = readLevel({ ...draft, name: name.value, gravity: gravity.valueAsNumber, inertia: inertia.valueAsNumber });
      fieldError = '';
      persist();
    } catch (error) {
      fieldError = error instanceof Error ? error.message : '关卡字段无效';
    }
    refresh();
  }

  function pointAt(event: PointerEvent): Point | undefined {
    const { rows, columns } = gridSize(draft.tiles);
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * columns / rect.width);
    const y = Math.floor((event.clientY - rect.top) * rows / rect.height);
    if (x < 0 || x >= columns || y < 0 || y >= rows) return undefined;
    return { x, y };
  }

  function paint({ x, y }: Point, tool: Brush) {
    const row = draft.tiles[y];
    const tile = row[x];
    const atSpawn = x === draft.spawn.x && y === draft.spawn.y;
    if (tool === 'spawn') {
      if (tile === '.') draft = { ...draft, spawn: { x, y } };
      else notice = '出生点只能放在空格中';
      return;
    }
    const next: Tile = tool === 'solid' ? '#' : tool === 'button' ? 'B' : '.';
    if (tile === next) return;
    if ((tool === 'solid' && (atSpawn || tile === 'B')) || (tool === 'button' && (atSpawn || tile !== '.'))) {
      notice = tool === 'solid' ? '请先移开出生点或红色按钮' : '按钮只能放在空格中';
      return;
    }
    const tiles = [...draft.tiles];
    if (tool === 'button') {
      const old = findButton(draft);
      if (old) tiles[old.y] = setTile(tiles[old.y], old.x, '.');
    }
    tiles[y] = setTile(tiles[y], x, next);
    draft = { ...draft, tiles };
  }

  function finishStroke(event: PointerEvent, canceled: boolean) {
    if (!stroke || event.pointerId !== stroke.pointer) return;
    if (canceled) {
      draft = stroke.original;
    } else {
      const point = pointAt(event);
      if (point && stroke.brush === 'spawn') paint(point, 'spawn');
      if (draft !== stroke.original) persist();
    }
    stroke = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    refresh();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || stroke) return;
    const point = pointAt(event);
    if (!point) return;
    canvas.focus({ preventScroll: true });
    const onSpawn = point.x === draft.spawn.x && point.y === draft.spawn.y;
    const tool = onSpawn ? 'spawn' : brush;
    notice = '';
    stroke = { pointer: event.pointerId, previous: point, original: draft, brush: tool };
    canvas.setPointerCapture(event.pointerId);
    hover = point;
    if (tool !== 'spawn') paint(point, tool);
    refresh();
  }, { signal });
  canvas.addEventListener('pointermove', (event) => {
    hover = pointAt(event);
    if (hover && stroke?.pointer === event.pointerId && (stroke.brush === 'solid' || stroke.brush === 'erase')) {
      const previous = stroke.previous ?? hover;
      const dx = hover.x - previous.x;
      const dy = hover.y - previous.y;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      for (let index = 1; index <= distance; index++) {
        paint({ x: previous.x + Math.round(dx * index / distance), y: previous.y + Math.round(dy * index / distance) }, stroke.brush);
      }
      stroke.previous = hover;
    }
    refresh();
  }, { signal });
  canvas.addEventListener('pointerleave', () => { hover = undefined; refresh(); }, { signal });
  canvas.addEventListener('pointerup', (event) => finishStroke(event, false), { signal });
  canvas.addEventListener('pointercancel', (event) => finishStroke(event, true), { signal });
  canvas.addEventListener('lostpointercapture', (event) => finishStroke(event, true), { signal });

  for (const item of brushes) {
    item.addEventListener('click', () => {
      brush = item.dataset.brush as Brush;
      for (const option of brushes) option.setAttribute('aria-pressed', String(option === item));
    }, { signal });
  }
  for (const input of [name, gravity, inertia]) input.addEventListener('input', editFields, { signal });
  size.addEventListener('change', () => {
    const next = gridSizes.find(({ rows }) => String(rows) === size.value);
    if (!next) return;
    const current = gridSize(draft.tiles);
    const cut = draft.tiles.some((row, y) => {
      const moved = y + (draft.gravity < 0 ? 0 : next.rows - current.rows);
      return /[#B]/.test(moved < 0 || moved >= next.rows ? row : row.slice(next.columns));
    });
    if (cut && !window.confirm('缩小地图会裁掉部分方块。应用此尺寸？')) {
      size.value = String(current.rows);
      return;
    }
    draft = resizeLevel(draft, next.rows, next.columns);
    hover = undefined;
    notice = '';
    loadSizes();
    persist();
    refresh();
  }, { signal });
  element(root, '[data-import]').addEventListener('click', () => file.click(), { signal });
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    try {
      if (!/\.json$/i.test(chosen.name) || chosen.size > maxLevelBytes) throw new Error('请选择不超过 64 KiB 的 JSON 文件');
      const level = importLevel(await chosen.text());
      if (signal.aborted) return;
      draft = level;
      loadFields();
      notice = '已导入关卡';
      persist();
    } catch (error) {
      notice = `导入失败：${error instanceof Error ? error.message : '文件不可读'}`;
    }
    if (!signal.aborted) refresh();
  }, { signal });
  exportButton.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportLevel(draft)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'level.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, { signal });
  loadFields();
  refresh();
  return {
    ...view,
    setPaused(paused: boolean) {
      scenePaused = paused;
      if (paused) promptDialog.close();
      view.setPaused(paused || promptDialog.open);
    },
    dispose() {
      controller.abort();
      promptDialog.close();
      view.dispose();
    },
  };
}

function setTile(row: string, x: number, cell: Tile): string {
  return row.slice(0, x) + cell + row.slice(x + 1);
}
