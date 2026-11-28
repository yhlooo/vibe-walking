import { defaultMaxInputToken, defaultProtocol, findModel, listModels, protocols, readSettings, reasoningEfforts, saveSettings } from './agent/settings.ts';
import type { ModelCatalog, Protocol, SettingsUpdate } from './agent/settings.ts';
import type { Conversation } from './agent/agent.ts';
import { mountEditor } from './editor/editor.ts';
import { playableError } from './level/definition.ts';
import type { LevelDefinition } from './level/definition.ts';
import { createLevel, migrateDraft, migrateProgress, readCatalog, readProgress, updateLevel, updateLevelOrder, updateProgress } from './storage/game.ts';
import type { LevelEntry, Progress } from './storage/game.ts';
import { editableCombobox } from './ui/combobox.ts';
import { element } from './ui/elements.ts';
import { renderHome, renderLevels } from './ui/front.ts';
import { mountRun } from './ui/run.ts';
import { providerSettings } from './ui/provider-settings.ts';
import backdropURL from './render/backdrop.svg';
import './style.css';

const app = element(document, '#app');
app.innerHTML = `
  <a class="corner-control brand-mark" href="#/" data-brand aria-label="返回主界面"></a>
  <button type="button" class="corner-control menu-toggle" aria-label="游戏菜单" aria-haspopup="dialog" data-menu-toggle hidden><span aria-hidden="true"></span></button>
  <img class="scene-backdrop" src="${backdropURL}" alt="" data-backdrop>
  <main class="workspace">
    <div data-workspace></div>
    <section class="scene-content settings-scene" data-settings-scene hidden>
      <a class="scene-back" href="#/" data-settings-back>← 返回</a>
      <h1>设置</h1>
      <form class="settings-form" data-settings-form novalidate>
        <fieldset class="settings-panel" data-username-fields>
          <h2>称呼</h2>
          <label>用户名<input type="text" autocomplete="nickname" data-username></label>
        </fieldset>
        <fieldset class="settings-panel" data-provider-fields></fieldset>
        <fieldset class="settings-panel" data-model-fields hidden disabled>
          <h2>模型连接</h2>
          <label>协议<select data-protocol></select></label>
          <label>Base URL<input type="url" autocomplete="off" data-base-url required></label>
          <div class="api-key-field">
            <label>API Key<input type="password" autocomplete="off" aria-describedby="api-key-note" data-api-key></label>
            <p class="api-key-note" id="api-key-note">（所有 API Key 都在本地存储仅用于调用模型 API ，不会上传到任何第三方）</p>
          </div>
          <div class="settings-combobox">
            <label id="model-label" for="model-id">模型</label>
            <div class="combobox-input">
              <input id="model-id" type="text" autocomplete="off" spellcheck="false" role="combobox"
                aria-autocomplete="list" aria-controls="model-ids" aria-expanded="false" aria-describedby="model-list-status" data-model-id required>
            </div>
            <ul class="combobox-options" id="model-ids" role="listbox" aria-labelledby="model-label" hidden></ul>
            <span class="settings-status" id="model-list-status" role="status" hidden></span>
          </div>
          <label>上下文长度（K）<input type="number" min="0.001" step="0.001" data-context-limit required></label>
          <div class="settings-combobox">
            <label id="effort-label" for="effort">思考强度</label>
            <div class="combobox-input">
              <input id="effort" type="text" autocomplete="off" spellcheck="false" placeholder="默认" role="combobox"
                aria-autocomplete="none" aria-controls="effort-options" aria-expanded="false" data-effort>
            </div>
            <ul class="combobox-options" id="effort-options" role="listbox" aria-labelledby="effort-label" hidden></ul>
          </div>
          <label class="setting-check"><input type="checkbox" data-vision checked>支持视觉理解</label>
        </fieldset>
        <p class="settings-status" role="status" data-settings-status hidden></p>
        <div class="settings-actions"><button type="submit" class="primary">保存</button></div>
      </form>
    </section>
  </main>
  <dialog class="settings-dialog" aria-labelledby="setup-title" data-play-setup>
    <div class="dialog-header">
      <h2 id="setup-title"></h2>
      <form method="dialog"><button class="icon-button" aria-label="关闭设置">×</button></form>
    </div>
  </dialog>
  <dialog class="pause-menu" aria-labelledby="menu-title" data-menu>
    <div class="dialog-header">
      <h2 id="menu-title">游戏菜单</h2>
      <form method="dialog"><button class="icon-button" aria-label="关闭菜单">×</button></form>
    </div>
    <nav class="pause-actions" aria-label="游戏菜单">
      <button type="button" class="primary" data-resume>继续</button>
      <a class="scene-action" href="#/">主界面</a>
      <a class="scene-action" href="#/settings">设置</a>
    </nav>
  </dialog>`;

