import { protocols, readSettings, saveSettings } from './agent/settings.ts';
import type { ModelSettings, Protocol } from './agent/settings.ts';
import type { Conversation } from './agent/agent.ts';
import { mountEditor } from './editor/editor.ts';
import { builtInBoard, builtInLevels } from './level/builtin.ts';
import { gridSizes } from './level/definition.ts';
import type { LevelDefinition } from './level/definition.ts';
import { completion, loadDraft, markCompleted, playGridSize, rememberLevel, saveDraft, savePlayGridSize } from './storage/local.ts';
import { element } from './ui/elements.ts';
import { drawBackdrop, renderHome, renderLevels } from './ui/front.ts';
import { mountRun } from './ui/run.ts';
import './style.css';

const app = element(document, '#app');
app.innerHTML = `
  <a class="corner-control brand-mark" href="#/" aria-label="返回主界面"></a>
  <button type="button" class="corner-control menu-toggle" aria-label="游戏菜单" aria-haspopup="dialog" data-menu-toggle><span aria-hidden="true"></span></button>
  <canvas class="scene-backdrop" width="960" height="540" aria-hidden="true" data-backdrop></canvas>
  <main class="workspace">
    <div data-workspace></div>
    <section class="scene-content settings-scene" data-settings-scene hidden>
      <a class="scene-back" href="#/" data-settings-back>← 返回</a>
      <h1>设置</h1>
      <section class="settings-form">
        <h2>游戏画面</h2>
        <label>内置关卡地图尺寸（行 × 列）<select data-play-size></select></label>
        <p class="settings-status" role="status" data-size-status hidden></p>
      </section>
      <form class="settings-form" data-settings-form>
        <h2>模型连接</h2>
        <fieldset>
          <label>协议<select data-protocol></select></label>
          <label>Base URL<input type="url" autocomplete="off" placeholder="https://api.openai.com/v1" data-base-url required></label>
          <label>模型 ID<input type="text" autocomplete="off" data-model-id required></label>
          <label>API Key<input type="password" autocomplete="off" data-api-key></label>
          <label class="checkbox" data-remove-label hidden><input type="checkbox" data-remove-key>移除已保存的密钥</label>
        </fieldset>
        <p class="settings-status" role="status" data-settings-status hidden></p>
        <div class="dialog-actions"><button type="button" data-clear-settings>清除连接</button><button type="submit" class="primary">保存</button></div>
      </form>
    </section>
  </main>
  <dialog class="pause-menu" aria-labelledby="menu-title" data-menu>
    <div class="dialog-header">
      <h2 id="menu-title">游戏菜单</h2>
      <form method="dialog"><button class="icon-button" aria-label="关闭菜单">×</button></form>
    </div>
    <nav class="pause-actions" aria-label="游戏菜单">
      <button type="button" class="primary" data-resume hidden>继续游戏</button>
      <button type="button" data-menu-reset hidden>重置关卡</button>
      <a class="scene-action" href="#/">主界面</a>
      <a class="scene-action" href="#/levels">选择关卡</a>
      <a class="scene-action" href="#/create">创作</a>
      <a class="scene-action" href="#/settings">设置</a>
    </nav>
  </dialog>`;

const workspace = element(app, '[data-workspace]');
const backdrop = element<HTMLCanvasElement>(app, '[data-backdrop]');
const menu = element<HTMLDialogElement>(app, '[data-menu]');
const menuTitle = element(menu, '#menu-title');
const resumeButton = element<HTMLButtonElement>(menu, '[data-resume]');
const resetButton = element<HTMLButtonElement>(menu, '[data-menu-reset]');
const settingsScene = element(app, '[data-settings-scene]');
const settingsBack = element<HTMLAnchorElement>(settingsScene, '[data-settings-back]');
const playSizeSelect = element<HTMLSelectElement>(settingsScene, '[data-play-size]');
const sizeStatus = element(settingsScene, '[data-size-status]');
const settingsForm = element<HTMLFormElement>(settingsScene, 'form');
const settingsFields = element<HTMLFieldSetElement>(settingsForm, 'fieldset');
const protocolInput = element<HTMLSelectElement>(settingsForm, '[data-protocol]');
const addressInput = element<HTMLInputElement>(settingsForm, '[data-base-url]');
const modelInput = element<HTMLInputElement>(settingsForm, '[data-model-id]');
const keyInput = element<HTMLInputElement>(settingsForm, '[data-api-key]');
const removeLabel = element<HTMLLabelElement>(settingsForm, '[data-remove-label]');
const removeKey = element<HTMLInputElement>(settingsForm, '[data-remove-key]');
const settingsStatus = element(settingsForm, '[data-settings-status]');
const clearSettings = element<HTMLButtonElement>(settingsForm, '[data-clear-settings]');
const submitSettings = element<HTMLButtonElement>(settingsForm, 'button[type="submit"]');

