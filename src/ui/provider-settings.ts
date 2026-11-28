import {
  defaultMaxInputToken, defaultProtocol, discoverProviderModels, listModels, protocols, reasoningEfforts,
} from '../agent/settings.ts';
import type { Model, ModelCatalog, ModelProvider, Protocol, ProviderUpdate } from '../agent/settings.ts';
import { element } from './elements.ts';

type EditRow = { node: HTMLDetailsElement };
const draggedRows = new WeakMap<HTMLElement, EditRow>();
type ModelRow = EditRow & { key: string; read: () => Model };
type ProviderRow = EditRow & { models: ModelRow[]; read: () => ProviderUpdate; previous?: ModelProvider };

function button(text: string) {
  const result = document.createElement('button');
  result.type = 'button';
  result.textContent = text;
  return result;
}

function orderedRow<T extends EditRow>(row: T, rows: T[], list: HTMLElement, label: string, changed: () => void) {
  const summary = element(row.node, 'summary');
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.textContent = '⠿';
  handle.title = `拖动调整${label}顺序`;
  handle.setAttribute('aria-hidden', 'true');
  summary.prepend(handle);
  const actions = element(row.node, '[data-order-actions]');

  function move(source: T, target: T, after: boolean) {
    if (target === source) return;
    rows.splice(rows.indexOf(source), 1);
    rows.splice(rows.indexOf(target) + Number(after), 0, source);
    if (after) target.node.after(source.node);
    else target.node.before(source.node);
    changed();
  }

  for (const direction of [-1, 1]) {
    const control = button(direction < 0 ? '上移' : '下移');
    control.setAttribute('aria-label', `${control.textContent}${label}`);
    control.addEventListener('click', () => {
      const target = rows[rows.indexOf(row) + direction];
      if (target) move(row, target, direction > 0);
      control.focus();
    });
    actions.append(control);
  }
  const remove = button('删除');
  remove.setAttribute('aria-label', `删除${label}`);
  remove.addEventListener('click', () => {
    rows.splice(rows.indexOf(row), 1);
    row.node.remove();
    changed();
  });
  actions.append(remove);

  handle.addEventListener('dragstart', (event) => {
    event.stopPropagation();
    if (!event.dataTransfer) return;
    draggedRows.set(list, row);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', label);
  });
  handle.addEventListener('dragend', () => draggedRows.delete(list));
  summary.addEventListener('dragover', (event) => {
    if (!draggedRows.has(list)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  summary.addEventListener('drop', (event) => {
    const from = rows.find((candidate) => candidate === draggedRows.get(list));
    if (!from) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = summary.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    draggedRows.delete(list);
    move(from, row, after);
  });
}

export function providerSettings(root: HTMLElement) {
  root.innerHTML = `
    <h2>模型供应商</h2>
    <label>默认模型<select data-default-model></select></label>
    <div class="provider-list" data-provider-list></div>
    <div class="settings-actions"><button type="button" data-add-provider>添加供应商</button></div>`;
  const list = element(root, '[data-provider-list]');
  const defaultSelect = element<HTMLSelectElement>(root, '[data-default-model]');
  let providers: ProviderRow[] = [];
  let nextKey = 0;
  let discoveryScope = new AbortController();

  function refreshDefault() {
    const selected = defaultSelect.value;
    defaultSelect.replaceChildren();
    for (const provider of providers) {
      const id = element<HTMLInputElement>(provider.node, '[data-provider-id]').value.trim();
      const name = element<HTMLInputElement>(provider.node, '[data-provider-name]').value.trim();
      for (const model of provider.models) {
        const entry = model.read();
        if (id && entry.id) defaultSelect.add(new Option(`${name || id} / ${entry.name || entry.id}`, model.key));
      }
    }
    defaultSelect.disabled = defaultSelect.length === 0;
    if (defaultSelect.disabled) defaultSelect.add(new Option('请先添加模型', ''));
    if ([...defaultSelect.options].some(({ value }) => value === selected)) defaultSelect.value = selected;
  }

  function addProvider(previous?: ModelProvider) {
    const node = document.createElement('details');
    node.className = 'provider-card';
    node.innerHTML = `
      <summary><span data-title></span></summary>
      <div class="provider-fields">
        <label>供应商 ID<input data-provider-id pattern="[a-z][0-9a-z._\\-]*" required></label>
        <label>显示名称<input data-provider-name></label>
        <label>协议<select data-protocol></select></label>
        <label>Base URL<input type="url" autocomplete="off" data-url required></label>
        <label>API Key<input type="password" autocomplete="off" data-key></label>
        <label class="setting-check" data-clear-key hidden><input type="checkbox">清除已保存的 API Key</label>
        <div class="provider-list" data-model-list></div>
        <div class="provider-actions">
          <button type="button" data-add-model>添加模型</button>
          <button type="button" data-discover>读取上游模型</button>
        </div>
        <p class="settings-status" data-discovery-status role="status" hidden></p>
        <div class="provider-actions" data-order-actions></div>
      </div>`;
    const id = element<HTMLInputElement>(node, '[data-provider-id]');
    const name = element<HTMLInputElement>(node, '[data-provider-name]');
    const protocol = element<HTMLSelectElement>(node, '[data-protocol]');
    const url = element<HTMLInputElement>(node, '[data-url]');
    const key = element<HTMLInputElement>(node, '[data-key]');
    const clearKey = element(node, '[data-clear-key]');
    const clear = element<HTMLInputElement>(clearKey, 'input');
    const title = element(node, '[data-title]');
    const modelList = element(node, '[data-model-list]');
    const discover = element<HTMLButtonElement>(node, '[data-discover]');
    const status = element(node, '[data-discovery-status]');
    const suggestions = document.createElement('datalist');
    suggestions.id = `provider-models-${++nextKey}`;
    node.append(suggestions);
    const efforts = document.createElement('datalist');
    efforts.id = `provider-efforts-${nextKey}`;
    efforts.append(...reasoningEfforts.map((value) => new Option(value, value)));
    node.append(efforts);
    for (const [value, { label }] of Object.entries(protocols)) protocol.add(new Option(label, value));
    protocol.value = previous?.protocol ?? defaultProtocol;
    url.value = previous?.baseURL ?? protocols[protocol.value as Protocol].baseURL;
    id.value = previous?.id ?? '';
    name.value = previous?.name ?? '';

    const models: ModelRow[] = [];
    const row: ProviderRow = { node, models, previous, read: () => ({
      id: id.value.trim(), name: name.value.trim(), ...connection(),
      ...(previous && id.value.trim() !== previous.id ? { previousID: previous.id } : {}),
      models: models.map((model) => model.read()),
    }) };
    providers.push(row);
    list.append(node);
    orderedRow(row, providers, list, '供应商', refreshDefault);

    function connection() {
      return {
        protocol: protocol.value as Protocol, baseURL: url.value.trim(),
        ...(clear.checked ? { apiKey: '' } : key.value.trim() ? { apiKey: key.value.trim() } : {}),
      };
    }

    function syncTitle() {
      title.textContent = name.value.trim() || id.value.trim() || '新供应商';
      refreshDefault();
    }
    id.addEventListener('input', syncTitle);
    name.addEventListener('input', syncTitle);

    function sameEndpoint() {
      return previous?.protocol === protocol.value && previous.baseURL === url.value.trim().replace(/\/+$/, '');
    }
    let request: AbortController | undefined;
    function connectionChanged() {
      request?.abort();
      request = undefined;
      discover.disabled = false;
      suggestions.replaceChildren();
      status.hidden = true;
      clearKey.hidden = !previous?.hasAPIKey || !sameEndpoint();
      if (clearKey.hidden) clear.checked = false;
      key.disabled = clear.checked;
      key.placeholder = clearKey.hidden ? '可留空' : '已保存，留空可保留';
    }
    protocol.addEventListener('change', () => {
      url.value = protocols[protocol.value as Protocol].baseURL;
      key.value = '';
      connectionChanged();
    });
    url.addEventListener('input', connectionChanged);
    key.addEventListener('input', connectionChanged);
    clear.addEventListener('change', connectionChanged);
    discover.addEventListener('click', async () => {
      if (!url.reportValidity()) return;
      const current = request = new AbortController();
      const signal = AbortSignal.any([current.signal, discoveryScope.signal, AbortSignal.timeout(17000)]);
      discover.disabled = true;
      status.hidden = false;
      status.classList.remove('invalid');
      status.textContent = '正在读取模型列表…';
      try {
        const draft = connection();
        const ids = previous && sameEndpoint() && draft.apiKey === undefined
          ? await discoverProviderModels(previous.id, signal)
          : await listModels(draft, signal, previous?.id);
        if (current.signal.aborted) return;
        suggestions.replaceChildren(...ids.map((id) => new Option(id, id)));
        status.textContent = ids.length ? `已读取 ${ids.length} 个模型，可在模型 ID 输入框选择` : '上游模型列表为空，可手动输入';
      } catch (error) {
        if (current.signal.aborted || !node.isConnected) return;
        status.classList.add('invalid');
        status.textContent = error instanceof Error && error.name !== 'TimeoutError' ? error.message : '读取模型列表超时';
      } finally {
        if (request === current) {
          request = undefined;
          discover.disabled = false;
        }
      }
    });

    function addModel(previous?: Model) {
      const detail = document.createElement('details');
      detail.className = 'provider-card';
      detail.innerHTML = `
        <summary><span data-title></span></summary>
        <div class="provider-fields">
          <label>模型 ID<input data-id list="${suggestions.id}" autocomplete="off" required></label>
          <label>显示名称<input data-name></label>
          <label>思考强度<input data-effort list="${efforts.id}" placeholder="默认"></label>
          <label>上下文长度（Token）<input data-context type="number" min="1" max="${Number.MAX_SAFE_INTEGER}" step="1" required></label>
          <label class="setting-check"><input type="checkbox" data-vision>支持视觉理解</label>
          <div class="provider-actions" data-order-actions></div>
        </div>`;
      const id = element<HTMLInputElement>(detail, '[data-id]');
      const name = element<HTMLInputElement>(detail, '[data-name]');
      const effort = element<HTMLInputElement>(detail, '[data-effort]');
      const context = element<HTMLInputElement>(detail, '[data-context]');
      const vision = element<HTMLInputElement>(detail, '[data-vision]');
      const title = element(detail, '[data-title]');
      id.value = previous?.id ?? '';
      name.value = previous?.name ?? '';
      effort.value = previous?.reasoningEffort ?? '';
      context.value = String(previous?.maxInputToken ?? defaultMaxInputToken);
      vision.checked = previous?.vision ?? true;
      const model: ModelRow = { node: detail, key: String(++nextKey), read: () => ({
        id: id.value.trim(), name: name.value.trim(), reasoningEffort: effort.value.trim(),
        maxInputToken: context.valueAsNumber, vision: vision.checked,
      }) };
      models.push(model);
      modelList.append(detail);
      orderedRow(model, models, modelList, '模型', refreshDefault);

      function syncModel() {
        title.textContent = name.value.trim() || id.value.trim() || '新模型';
        refreshDefault();
      }
      id.addEventListener('input', syncModel);
      name.addEventListener('input', syncModel);
      syncModel();
      if (!previous) {
        detail.open = true;
        id.focus();
      }
    }
    element(node, '[data-add-model]').addEventListener('click', () => addModel());
    previous?.models.forEach(addModel);
    syncTitle();
    connectionChanged();
    if (!previous) {
      node.open = true;
      id.focus();
    }
  }

  element(root, '[data-add-provider]').addEventListener('click', () => addProvider());

  return {
    fill(catalog: ModelCatalog) {
      discoveryScope.abort();
      discoveryScope = new AbortController();
      list.replaceChildren();
      providers = [];
      catalog.modelProviders.forEach(addProvider);
      refreshDefault();
      for (const provider of providers) {
        const model = provider.models.find((entry) => `${provider.previous?.id}/${entry.read().id}` === catalog.defaultModel);
        if (model) defaultSelect.value = model.key;
      }
    },
    validate() {
      const invalid = [...root.querySelectorAll<HTMLInputElement>('input:invalid')][0];
      if (!invalid) return true;
      for (let parent = invalid.parentElement; parent && parent !== root; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      invalid.reportValidity();
      return false;
    },
    read() {
      const modelProviders = providers.map((provider) => provider.read());
      let defaultModel = '';
      for (const [i, provider] of providers.entries()) {
        const j = provider.models.findIndex(({ key }) => key === defaultSelect.value);
        if (j >= 0) defaultModel = `${modelProviders[i].id}/${modelProviders[i].models[j].id}`;
      }
      return { defaultModel, modelProviders };
    },
  };
}