const workspace = element(app, '[data-workspace]');
const backdrop = element(app, '[data-backdrop]');
const brand = element(app, '[data-brand]');
const menuToggle = element<HTMLButtonElement>(app, '[data-menu-toggle]');
const menu = element<HTMLDialogElement>(app, '[data-menu]');
const resumeButton = element<HTMLButtonElement>(menu, '[data-resume]');
const settingsScene = element(app, '[data-settings-scene]');
const playSetup = element<HTMLDialogElement>(app, '[data-play-setup]');
const setupTitle = element(playSetup, '#setup-title');
const settingsBack = element<HTMLAnchorElement>(settingsScene, '[data-settings-back]');
const settingsForm = element<HTMLFormElement>(settingsScene, '[data-settings-form]');
const usernameFields = element<HTMLFieldSetElement>(settingsForm, '[data-username-fields]');
const usernameInput = element<HTMLInputElement>(settingsForm, '[data-username]');
const modelFields = element<HTMLFieldSetElement>(settingsForm, '[data-model-fields]');
const protocolInput = element<HTMLSelectElement>(settingsForm, '[data-protocol]');
const addressInput = element<HTMLInputElement>(settingsForm, '[data-base-url]');
const modelInput = element<HTMLInputElement>(settingsForm, '[data-model-id]');
const modelPicker = editableCombobox(modelInput, element(settingsForm, '#model-ids'), true);
const modelListStatus = element(settingsForm, '#model-list-status');
const contextInput = element<HTMLInputElement>(settingsForm, '[data-context-limit]');
const effortInput = element<HTMLInputElement>(settingsForm, '[data-effort]');
const effortPicker = editableCombobox(effortInput, element(settingsForm, '#effort-options'));
const keyInput = element<HTMLInputElement>(settingsForm, '[data-api-key]');
const settingsStatus = element(settingsForm, '[data-settings-status]');
const visionInput = element<HTMLInputElement>(settingsForm, '[data-vision]');
const providerFields = element<HTMLFieldSetElement>(settingsForm, '[data-provider-fields]');
const providerEditor = providerSettings(providerFields);
const submitSettings = element<HTMLButtonElement>(settingsForm, 'button[type="submit"]');

for (const [protocol, { label }] of Object.entries(protocols)) protocolInput.add(new Option(label, protocol));
effortPicker.setOptions([
  { value: '', label: '默认' },
  ...reasoningEfforts.map((level) => ({ value: level, label: level })),
]);

let library: LevelEntry[] = [];
let warnings: string[] = [];
let progress: Progress = { levels: {} };
const editorWrites = new Map<string, Promise<void>>();
let orderWrite: Promise<void> | undefined;
let latestSave = 0;
let username = '';
let setupRoute = '';
let catalog: ModelCatalog = { defaultModel: '', modelProviders: [] };
const defaultModel = () => findModel(catalog, catalog.defaultModel);
const setupProvider = () => catalog.modelProviders.find(({ id }) => id === 'default');
let activeRun: ReturnType<typeof mountRun> | undefined;
const conversations = new Map<string, Conversation>();
let initialized = false;
let mountedRoute = '';
let routeRequest = 0;
let settingsRequest = 0;
let modelListRequest: AbortController | undefined;
let modelsLoaded = false;
let saving = false;
let providerFormSnapshot = "";