for (const [protocol, { label }] of Object.entries(protocols)) protocolInput.add(new Option(label, protocol));
for (const { rows, columns, label } of gridSizes) playSizeSelect.add(new Option(`${label} · ${rows} × ${columns}`, String(rows)));
drawBackdrop(backdrop);

const firstLevel = builtInLevels[0];
let draft = loadDraft(firstLevel.level);
let model: ModelSettings | null = null;
let playSize = playGridSize();
let activeRun: ReturnType<typeof mountRun> | undefined;
let activeBoard: LevelDefinition | undefined;
const conversations = new Map<string, Conversation>();
let mountedRoute = '';
let settingsRequest = 0;
let saving = false;

function disposeScene() {
  activeRun?.dispose();
  activeRun = undefined;
  activeBoard = undefined;
}

function conversationFor(id: string): Conversation {
  let conversation = conversations.get(id);
  if (!conversation) {
    conversation = { events: [], history: [] };
    conversations.set(id, conversation);
  }
  return conversation;
}

function openSettings() {
  location.hash = '#/settings';
}

function renderRoute() {
  const route = location.hash || '#/';
  menu.close();
  if (route === '#/settings') {
    if (!settingsScene.hidden) return;
    settingsBack.href = mountedRoute || '#/';
    playSizeSelect.value = String(playSize.rows);
    sizeStatus.hidden = true;
    settingsScene.hidden = false;
    workspace.hidden = true;
    backdrop.hidden = false;
    syncPause();
    settingsMessage('');
    fillSettings();
    focusTitle(settingsScene);
    void loadSettings(true);
    return;
  }
  if (!settingsScene.hidden) {
    settingsScene.hidden = true;
    workspace.hidden = false;
    keyInput.value = '';
    syncPause();
    if (mountedRoute === route) {
      backdrop.hidden = Boolean(activeRun) || route === '#/create';
      if (route === '#/levels') renderLevels(workspace, playSize);
      focusTitle(workspace);
      return;
    }
  }
  if (route === '#/create') {
    renderEditor();
  } else if (route === '#/play' || route.startsWith('#/play/')) {
    const level = builtInLevels.find(({ id }) => route === `#/play/${id}`) ?? firstLevel;
    rememberLevel(level.id);
    renderRun(level.level, level.id);
  } else {
    disposeScene();
    backdrop.hidden = false;
    const isLevels = route === '#/levels';
    if (isLevels) renderLevels(workspace, playSize);
    else renderHome(workspace);
  }
  mountedRoute = route;
  focusTitle(workspace);
}

