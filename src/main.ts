import { defaultMaxInputToken, defaultProtocol, findModel, listModels, protocols, readSettings, reasoningEffortOptions, saveSettings } from './agent/settings.ts';
import type { ModelCatalog, Protocol, SettingsUpdate } from './agent/settings.ts';
import type { Conversation } from './agent/agent.ts';
import { mountEditor } from './editor/editor.ts';
import { playableError } from './level/definition.ts';
import type { LevelDefinition } from './level/definition.ts';
import { createLevel, markRecentLevel, migrateDraft, migrateProgress, readCatalog, readProgress, recordCompletion, updateLevel, updateLevelOrder } from './storage/game.ts';
import type { LevelEntry, Progress } from './storage/game.ts';
import { apiKeyField, apiKeyFieldMarkup } from './ui/api-key-field.ts';
import { editableCombobox } from './ui/combobox.ts';
import { element } from './ui/elements.ts';
import { homeLevel, renderHome, renderLevels } from './ui/front.ts';
import { mountRun } from './ui/run.ts';
import { providerSettings } from './ui/provider-settings.ts';
import backdropURL from './render/backdrop.svg';
import './style.css';

// 挂载应用外壳及由路由共用的设置表单。
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
          ${apiKeyFieldMarkup('setup-api-key')}
          <div class="settings-combobox">
            <label id="model-label" for="model-id">模型 ID</label>
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

// 绑定外壳和设置表单中由场景切换复用的节点。
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
const setupKey = apiKeyField(settingsForm, 'setup-api-key', resetModelList);
const settingsStatus = element(settingsForm, '[data-settings-status]');
const visionInput = element<HTMLInputElement>(settingsForm, '[data-vision]');
const providerFields = element<HTMLFieldSetElement>(settingsForm, '[data-provider-fields]');
const providerEditor = providerSettings(providerFields);
const submitSettings = element<HTMLButtonElement>(settingsForm, 'button[type="submit"]');

for (const [protocol, { label }] of Object.entries(protocols)) protocolInput.add(new Option(label, protocol));
effortPicker.setOptions(reasoningEffortOptions);

let library: LevelEntry[] = [];
let warnings: string[] = [];
let progress: Progress = { levels: {} };

// 按关卡跟踪编辑写入，供后续保存与路由切换等待。
const editorWrites = new Map<string, Promise<void>>();
let orderWrite: Promise<void> | undefined;
const progressWrites = new Set<Promise<unknown>>();
let username = '';
let setupRoute = '';
let catalog: ModelCatalog = { defaultModel: '', modelProviders: [] };

// 把当前设置中的默认模型引用解析为游玩配置。
const defaultModel = () => findModel(catalog, catalog.defaultModel);
const setupProvider = () => catalog.modelProviders.find(({ id }) => id === 'default');
let activeRun: ReturnType<typeof mountRun> | undefined;

// 为本次页面会话保留各关卡独立的聊天历史。
const conversations = new Map<string, Conversation>();
let initialized = false;
let mountedRoute = '';

// 使用请求编号及取消控制器过滤过期的异步结果。
let routeRequest = 0;
let settingsRequest = 0;
let modelListRequest: AbortController | undefined;
let modelsLoaded = false;
let saving = false;
let providerFormSnapshot = "";

// 卸载活跃场景及其运行资源。
function disposeScene() {
  activeRun?.dispose();
  activeRun = undefined;
}

// 返回指定场景已有的共享对话，首次访问时初始化。
function conversationFor(id: string): Conversation {
  let conversation = conversations.get(id);
  if (!conversation) {
    conversation = { events: [], history: [] };
    conversations.set(id, conversation);
  }
  return conversation;
}

// 将应用导航到设置场景。
function openSettings() {
  location.hash = '#/settings';
}