function disposeScene() {
  activeRun?.dispose();
  activeRun = undefined;
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

async function renderRoute() {
  if (!initialized) return;
  const request = ++routeRequest;
  const route = location.hash || '#/';
  const playPath = route.split('?', 1)[0];
  const isPlay = playPath === '#/play' || playPath.startsWith('#/play/');
  const isEditor = route.startsWith('#/create/');
  const custom = route === '#/levels/custom';
  const isLevels = route === '#/levels' || custom || route === '#/create';
  const builtIns = library.filter(({ kind }) => kind === 'builtin');
  const id = playPath === '#/play' ? builtIns[0]?.id : (isPlay ? playPath : route).split('/')[2];
  const leavingEditor = mountedRoute.startsWith('#/create/') && route !== '#/settings';
  while (true) {
    const pending = [editorWrites.get(id), leavingEditor ? editorWrites.get(mountedRoute.split('/')[2]) : undefined,
      custom || route === '#/create' ? orderWrite : undefined];
    if (!pending.some(Boolean)) break;
    await Promise.allSettled(pending);
    if (request !== routeRequest || route !== (location.hash || '#/')) return;
  }
  menu.close();
  if (setupRoute && setupRoute !== route) closePlaySetup();
  menuToggle.hidden = true;
  brand.hidden = isEditor;
  if (route === '#/settings') {
    if (!settingsScene.hidden) return;
    settingsBack.href = mountedRoute || '#/';
    settingsScene.hidden = false;
    workspace.hidden = true;
    backdrop.hidden = false;
    syncPause();
    settingsMessage('');
    usernameInput.value = username;
    fillSettings();
    window.scrollTo(0, 0);
    if (!saving) void refreshSettings();
    return;
  }
  if (!settingsScene.hidden) {
    settingsScene.hidden = true;
    settingsRequest++;
    lockSettings(saving);
    workspace.hidden = false;
    providerEditor.fill(catalog);
    syncPause();
    if (mountedRoute === route && activeRun) {
      backdrop.hidden = true;
      menuToggle.hidden = false;
      window.scrollTo(0, 0);
      return;
    }
  }

  const entry = library.find((level) => level.id === id);
  if (isPlay && entry && !playableError(entry.level) && (!username || !defaultModel())) {
    disposeScene();
    mountedRoute = '';
    workspace.replaceChildren();
    backdrop.hidden = false;
    if (!playSetup.open) openPlaySetup(route);
    return;
  }

  disposeScene();
  mountedRoute = route;
  if (isEditor && entry?.kind === 'custom') {
    renderEditor(entry);
  } else if (isPlay && entry && !playableError(entry.level)) {
    const index = builtIns.findIndex((level) => level.id === entry.id);
    const next = index === -1 ? undefined : builtIns[index + 1];
    const hashDebug = new URLSearchParams(route.slice(playPath.length + 1)).get('debug') === 'true';
    const debug = hashDebug || new URLSearchParams(location.search).get('debug') === 'true';
    renderRun(entry, debug, next && `#/play/${next.id}${hashDebug ? '?debug=true' : ''}`);
  } else {
    backdrop.hidden = false;
    brand.hidden = false;
    if (isLevels || isPlay || isEditor) {
      const showCustom = custom || route === '#/create' || isEditor || entry?.kind === 'custom';
      renderLevels(workspace, showCustom ? library.filter(({ kind }) => kind === 'custom') : builtIns,
        progress, showCustom, warnings, async () => {
          const created = await createLevel();
          library.push(created);
          if ((location.hash || '#/') === route) location.hash = `#/create/${created.id}`;
        }, saveLevelOrder);
    } else {
      renderHome(workspace, builtIns, progress);
    }
  }
  window.scrollTo(0, 0);
}

async function saveLevelOrder(ids: string[]) {
  const pending = updateLevelOrder(ids).then((saved) => {
    const positions = new Map(saved.map((id, index) => [id, index]));
    // Stable sort keeps the built-in campaign order.
    const position = ({ id, kind }: LevelEntry) => kind === 'builtin' ? -1 : positions.get(id) ?? saved.length;
    library.sort((a, b) => position(a) - position(b));
  });
  orderWrite = pending;
  try {
    await pending;
  } finally {
    if (orderWrite === pending) orderWrite = undefined;
  }
}

function renderEditor(entry: LevelEntry) {
  backdrop.hidden = true;
  menuToggle.hidden = false;
  const { id } = entry;
  activeRun = mountEditor(workspace, {
    level: entry.level, catalog, username, conversation: conversationFor(`create/${id}`), openSettings,
    save(level: LevelDefinition) {
      const previous = editorWrites.get(id) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        if (editorWrites.get(id) !== pending) return;
        const saved = await updateLevel(id, level);
        const index = library.findIndex((item) => item.id === id);
        library[index] = saved;
      });
      editorWrites.set(id, pending);
      void pending.finally(() => {
        if (editorWrites.get(id) === pending) editorWrites.delete(id);
      }).catch(() => {});
      return pending;
    },
  });
}

