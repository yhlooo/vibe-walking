import { protocols, readSettings, saveSettings } from './agent/settings.ts';
import type { ModelSettings, Protocol } from './agent/settings.ts';
import { mountEditor } from './editor/editor.ts';
import { builtInID, builtInLevel } from './level/builtin.ts';
import type { LevelDefinition } from './level/definition.ts';
import { completion, loadDraft, markCompleted, saveDraft } from './storage/local.ts';
import { element } from './ui/elements.ts';
import { mountRun } from './ui/run.ts';
import type { RunMode } from './ui/run.ts';
import './style.css';

const app = element(document, '#app');
app.innerHTML = `
  <header class="app-header">
    <a class="brand" href="#/play"><span class="brand-mark" aria-hidden="true"></span><span>VIBE WALKING</span></a>
    <nav class="navigation" aria-label="游戏导航">
      <a href="#/play" data-nav="play">游玩</a>
      <a href="#/create" data-nav="create">创作</a>
    </nav>
    <button type="button" class="connection" data-settings><i aria-hidden="true" data-connection-dot></i>模型连接</button>
  </header>
  <main class="workspace" data-workspace></main>
  <dialog class="settings-dialog" aria-labelledby="settings-title" data-settings-dialog>
    <form data-settings-form>
      <div class="dialog-header">
        <h2 id="settings-title">模型连接</h2><button class="icon-button" type="button" aria-label="关闭" data-close-settings>×</button>
      </div>
      <fieldset>
        <label>协议<select data-protocol></select></label>
        <label>Base URL<input type="url" autocomplete="off" placeholder="https://api.openai.com/v1" data-base-url required></label>
        <label>模型 ID<input type="text" autocomplete="off" data-model-id required></label>
        <label>API Key<input type="password" autocomplete="off" data-api-key></label>
        <label class="checkbox" data-remove-label hidden><input type="checkbox" data-remove-key>移除已保存的密钥</label>
      </fieldset>
      <p class="dialog-status" role="status" data-settings-status hidden></p>
      <div class="dialog-actions"><button type="button" data-clear-settings>清除连接</button><button type="submit" class="primary">保存</button></div>
    </form>
  </dialog>`;

const workspace = element(app, '[data-workspace]');
const settingsDialog = element<HTMLDialogElement>(app, '[data-settings-dialog]');
const settingsForm = element<HTMLFormElement>(settingsDialog, 'form');
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
const connectionDot = element(app, '[data-connection-dot]');

for (const [protocol, { label }] of Object.entries(protocols)) protocolInput.add(new Option(label, protocol));

let draft = loadDraft(builtInLevel);
let model: ModelSettings | null = null;
let disposeView = () => {};
let updateRun: ((next: ModelSettings | null) => void) | undefined;
let settingsRequest = 0;
let saving = false;

function renderRoute() {
  const editor = location.hash === '#/create';
  for (const item of app.querySelectorAll<HTMLElement>('[data-nav]')) {
    if (item.dataset.nav === (editor ? 'create' : 'play')) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (editor) renderEditor();
  else renderRun('play', builtInLevel);
}

function renderEditor() {
  disposeView();
  updateRun = undefined;
  disposeView = mountEditor(workspace, {
    initial: draft,
    save(level) {
      draft = level;
      saveDraft(level);
    },
    preview: (kind, level) => renderRun(kind, level),
  });
}

function renderRun(mode: RunMode, level: LevelDefinition) {
  disposeView();
  const view = mountRun(workspace, {
    mode, level, model,
    completedAt: mode === 'play' ? completion(builtInID) : undefined,
    onComplete: () => markCompleted(builtInID),
    reset: () => renderRun(mode, level),
    back: mode === 'play' ? () => { location.hash = '#/create'; } : renderEditor,
    openSettings,
  });
  disposeView = view.dispose;
  updateRun = view.onModelChange;
}

function applySettings(next: ModelSettings | null, reset = false) {
  const changed = next?.api !== model?.api || next?.baseURL !== model?.baseURL ||
    next?.model !== model?.model || next?.hasAPIKey !== model?.hasAPIKey;
  model = next;
  connectionDot.classList.toggle('connected', Boolean(model));
  if (changed || reset) updateRun?.(next);
}

function settingsMessage(text: string) {
  settingsStatus.textContent = text;
  settingsStatus.hidden = !text;
}

function fillSettings() {
  const api = model?.api ?? 'OpenAIResponses';
  protocolInput.value = api;
  addressInput.value = model?.baseURL ?? protocols[api].baseURL;
  modelInput.value = model?.model ?? '';
  keyInput.value = '';
  keyInput.placeholder = model?.hasAPIKey ? '已保存，留空可保留' : '输入模型 API Key';
  removeLabel.hidden = !model?.hasAPIKey;
  removeKey.checked = false;
  clearSettings.hidden = !model;
}

function lockSettings(locked: boolean) {
  settingsFields.disabled = submitSettings.disabled = clearSettings.disabled = locked;
}

async function loadSettings(inDialog: boolean) {
  const request = ++settingsRequest;
  if (inDialog) lockSettings(true);
  try {
    const next = await readSettings(AbortSignal.timeout(5000));
    if (request !== settingsRequest) return;
    applySettings(next);
    if (inDialog) fillSettings();
  } catch {
    if (request === settingsRequest && inDialog) settingsMessage('无法读取模型设置');
  } finally {
    if (request === settingsRequest && inDialog) lockSettings(false);
  }
}

function openSettings() {
  if (settingsDialog.open) return;
  settingsMessage('');
  fillSettings();
  settingsDialog.showModal();
  void loadSettings(true);
}

async function commitSettings(value: Parameters<typeof saveSettings>[0]) {
  if (saving) return;
  saving = true;
  settingsRequest++;
  lockSettings(true);
  settingsMessage('');
  try {
    applySettings(await saveSettings(value, AbortSignal.timeout(10000)), true);
    keyInput.value = '';
    settingsDialog.close();
  } catch (error) {
    settingsMessage(error instanceof Error && error.name !== 'TimeoutError' ? error.message : '保存模型设置超时');
  } finally {
    saving = false;
    lockSettings(false);
  }
}

element(app, '[data-settings]').addEventListener('click', openSettings);
element(settingsDialog, '[data-close-settings]').addEventListener('click', () => { if (!saving) settingsDialog.close(); });
settingsDialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
settingsDialog.addEventListener('close', () => { keyInput.value = ''; });
protocolInput.addEventListener('change', () => {
  const api = protocolInput.value as Protocol;
  addressInput.value = protocols[api].baseURL;
  const retainsKey = Boolean(model?.hasAPIKey && model.api === api && model.baseURL === addressInput.value);
  keyInput.value = '';
  keyInput.placeholder = retainsKey ? '已保存，留空可保留' : '输入模型 API Key';
  removeLabel.hidden = !retainsKey;
  removeKey.checked = false;
  settingsMessage('');
});
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
void loadSettings(false);