// 解析 URL 并渲染对应界面，协调场景、设置和待保存数据。
async function renderRoute() {
  if (!initialized) return;
  const request = ++routeRequest;
  const route = location.hash || '#/';
  const playPath = route.split('?', 1)[0];
  const isPlay = playPath === '#/play' || playPath.startsWith('#/play/');
  const isEditor = route.startsWith('#/create/');
  const custom = route === '#/levels/custom';
  const isLevels = route === '#/levels' || custom || route === '#/create';
  const isContinue = route === '#/continue';
  const builtIns = library.filter(({ kind }) => kind === 'builtin');
  const id = playPath === '#/play' ? builtIns[0]?.id : (isPlay ? playPath : route).split('/')[2];

  // 离开编辑器或打开相关列表前等待待处理的写入。
  const leavingEditor = mountedRoute.startsWith('#/create/') && route !== '#/settings';
  while (true) {
    const pending = [editorWrites.get(id), leavingEditor ? editorWrites.get(mountedRoute.split('/')[2]) : undefined,
      custom || route === '#/create' ? orderWrite : undefined];

    // 等待中可能又有写入排队，因此每次完成后重新读取挂起任务。
    if (!pending.some(Boolean)) break;
    await Promise.allSettled(pending);
    if (request !== routeRequest || route !== (location.hash || '#/')) return;
  }

  // 离开游玩场景后再等待已发出的写入，防止旧场景在导航途中继续推进。
  if (isContinue || route === '#/' || isLevels || (isPlay && mountedRoute !== route)) {
    disposeScene();
    await Promise.allSettled(progressWrites);
    if (request !== routeRequest || route !== (location.hash || '#/')) return;

    // 继续游戏同时刷新目录，以识别其他页面刚创建或修改的自建关卡。
    const [saved, latestCatalog] = await Promise.allSettled([
      readProgress(), isContinue ? readCatalog() : undefined,
    ]);
    if (request !== routeRequest || route !== (location.hash || '#/')) return;
    if (saved.status === 'fulfilled') progress = saved.value;
    if (latestCatalog.status === 'fulfilled' && latestCatalog.value) {
      library = latestCatalog.value.levels;
      warnings = latestCatalog.value.warnings ?? [];
    }
    if (isContinue) {
      const level = homeLevel(library, progress);
      location.replace(level ? `#/play/${level.id}` : '#/');
      return;
    }
  }

  menu.close();
  if (setupRoute && setupRoute !== route) closePlaySetup();
  menuToggle.hidden = true;
  brand.hidden = isEditor;

  // 临时隐藏并暂停活跃场景，使返回时能恢复原有状态。
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

    // 从设置回到同一路由时恢复现有场景，沿用世界状态和对话。
    if (mountedRoute === route && activeRun) {
      backdrop.hidden = true;
      menuToggle.hidden = false;
      window.scrollTo(0, 0);
      return;
    }
  }

  // 正式游玩前检查关卡和首次设置是否齐备。
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

    // 同时支持页面查询参数和路由查询参数，后者会由下一关链接传递。
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
      renderHome(workspace, progress);
    }
  }
  window.scrollTo(0, 0);
}

// 持久化自建排序并按服务返回的顺序更新目录。
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

// 挂载关卡编辑器，并串行处理同一关卡的保存。
function renderEditor(entry: LevelEntry) {
  backdrop.hidden = true;
  menuToggle.hidden = false;
  const { id } = entry;
  activeRun = mountEditor(workspace, {
    level: entry.level, catalog, username, conversation: conversationFor(`create/${id}`), openSettings,
    save(level: LevelDefinition) {
      // 等待前次写入，并跳过排队期间已被更新替代的草稿。
      const previous = editorWrites.get(id) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        // 同一关卡有更新的排队草稿时跳过这个旧版本，由最后一次保存负责落盘。
        if (editorWrites.get(id) !== pending) return;

        const saved = await updateLevel(id, level);
        const index = library.findIndex((item) => item.id === id);
        library[index] = saved;
      });
      editorWrites.set(id, pending);
      void pending.finally(() => {
        // 只清除当前链尾，保留等待它结束的后续写入。
        if (editorWrites.get(id) === pending) editorWrites.delete(id);
      }).catch(() => {});
      return pending;
    },
  });
}

// 跟踪本页未完成的写入，供后续导航读取最新成绩和最近关卡。
function trackProgressWrite<T>(pending: Promise<T>): Promise<T> {
  progressWrites.add(pending);
  const done = () => { progressWrites.delete(pending); };
  void pending.then(done, done);
  return pending;
}

// 每次进入正式游玩都创建独立的世界和对话。
function renderRun(entry: LevelEntry, debug: boolean, nextLevel?: string) {
  backdrop.hidden = true;
  menuToggle.hidden = false;
  const { id, level, revision } = entry;
  activeRun = mountRun(workspace, {
    level, catalog, username, debug, nextLevel, conversation: { events: [], history: [] },
    completedAt: progress.levels[id]?.completedAt,
    onEnter: () => trackProgressWrite(markRecentLevel(id)),
    onCompletion: (completion) => trackProgressWrite(recordCompletion(id, { ...completion, revision })),
    openSettings,
  });
}

// 根据暂停菜单和设置页的可见性同步暂停状态。
function syncPause() {
  activeRun?.setPaused(menu.open || !settingsScene.hidden);
}

// 将共用表单移入首次游玩弹窗并显示缺失的设置。
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

// 打开当前场景的暂停菜单。
function openMenu() {
  if (menuToggle.hidden || !activeRun) return;
  menu.showModal();
  syncPause();
}