function renderRun(entry: LevelEntry, debug: boolean, nextLevel?: string) {
  backdrop.hidden = true;
  menuToggle.hidden = false;
  const { id, level, revision } = entry;
  const record = progress.levels[id];
  activeRun = mountRun(workspace, {
    level, catalog, username, debug, nextLevel, conversation: conversationFor(`play/${id}`),
    completedAt: record?.completedAt,
    savedRun: record?.revision === revision ? record.run : undefined,
    async onProgress(patch) {
      const savedAt = latestSave = Math.max(Date.now(), latestSave + 1);
      const previous = progress.levels[id];
      const local = { ...previous, revision, savedAt, run: patch.run ?? undefined };
      if (patch.won) {
        local.completedAt ??= new Date().toISOString();
        if (patch.durationMS !== undefined && (local.bestDurationMS === undefined || patch.durationMS < local.bestDurationMS)) {
          local.bestDurationMS = patch.durationMS;
        }
      }
      progress.levels[id] = local;
      if (patch.recent && entry.kind === 'builtin') progress.recentBuiltin = id;
      const saved = await updateProgress(id, { ...patch, revision, savedAt });
      if ((progress.levels[id]?.savedAt ?? 0) <= (saved.savedAt ?? 0)) progress.levels[id] = saved;
    },
    openSettings,
  });
}

function syncPause() {
  activeRun?.setPaused(menu.open || !settingsScene.hidden);
}

function openPlaySetup(route: string) {
  setupRoute = route;
  usernameFields.hidden = Boolean(username);
  modelFields.hidden = Boolean(defaultModel());
  providerFields.hidden = true;
  setupTitle.textContent = username ? '设置模型连接' : modelFields.hidden ? '设置用户名' : '设置用户名和模型连接';
  usernameInput.value = username;
  settingsMessage('');
  fillSettings();
  lockSettings(saving);
  playSetup.append(settingsForm);
  playSetup.showModal();
  if (!username) usernameInput.focus();
}

function openMenu() {
  if (menuToggle.hidden || !activeRun) return;
  menu.showModal();
  syncPause();
}

function applySettings(next: Awaited<ReturnType<typeof readSettings>>, reset = false) {
  const changed = next.username !== username || next.defaultModel !== catalog.defaultModel ||
    JSON.stringify(next.modelProviders) !== JSON.stringify(catalog.modelProviders);
  username = next.username;
  catalog = { defaultModel: next.defaultModel, modelProviders: next.modelProviders };
  if (changed || reset) activeRun?.onSettingsChange(catalog, username);
}

function closePlaySetup() {
  setupRoute = '';
  playSetup.close();
  settingsScene.append(settingsForm);
  usernameFields.hidden = providerFields.hidden = false;
  modelFields.hidden = true;
  lockSettings(saving);
  keyInput.value = '';
  resetModelList();
}

function settingsMessage(text: string, error = false) {
  settingsStatus.textContent = text;
  settingsStatus.hidden = !text;
  settingsStatus.classList.toggle('invalid', error);
}

function updateKeyHint() {
  const provider = setupProvider();
  const sameEndpoint = provider?.protocol === protocolInput.value &&
    provider.baseURL === addressInput.value.trim().replace(/\/+$/, '');
  const retainsKey = Boolean(sameEndpoint && provider?.hasAPIKey);
  keyInput.placeholder = retainsKey ? '已保存，留空可保留'
    : protocolInput.value === 'OllamaChat' ? '本地 Ollama 可留空' : '输入模型 API Key';
}

function showModelListStatus(text: string) {
  modelListStatus.textContent = text;
  modelListStatus.hidden = !text;
}