function focusTitle(root: HTMLElement) {
  const heading = root.querySelector('h1');
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function renderEditor() {
  disposeScene();
  backdrop.hidden = true;
  activeRun = mountEditor(workspace, {
    level: draft, model, conversation: conversationFor('create'), openSettings,
    save(level) {
      draft = level;
      saveDraft(level);
    },
  });
}

function renderRun(level: LevelDefinition, id: string) {
  disposeScene();
  backdrop.hidden = true;
  activeBoard = level;
  activeRun = mountRun(workspace, {
    level: builtInBoard(level, playSize.rows, playSize.columns), model, conversation: conversationFor(`play/${id}`),
    completedAt: completion(id),
    onComplete: () => markCompleted(id),
    openSettings,
  });
}

function syncPause() {
  activeRun?.setPaused(menu.open || !settingsScene.hidden);
}

function openMenu() {
  const run = settingsScene.hidden ? activeRun : undefined;
  menuTitle.textContent = run ? '游戏已暂停' : '游戏菜单';
  resumeButton.hidden = resetButton.hidden = !run;
  menu.showModal();
  syncPause();
}

function applySettings(next: ModelSettings | null, reset = false) {
  const changed = next?.api !== model?.api || next?.baseURL !== model?.baseURL ||
    next?.model !== model?.model || next?.hasAPIKey !== model?.hasAPIKey;
  model = next;
  if (changed || reset) activeRun?.onModelChange(next);
}

function settingsMessage(text: string, error = false) {
  settingsStatus.textContent = text;
  settingsStatus.hidden = !text;
  settingsStatus.classList.toggle('invalid', error);
}

function updateKeyHint() {
  const sameEndpoint = model?.api === protocolInput.value &&
    model.baseURL === addressInput.value.trim().replace(/\/+$/, '');
  const retainsKey = Boolean(sameEndpoint && model?.hasAPIKey);
  keyInput.placeholder = retainsKey ? '已保存，留空可保留' : '输入模型 API Key';
  removeLabel.hidden = !retainsKey;
  if (!retainsKey) removeKey.checked = false;
}

function fillSettings() {
  const api = model?.api ?? 'OpenAIResponses';
  protocolInput.value = api;
  addressInput.value = model?.baseURL ?? protocols[api].baseURL;
  modelInput.value = model?.model ?? '';
  keyInput.value = '';
  removeKey.checked = false;
  clearSettings.hidden = !model;
  updateKeyHint();
}

function lockSettings(locked: boolean) {
  settingsFields.disabled = submitSettings.disabled = clearSettings.disabled = locked;
}

async function loadSettings(inScene: boolean) {
  const request = ++settingsRequest;
  if (inScene) lockSettings(true);
  try {
    const next = await readSettings(AbortSignal.timeout(5000));
    if (request !== settingsRequest) return;
    applySettings(next);
    if (inScene && !settingsScene.hidden) fillSettings();
  } catch {
    if (request === settingsRequest && inScene) settingsMessage('无法读取模型设置', true);
  } finally {
    if (request === settingsRequest && inScene) lockSettings(false);
  }
}

async function commitSettings(value: Parameters<typeof saveSettings>[0]) {
  if (saving) return;
  saving = true;
  settingsRequest++;
  lockSettings(true);
  settingsMessage('');
  try {
    applySettings(await saveSettings(value, AbortSignal.timeout(10000)), true);
    fillSettings();
    settingsMessage(value ? '设置已保存' : '已清除模型连接');
  } catch (error) {
    settingsMessage(error instanceof Error && error.name !== 'TimeoutError' ? error.message : '保存模型设置超时', true);
  } finally {
    saving = false;
    lockSettings(false);
  }
}

element(app, '[data-menu-toggle]').addEventListener('click', openMenu);
menu.addEventListener('close', syncPause);
resumeButton.addEventListener('click', () => menu.close());
resetButton.addEventListener('click', () => {
  menu.close();
  activeRun?.reset();
});
menu.addEventListener('click', (event) => {
  const link = event.target instanceof Element && event.target.closest('a');
  if (!link) return;
  menu.close();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || menu.open) return;
  event.preventDefault();
  if (settingsScene.hidden) openMenu();
  else location.hash = settingsBack.hash;
});
protocolInput.addEventListener('change', () => {
  addressInput.value = protocols[protocolInput.value as Protocol].baseURL;
  keyInput.value = '';
  updateKeyHint();
});
playSizeSelect.addEventListener('change', () => {
  const size = gridSizes.find(({ rows }) => String(rows) === playSizeSelect.value);
  if (!size || size === playSize) return;
  playSize = size;
  sizeStatus.hidden = true;
  try {
    savePlayGridSize(size.rows);
  } catch {
    sizeStatus.textContent = '浏览器无法保存地图尺寸，本次游戏中仍然生效';
    sizeStatus.hidden = false;
  }
  if (activeBoard) activeRun?.updateLevel(builtInBoard(activeBoard, size.rows, size.columns));
});
addressInput.addEventListener('input', updateKeyHint);
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const apiKey = keyInput.value.trim();
  void commitSettings({
    api: protocolInput.value as Protocol, baseURL: addressInput.value.trim(), model: modelInput.value.trim(),
    ...(removeKey.checked ? { apiKey: '' } : apiKey ? { apiKey } : {}),
  });
});
clearSettings.addEventListener('click', () => { void commitSettings(null); });
window.addEventListener('hashchange', renderRoute);
renderRoute();
if (settingsScene.hidden) void loadSettings(false);
