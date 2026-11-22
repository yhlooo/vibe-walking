import { defaultMaxInputToken, protocols, readSettings, saveSettings } from './agent/settings.ts';
import type { ModelSettings, Protocol } from './agent/settings.ts';
import type { Conversation } from './agent/agent.ts';
import { mountEditor } from './editor/editor.ts';
import { playableError } from './level/definition.ts';
import type { LevelDefinition } from './level/definition.ts';
import { createLevel, migrateDraft, migrateProgress, readCatalog, readProgress, updateLevel, updateProgress } from './storage/game.ts';
import type { LevelEntry, Progress } from './storage/game.ts';
import { element } from './ui/elements.ts';
import { renderHome, renderLevels } from './ui/front.ts';
import { mountRun } from './ui/run.ts';
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
      <form class="settings-form" data-username-form>
        <h2>称呼</h2>
        <label>用户名<textarea rows="1" autocomplete="nickname" data-username required></textarea></label>
        <p class="settings-status" role="status" data-username-status hidden></p>
        <div class="dialog-actions"><button type="submit" class="primary">保存用户名</button></div>
      </form>
      <form class="settings-form" data-settings-form>
        <h2>模型连接</h2>
        <fieldset>
          <label>协议<select data-protocol></select></label>
          <label>Base URL<input type="url" autocomplete="off" placeholder="https://api.openai.com/v1" data-base-url required></label>
          <label>模型 ID<input type="text" autocomplete="off" data-model-id required></label>
          <label>上下文长度（K）<input type="number" min="0.001" step="0.001" data-context-limit required></label>
          <label>思考强度<select data-effort>
            <option value="">默认</option>
            <option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>ultra</option>
            <option value="custom">自定义</option>
          </select></label>
          <label data-custom-effort-label hidden>自定义思考强度<input type="text" autocomplete="off" data-custom-effort></label>
          <label>API Key<input type="password" autocomplete="off" data-api-key></label>
          <label class="checkbox" data-remove-label hidden><input type="checkbox" data-remove-key>移除已保存的密钥</label>
        </fieldset>
        <p class="settings-status" role="status" data-settings-status hidden></p>
        <div class="dialog-actions"><button type="button" data-clear-settings>清除连接</button><button type="submit" class="primary">保存</button></div>
      </form>
    </section>
  </main>
  <dialog class="settings-dialog" aria-labelledby="username-title" data-username-setup>
    <div class="dialog-header">
      <h2 id="username-title">设置用户名</h2>
      <form method="dialog"><button class="icon-button" aria-label="返回主界面">×</button></form>
    </div>
  </dialog>
  <dialog class="settings-dialog" aria-labelledby="setup-title" data-model-setup>
    <div class="dialog-header">
      <h2 id="setup-title">设置模型连接</h2>
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
const usernameSetup = element<HTMLDialogElement>(app, '[data-username-setup]');
const usernameForm = element<HTMLFormElement>(settingsScene, '[data-username-form]');
const usernameInput = element<HTMLTextAreaElement>(usernameForm, '[data-username]');
const usernameStatus = element(usernameForm, '[data-username-status]');
const submitUsername = element<HTMLButtonElement>(usernameForm, 'button[type="submit"]');
const modelSetup = element<HTMLDialogElement>(app, '[data-model-setup]');
const settingsBack = element<HTMLAnchorElement>(settingsScene, '[data-settings-back]');
const settingsForm = element<HTMLFormElement>(settingsScene, '[data-settings-form]');
const settingsFields = element<HTMLFieldSetElement>(settingsForm, 'fieldset');
const protocolInput = element<HTMLSelectElement>(settingsForm, '[data-protocol]');
const addressInput = element<HTMLInputElement>(settingsForm, '[data-base-url]');
const modelInput = element<HTMLInputElement>(settingsForm, '[data-model-id]');
const contextInput = element<HTMLInputElement>(settingsForm, '[data-context-limit]');
const effortInput = element<HTMLSelectElement>(settingsForm, '[data-effort]');
const customEffortLabel = element(settingsForm, '[data-custom-effort-label]');
const customEffortInput = element<HTMLInputElement>(customEffortLabel, 'input');
const keyInput = element<HTMLInputElement>(settingsForm, '[data-api-key]');
const removeLabel = element<HTMLLabelElement>(settingsForm, '[data-remove-label]');
const removeKey = element<HTMLInputElement>(settingsForm, '[data-remove-key]');
const settingsStatus = element(settingsForm, '[data-settings-status]');
const clearSettings = element<HTMLButtonElement>(settingsForm, '[data-clear-settings]');
const submitSettings = element<HTMLButtonElement>(settingsForm, 'button[type="submit"]');

for (const [protocol, { label }] of Object.entries(protocols)) protocolInput.add(new Option(label, protocol));