function resetModelList() {
  modelListRequest?.abort();
  modelListRequest = undefined;
  modelsLoaded = false;
  modelPicker.close();
  modelPicker.setOptions([]);
  showModelListStatus('');
}

function modelConnection() {
  const apiKey = keyInput.value.trim();
  return {
    protocol: protocolInput.value as Protocol, baseURL: addressInput.value.trim(),
    ...(apiKey ? { apiKey } : {}),
  };
}

async function loadModelOptions() {
  if (modelListRequest || modelsLoaded || !addressInput.value.trim() || !addressInput.validity.valid) return;
  const request = modelListRequest = new AbortController();
  showModelListStatus('正在读取模型列表…');
  try {
    const models = await listModels(modelConnection(), AbortSignal.any([request.signal, AbortSignal.timeout(17000)]), 'default');
    if (request.signal.aborted) return;
    modelPicker.setOptions(models.map((id) => ({ value: id, label: id })));
    modelsLoaded = true;
    showModelListStatus(models.length ? '' : '上游模型列表为空，可手动输入');
  } catch (error) {
    if (request.signal.aborted) return;
    const text = error instanceof Error && error.name === 'TimeoutError' ? '读取模型列表超时'
      : error instanceof Error && error.name === 'Error' ? error.message : '无法读取模型列表';
    showModelListStatus(`${text}，可手动输入`);
  } finally {
    if (modelListRequest === request) modelListRequest = undefined;
  }
}

function fillSettings() {
  if (!setupRoute) {
    providerEditor.fill(catalog);
    providerFormSnapshot = JSON.stringify(providerEditor.read());
    return;
  }
  const provider = setupProvider();
  const protocol = provider?.protocol ?? defaultProtocol;
  protocolInput.value = protocol;
  addressInput.value = provider?.baseURL ?? protocols[protocol].baseURL;
  addressInput.placeholder = protocols[protocol].baseURL;
  modelPicker.setValue('');
  contextInput.value = String(defaultMaxInputToken / 1000);
  effortPicker.setValue('');
  visionInput.checked = true;
  keyInput.value = '';
  updateKeyHint();
  resetModelList();
}

function lockSettings(locked: boolean) {
  if (locked) {
    modelPicker.close();
    effortPicker.close();
  }
  usernameFields.disabled = locked || usernameFields.hidden;
  modelFields.disabled = locked || modelFields.hidden;
  providerFields.disabled = locked || providerFields.hidden;
  submitSettings.disabled = locked;
}

async function refreshSettings() {
  const request = ++settingsRequest;
  lockSettings(true);
  try {
    const next = await readSettings(AbortSignal.timeout(5000));
    if (request !== settingsRequest) return;
    applySettings(next);
    if (!settingsScene.hidden) {
      usernameInput.value = username;
      fillSettings();
    }
  } catch {
    if (request === settingsRequest && !settingsScene.hidden) settingsMessage('无法读取设置', true);
  } finally {
    if (request === settingsRequest) lockSettings(false);
  }
}

async function commitSettings(update: SettingsUpdate) {
  if (saving) return;
  const route = setupRoute;
  saving = true;
  settingsRequest++;
  lockSettings(true);
  settingsMessage('');
  try {
    applySettings(await saveSettings(update, AbortSignal.timeout(10000)), update.modelProviders !== undefined);
    if (route && setupRoute === route && playSetup.open && location.hash === route) {
      closePlaySetup();
      void renderRoute();
    } else if (!settingsScene.hidden) {
      usernameInput.value = username;
      fillSettings();
      settingsMessage('设置已保存');
    }
  } catch (error) {
    settingsMessage(error instanceof Error && error.name !== 'TimeoutError' ? error.message : '保存设置超时', true);
  } finally {
    saving = false;
    lockSettings(false);
  }
}