// 应用服务返回的模型目录和用户名，并通知活跃场景。
function applySettings(next: Awaited<ReturnType<typeof readSettings>>, reset = false) {
  const changed = next.username !== username || next.defaultModel !== catalog.defaultModel ||
    JSON.stringify(next.modelProviders) !== JSON.stringify(catalog.modelProviders);
  username = next.username;
  catalog = { defaultModel: next.defaultModel, modelProviders: next.modelProviders };
  if (changed || reset) activeRun?.onSettingsChange(catalog, username);
}

// 关闭首次游玩弹窗并将共用表单移回设置场景。
function closePlaySetup() {
  setupRoute = '';
  playSetup.close();
  settingsScene.append(settingsForm);
  usernameFields.hidden = providerFields.hidden = false;
  modelFields.hidden = true;
  lockSettings(saving);
  setupKey.reset();
  resetModelList();
}

// 更新设置表单反馈及错误样式。
function settingsMessage(text: string, error = false) {
  settingsStatus.textContent = text;
  settingsStatus.hidden = !text;
  settingsStatus.classList.toggle('invalid', error);
}

// 根据当前连接更新已保存密钥的显示状态。
function updateSavedKey() {
  const provider = setupProvider();
  const sameEndpoint = provider?.protocol === protocolInput.value &&
    provider.baseURL === addressInput.value.trim().replace(/\/+$/, '');
  setupKey.setSaved(Boolean(sameEndpoint && provider?.hasAPIKey));
}

// 同步模型列表的加载或错误反馈。
function showModelListStatus(text: string) {
  modelListStatus.textContent = text;
  modelListStatus.hidden = !text;
}

// 取消已有模型发现请求并重置下拉列表。
function resetModelList() {
  modelListRequest?.abort();
  modelListRequest = undefined;
  modelsLoaded = false;
  modelPicker.close();
  modelPicker.setOptions([]);
  showModelListStatus('');
}

// 从快速设置表单读取临时模型连接。
function modelConnection() {
  return {
    protocol: protocolInput.value as Protocol, baseURL: addressInput.value.trim(),
    apiKey: setupKey.read(),
  };
}

// 按需发现临时连接可用的模型选项。
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

// 将当前设置展开到首次配置表单或供应商编辑器。
function fillSettings() {
  if (!setupRoute) {
    providerEditor.fill(catalog);

    // 保存表单初始快照，用来判定用户是否修改了目录。
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
  setupKey.reset();
  updateSavedKey();
  resetModelList();
}

// 根据提交状态和字段可见性锁定表单。
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

// 重新读取本地设置，并忽略已离开页面的结果。
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

// 保存改动并更新界面，首次设置后继续进入关卡。
async function commitSettings(update: SettingsUpdate) {
  if (saving) return;
  const route = setupRoute;
  saving = true;

  // 使之前启动的设置读取失效。
  settingsRequest++;
  lockSettings(true);
  settingsMessage('');
  try {
    applySettings(await saveSettings(update, AbortSignal.timeout(10000)), update.modelProviders !== undefined);

    // 仅当用户仍在原始首次配置弹窗时自动进入关卡。
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

// 将菜单事件接入场景暂停和恢复逻辑。
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

// 连接字段变化后令已有模型发现结果失效。
protocolInput.addEventListener('change', () => {
  addressInput.value = protocols[protocolInput.value as Protocol].baseURL;
  addressInput.placeholder = addressInput.value;
  setupKey.reset();
  updateSavedKey();
  resetModelList();
});
addressInput.addEventListener('input', () => {
  updateSavedKey();
  resetModelList();
});
modelInput.addEventListener('focus', loadModelOptions);
modelInput.addEventListener('click', loadModelOptions);

// 按当前表单用途提交完整供应商目录或快速设置。
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

// 加载设置、关卡和进度，尝试迁移浏览器旧数据后再启用路由。
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

    // 草稿和进度分别迁移，任一成功都可立即合并，失败项留待重试。
    const [draft, oldProgress] = await Promise.allSettled([migrateDraft(), migrateProgress()]);
    if (draft.status === 'fulfilled' && draft.value && !library.some(({ id }) => id === draft.value?.id)) library.push(draft.value);
    if (oldProgress.status === 'fulfilled' && oldProgress.value) progress = oldProgress.value;
    if (draft.status === 'rejected' || oldProgress.status === 'rejected') {
      warnings.push('部分旧版浏览器存档未能迁移，刷新可重试。');
    }

    initialized = true;
    void renderRoute();
  } catch (error) {
    workspace.innerHTML = '<p class="invalid" role="status"></p><button type="button">重试</button>';
    element(workspace, 'p').textContent = error instanceof Error ? error.message : '无法读取本地关卡和进度';
    element(workspace, 'button').addEventListener('click', () => { void initialize(); }, { once: true });
  }
}

void initialize();
