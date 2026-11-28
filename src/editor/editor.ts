import { defaultPrompt } from '../agent/prompts.ts';
import { findButton, gridSize, gridSizes, playableError, readLevel, resizeLevel } from '../level/definition.ts';
import type { LevelDefinition, Point, Tile } from '../level/definition.ts';
import { exportLevel, importLevel, maxLevelBytes } from '../level/json.ts';
import { drawScene } from '../render/scene.ts';
import { element } from '../ui/elements.ts';
import { mountRun } from '../ui/run.ts';

// 列出可应用于编辑网格的画笔。
type Brush = 'solid' | 'button' | 'erase' | 'spawn';

// 跟踪当前指针笔划和取消时用于回滚的草稿。
type Stroke = { pointer: number; previous?: Point; original: LevelDefinition; brush: Brush };

// 接收关卡草稿、保存回调和试玩所需依赖。
type EditorOptions = Pick<Parameters<typeof mountRun>[1], 'catalog' | 'username' | 'conversation' | 'openSettings'> & {
  level: LevelDefinition;
  save: (level: LevelDefinition) => Promise<void>;
};

/** 挂载关卡编辑器，将预览、试玩与草稿持久化连接起来。 */
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
        <label class="read-screen-control"><input type="checkbox" role="switch" data-disable-read-screen>禁用 ReadScreen 工具</label>
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
  const disableReadScreen = element<HTMLInputElement>(root, '[data-disable-read-screen]');
  const file = element<HTMLInputElement>(root, '[data-import-file]');
  const exportButton = element<HTMLButtonElement>(root, '[data-export]');
  const brushes = root.querySelectorAll<HTMLButtonElement>('[data-brush]');

  // 维护草稿和编辑交互的临时状态。
  let draft = options.level;
  let brush: Brush = 'solid';
  let hover: Point | undefined;
  let stroke: Stroke | undefined;
  let fieldError = '';
  let notice = '';
  let saveNumber = 0;
  let scenePaused = false;

  // 复用游玩场景进行试玩，并在画布上叠加编辑辅助信息。
  const view = mountRun(element(root, '[data-editor-play]'), {
    ...options,
    editor: {
      draw(canvas, snapshot) {
        drawScene(canvas, {
          ...snapshot, level: draft, outcome: stroke ? 'active' : snapshot.outcome,
        }, { edit: { hover, spawn: draft.spawn } });
      },
    },
  });
  const { canvas } = view;
  canvas.setAttribute('aria-label', '游戏画面和地图编辑网格');

  // 同步可玩性状态、坐标与画布。
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

  // 将草稿应用到试玩，并让界面只响应最新保存结果。
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

  // 将草稿的字段同步到编辑表单。
  function loadFields() {
    name.value = draft.name;
    showPrompt(false);
    gravity.value = String(draft.gravity);
    inertia.value = String(draft.inertia);
    disableReadScreen.checked = draft.disableReadScreen ?? false;
    loadSizes();
    fieldError = '';
  }

  // 切换提示词的只读或编辑状态和对应按钮。
  function showPrompt(editing: boolean) {
    const edited = editing || draft.systemPrompt !== undefined;
    prompt.value = draft.systemPrompt ?? defaultPrompt;
    prompt.readOnly = !editing;
    promptMode.textContent = promptState.textContent = edited ? '已编辑' : '内置';
    editPrompt.hidden = editing;
    savePrompt.hidden = !editing;
    resetPrompt.hidden = !edited;
  }

  // 打开提示词编辑时暂停试玩，关闭时恢复原暂停状态。
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

  // 列出可选尺寸并兼容当前关卡的旧版尺寸。
  function loadSizes() {
    const current = gridSize(draft.tiles);
    const sizes = gridSizes.some(({ rows }) => rows === current.rows) ? gridSizes : [{ ...current, label: '旧版' }, ...gridSizes];
    size.replaceChildren(...sizes.map(({ rows, columns, label }) => new Option(`${label} · ${rows} × ${columns}`, String(rows))));
    size.value = String(current.rows);
  }

  // 校验名称和物理字段后更新并保存草稿。
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

  // 将指针的屏幕坐标换算为有效网格坐标。
  function pointAt(event: PointerEvent): Point | undefined {
    const { rows, columns } = gridSize(draft.tiles);
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * columns / rect.width);
    const y = Math.floor((event.clientY - rect.top) * rows / rect.height);
    if (x < 0 || x >= columns || y < 0 || y >= rows) return undefined;
    return { x, y };
  }

  // 在指定格子应用画笔，并维护出生点和按钮的位置约束。
  function paint({ x, y }: Point, tool: Brush) {
    const row = draft.tiles[y];
    const tile = row[x];
    const atSpawn = x === draft.spawn.x && y === draft.spawn.y;

    // 出生点只能移到空格；笔划取消时由原草稿恢复。
    // 出生点只能移到空格，笔划取消时由原草稿恢复。
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

    // 移动目标时先清掉原格，保证草稿最多有一个按钮。
    if (tool === 'button') {
      const old = findButton(draft);
      if (old) tiles[old.y] = setTile(tiles[old.y], old.x, '.');
    }
    tiles[y] = setTile(tiles[y], x, next);
    draft = { ...draft, tiles };
  }

  // 结束笔划，提交编辑结果或恢复笔划开始前的草稿。
  function finishStroke(event: PointerEvent, canceled: boolean) {
    // 只有开启当前笔划的指针可以结束它。
    // 只有开启当前笔划的指针可以结束它。
    if (!stroke || event.pointerId !== stroke.pointer) return;

    if (canceled) {
      draft = stroke.original;
    } else {
      const point = pointAt(event);
      if (point && stroke.brush === 'spawn') paint(point, 'spawn');
      if (draft !== stroke.original) persist();
    }
    stroke = undefined;

    // 先清除笔划状态，释放捕获引发的事件随后会直接返回。
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    refresh();
  }

  // 用指针捕获让同一次笔划持续接收移动和结束事件。
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || stroke) return;
    const point = pointAt(event);
    if (!point) return;

    canvas.focus({ preventScroll: true });

    // 按住现有出生点即可拖动，提交位置以松手时的格子为准。
    const onSpawn = point.x === draft.spawn.x && point.y === draft.spawn.y;
    const tool = onSpawn ? 'spawn' : brush;
    notice = '';
    stroke = { pointer: event.pointerId, previous: point, original: draft, brush: tool };
    canvas.setPointerCapture(event.pointerId);
    hover = point;
    if (tool !== 'spawn') paint(point, tool);
    refresh();
  }, { signal });

  // 在笔划前后两次采样之间补齐经过的格子。
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
  disableReadScreen.addEventListener('change', () => {
    draft = { ...draft, disableReadScreen: disableReadScreen.checked };
    persist();
  }, { signal });

  // 调整地图尺寸，裁掉非空内容前提示用户确认。
  size.addEventListener('change', () => {
    const next = gridSizes.find(({ rows }) => String(rows) === size.value);
    if (!next) return;
    const current = gridSize(draft.tiles);

    // 用与实际调整相同的纵向偏移预测会被裁掉的格子。
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

  // 读取并校验导入文件，再以其替换编辑草稿。
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    try {
      if (!/\.json$/i.test(chosen.name) || chosen.size > maxLevelBytes) throw new Error('请选择不超过 64 KiB 的 JSON 文件');

      // 文件读取完成后重新检查编辑器是否仍挂载，再替换草稿。
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

  // 下载当前关卡定义，随后释放对象 URL。
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

// 替换指定行中的一个格子并返回新行。
function setTile(row: string, x: number, cell: Tile): string {
  return row.slice(0, x) + cell + row.slice(x + 1);
}