menuToggle.addEventListener('click', openMenu);
menu.addEventListener('close', syncPause);
playSetup.addEventListener('close', () => {
  if (playSetup.open || !setupRoute) return;
  const route = setupRoute;
  closePlaySetup();
  if (location.hash === route) location.hash = '#/';
});
resumeButton.addEventListener('click', () => menu.close());
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
  if (settingsScene.hidden && menuToggle.hidden) return;
  event.preventDefault();
  if (settingsScene.hidden) openMenu();
  else location.hash = settingsBack.hash;
});
protocolInput.addEventListener('change', () => {
  addressInput.value = protocols[protocolInput.value as Protocol].baseURL;
  addressInput.placeholder = addressInput.value;
  keyInput.value = '';
  updateKeyHint();
  resetModelList();
});
addressInput.addEventListener('input', () => {
  updateKeyHint();
  resetModelList();
});
keyInput.addEventListener('input', resetModelList);
modelInput.addEventListener('focus', loadModelOptions);
modelInput.addEventListener('click', loadModelOptions);
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const update: SettingsUpdate = {};
  const name = usernameInput.value;
  const displayedUsername = username.replace(/[\r\n]/g, '');
  if (!usernameFields.hidden && name !== displayedUsername) update.username = name;
  usernameInput.required = Boolean(setupRoute || displayedUsername);
  if (!usernameFields.hidden && !usernameInput.reportValidity()) return;
  if (update.username !== undefined && Array.from(name).length > 20) {
    settingsMessage('用户名最多 20 个字符', true);
    usernameInput.focus();
    return;
  }
  if (!providerFields.hidden) {
    if (!providerEditor.validate()) return;
    const models = providerEditor.read();
    if (JSON.stringify(models) !== providerFormSnapshot) Object.assign(update, models);
  }
  if (!modelFields.hidden) {
    if (![addressInput, modelInput, contextInput].every((input) => input.reportValidity())) return;
    const modelID = modelInput.value.trim();
    const maxInputToken = Math.round(contextInput.valueAsNumber * 1000);
    if (!modelID || !Number.isSafeInteger(maxInputToken) || maxInputToken <= 0) {
      settingsMessage(!modelID ? '请输入模型 ID' : '上下文长度超出范围', true);
      (modelID ? contextInput : modelInput).focus();
      return;
    }
    const provider = {
      id: 'default', name: 'Default', ...modelConnection(),
      models: [{ id: modelID, maxInputToken, reasoningEffort: effortInput.value.trim(), vision: visionInput.checked }],
    };
    const providers = catalog.modelProviders.map(({ hasAPIKey: _hasAPIKey, ...entry }) => entry);
    const index = providers.findIndex(({ id }) => id === provider.id);
    if (index < 0) providers.push(provider);
    else providers[index] = provider;
    update.modelProviders = providers;
    update.defaultModel = `default/${modelID}`;
  }
  if (update.username !== undefined || update.modelProviders !== undefined) void commitSettings(update);
  else settingsMessage('没有需要保存的更改');
});
window.addEventListener('hashchange', () => { void renderRoute(); });

async function initialize() {
  workspace.innerHTML = '<p class="muted" role="status">正在读取本地关卡和进度…</p>';
  try {
    const [catalog, saved, settings] = await Promise.all([
      readCatalog(), readProgress(), readSettings(AbortSignal.timeout(5000)),
    ]);
    applySettings(settings);
    library = catalog.levels;
    warnings = catalog.warnings ?? [];
    progress = saved;
    const [draft, oldProgress] = await Promise.allSettled([migrateDraft(), migrateProgress()]);
    if (draft.status === 'fulfilled' && draft.value && !library.some(({ id }) => id === draft.value?.id)) library.push(draft.value);
    if (oldProgress.status === 'fulfilled' && oldProgress.value) progress = oldProgress.value;
    if (draft.status === 'rejected' || oldProgress.status === 'rejected') {
      warnings.push('部分旧版浏览器存档未能迁移，刷新可重试。');
    }
    latestSave = Object.values(progress.levels).reduce((latest, item) => Math.max(latest, item.savedAt ?? 0), progress.recentBuiltinAt ?? 0);
    initialized = true;
    void renderRoute();
  } catch (error) {
    workspace.innerHTML = '<p class="invalid" role="status"></p><button type="button">重试</button>';
    element(workspace, 'p').textContent = error instanceof Error ? error.message : '无法读取本地关卡和进度';
    element(workspace, 'button').addEventListener('click', () => { void initialize(); }, { once: true });
  }
}

void initialize();