let library: LevelEntry[] = [];
let warnings: string[] = [];
let progress: Progress = { levels: {} };
const editorWrites = new Map<string, Promise<void>>();
let latestSave = 0;
let username = '';
let usernameSetupRoute = '';
let model: ModelSettings | null = null;
let modelKnown = false;
let firstPlayChecked = false;
let activeRun: ReturnType<typeof mountRun> | undefined;
const conversations = new Map<string, Conversation>();
let initialized = false;
let mountedRoute = '';
let routeRequest = 0;
let settingsRequest = 0;
let saving = false;

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
  const isPlay = route === '#/play' || route.startsWith('#/play/');
  const isEditor = route.startsWith('#/create/');
  const custom = route === '#/levels/custom';
  const isLevels = route === '#/levels' || custom || route === '#/create';
  const builtIns = library.filter(({ kind }) => kind === 'builtin');
  const id = route === '#/play' ? builtIns[0]?.id : route.split('/')[2];
  const leavingEditor = mountedRoute.startsWith('#/create/') && route !== '#/settings';
  while (true) {
    const pending = [editorWrites.get(id), leavingEditor ? editorWrites.get(mountedRoute.split('/')[2]) : undefined];
    if (!pending.some(Boolean)) break;
    await Promise.allSettled(pending);
    if (request !== routeRequest || route !== (location.hash || '#/')) return;
  }
  menu.close();
  if (usernameSetup.open && usernameSetupRoute !== route) closeUsernameSetup();
  if (modelSetup.open) {
    modelSetup.close();
    settingsScene.append(settingsForm);
  }
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
    usernameMessage('');
    usernameInput.value = username;
    fillSettings();
    window.scrollTo(0, 0);
    void loadSettings(true);
    return;
  }
  if (!settingsScene.hidden) {
    settingsScene.hidden = true;
    workspace.hidden = false;
    keyInput.value = '';
    syncPause();
    if (mountedRoute === route && activeRun) {
      backdrop.hidden = true;
      menuToggle.hidden = false;
      window.scrollTo(0, 0);
      return;
    }
  }

  const entry = library.find((level) => level.id === id);
  if (isPlay && entry && !playableError(entry.level) && !username) {
    disposeScene();
    mountedRoute = '';
    workspace.replaceChildren();
    backdrop.hidden = false;
    if (!usernameSetup.open) {
      usernameSetupRoute = route;
      usernameInput.value = '';
      usernameMessage('');
      usernameSetup.append(usernameForm);
      usernameSetup.showModal();
      usernameInput.focus();
    }
    return;
  }

  disposeScene();
  mountedRoute = route;
  if (isEditor && entry?.kind === 'custom') {
    renderEditor(entry);
  } else if (isPlay && entry && !playableError(entry.level)) {
    const index = builtIns.findIndex((level) => level.id === entry.id);
    renderRun(entry, index === -1 ? undefined : builtIns[index + 1]);
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
        });
    } else {
      renderHome(workspace, builtIns, progress);
    }
  }
  window.scrollTo(0, 0);
  if (isPlay && activeRun) {
    if (modelKnown) maybeOpenModelSetup();
    else void loadSettings(false);
  }
}

function renderEditor(entry: LevelEntry) {
  backdrop.hidden = true;
  menuToggle.hidden = false;
  const { id } = entry;
  activeRun = mountEditor(workspace, {
    level: entry.level, model, username, conversation: conversationFor(`create/${id}`), openSettings,
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

function renderRun(entry: LevelEntry, next?: LevelEntry) {
  backdrop.hidden = true;
  menuToggle.hidden = false;
  const { id, level, revision } = entry;
  const record = progress.levels[id];
  activeRun = mountRun(workspace, {
    level, model, username, conversation: conversationFor(`play/${id}`),
    completedAt: record?.completedAt,
    savedRun: record?.revision === revision ? record.run : undefined,
    nextLevel: next && `#/play/${next.id}`,
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
  activeRun?.setPaused(menu.open || modelSetup.open || !settingsScene.hidden);
}

function maybeOpenModelSetup() {
  if (firstPlayChecked || !modelKnown || !activeRun || !mountedRoute.startsWith('#/play') || !settingsScene.hidden) return;
  firstPlayChecked = true;
  if (model) return;
  menu.close();
  settingsMessage('');
  fillSettings();
  if (!saving) lockSettings(false);
  modelSetup.append(settingsForm);
  modelSetup.showModal();
  syncPause();
}

function openMenu() {
  if (menuToggle.hidden || !activeRun) return;
  menu.showModal();
  syncPause();
}

function applySettings(next: Awaited<ReturnType<typeof readSettings>>, reset = false) {
  const changed = next.username !== username || next.model?.api !== model?.api || next.model?.baseURL !== model?.baseURL ||
    next.model?.model !== model?.model || next.model?.hasAPIKey !== model?.hasAPIKey ||
    next.model?.maxInputToken !== model?.maxInputToken || next.model?.reasoningEffort !== model?.reasoningEffort;
  username = next.username;
  model = next.model;
  if (changed || reset) activeRun?.onSettingsChange(model, username);
}

function closeUsernameSetup() {
  usernameSetupRoute = '';
  usernameSetup.close();
  settingsScene.insertBefore(usernameForm, settingsForm.parentElement === settingsScene ? settingsForm : null);
}

function usernameMessage(text: string, error = false) {
  usernameStatus.textContent = text;
  usernameStatus.hidden = !text;
  usernameStatus.classList.toggle('invalid', error);
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
  contextInput.value = String((model?.maxInputToken ?? defaultMaxInputToken) / 1000);
  const effort = model?.reasoningEffort ?? '';
  const preset = [...effortInput.options].some((option) => option.value === effort && option.value !== 'custom');
  effortInput.value = preset ? effort : 'custom';
  customEffortInput.value = preset ? '' : effort;
  updateCustomEffort();
  keyInput.value = '';
  removeKey.checked = false;
  clearSettings.hidden = !model;
  updateKeyHint();
}

function updateCustomEffort() {
  const custom = effortInput.value === 'custom';
  customEffortLabel.hidden = !custom;
  customEffortInput.required = custom;
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
    const refreshUsername = usernameInput.value === username;
    modelKnown = true;
    applySettings(next);
    maybeOpenModelSetup();
    if (inScene && !settingsScene.hidden) {
      if (refreshUsername) usernameInput.value = username;
      fillSettings();
    }
  } catch {
    if (request === settingsRequest && inScene) settingsMessage('无法读取模型设置', true);
  } finally {
    if (request === settingsRequest && inScene) lockSettings(false);
  }
}

async function commitSettings(update: Parameters<typeof saveSettings>[0]) {
  if (saving) return;
  const writingUsername = update.username !== undefined;
  const showMessage = writingUsername ? usernameMessage : settingsMessage;
  saving = true;
  settingsRequest++;
  lockSettings(true);
  usernameInput.disabled = submitUsername.disabled = true;
  showMessage('');
  try {
    applySettings(await saveSettings(update, AbortSignal.timeout(10000)), !writingUsername);
    modelKnown = true;
    if (writingUsername) {
      showMessage('用户名已保存');
      if (usernameSetup.open) {
        closeUsernameSetup();
        void renderRoute();
      }
    } else {
      fillSettings();
      showMessage(update.model ? '设置已保存' : '已清除模型连接');
      if (update.model && modelSetup.open) modelSetup.close();
    }
  } catch (error) {
    showMessage(error instanceof Error && error.name !== 'TimeoutError' ? error.message : '保存设置超时', true);
  } finally {
    saving = false;
    lockSettings(false);
    usernameInput.disabled = submitUsername.disabled = false;
  }
}

menuToggle.addEventListener('click', openMenu);
menu.addEventListener('close', syncPause);
usernameSetup.addEventListener('close', () => {
  if (usernameSetup.open || !usernameSetupRoute) return;
  const route = usernameSetupRoute;
  closeUsernameSetup();
  if (location.hash === route) location.hash = '#/';
});
usernameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = usernameInput.value;
  if (Array.from(value).length > 20) {
    usernameMessage('用户名最多 20 个字符', true);
    return;
  }
  if (value) void commitSettings({ username: value });
});
modelSetup.addEventListener('close', () => {
  if (modelSetup.open || settingsForm.parentElement !== modelSetup) return;
  settingsScene.append(settingsForm);
  keyInput.value = '';
  syncPause();
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
  keyInput.value = '';
  updateKeyHint();
});
addressInput.addEventListener('input', updateKeyHint);
effortInput.addEventListener('change', updateCustomEffort);
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const apiKey = keyInput.value.trim();
  const maxInputToken = Math.round(contextInput.valueAsNumber * 1000);
  const reasoningEffort = (effortInput.value === 'custom' ? customEffortInput.value : effortInput.value).trim();
  if (!Number.isSafeInteger(maxInputToken) || maxInputToken <= 0) {
    settingsMessage('上下文长度超出范围', true);
    return;
  }
  if (effortInput.value === 'custom' && !reasoningEffort) {
    settingsMessage('请输入自定义思考强度', true);
    return;
  }
  void commitSettings({ model: {
    api: protocolInput.value as Protocol, baseURL: addressInput.value.trim(), model: modelInput.value.trim(),
    maxInputToken, reasoningEffort,
    ...(removeKey.checked ? { apiKey: '' } : apiKey ? { apiKey } : {}),
  } });
});
clearSettings.addEventListener('click', () => { void commitSettings({ model: null }); });
window.addEventListener('hashchange', () => { void renderRoute(); });

async function initialize() {
  workspace.innerHTML = '<p class="muted" role="status">正在读取本地关卡和进度…</p>';
  try {
    const [catalog, saved] = await Promise.all([readCatalog(), readProgress(), loadSettings(false)]);
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
