import {
  defaultMaxInputToken, defaultProtocol, discoverProviderModels, listModels, protocols, reasoningEffortOptions,
} from '../agent/settings.ts';
import type { Model, ModelCatalog, ModelProvider, Protocol, ProviderUpdate } from '../agent/settings.ts';
import { apiKeyField, apiKeyFieldMarkup } from './api-key-field.ts';
import { editableCombobox } from './combobox.ts';
import { element } from './elements.ts';

// 表示供应商和模型都能复用的可折叠编辑行。
type EditRow = { node: HTMLDetailsElement };

// 按列表跟踪正在拖动的行，避免跨列表排序。
const draggedRows = new WeakMap<HTMLElement, EditRow>();

// 将模型行的表单和候选项关联起来。
type ModelRow = EditRow & { key: string; read: () => Model; picker: ReturnType<typeof editableCombobox> };

// 将供应商编辑节点、模型行和原始配置关联起来。
type ProviderRow = EditRow & { models: ModelRow[]; read: () => ProviderUpdate; previous?: ModelProvider };

// 为列表标题生成右对齐的添加入口。
function listHeading(tag: 'h3' | 'h4', title: string, addLabel: string, attribute: string) {
  return `
    <div class="provider-list-heading">
      <${tag}>${title}</${tag}>
      <button class="provider-icon-button" type="button" aria-label="${addLabel}" title="${addLabel}" ${attribute}>
        <span class="provider-add-icon" aria-hidden="true">+</span>
      </button>
    </div>`;
}

// 为列表行绑定拖动排序和标题栏删除操作。
function orderedRow<T extends EditRow>(row: T, rows: T[], list: HTMLElement, add: HTMLButtonElement, label: string,
  changed: () => void, onRemove?: () => void) {
  const summary = element(row.node, 'summary');
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.textContent = '⠿';
  handle.title = `拖动调整${label}顺序`;
  handle.setAttribute('aria-hidden', 'true');
  summary.prepend(handle);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'provider-icon-button provider-remove';
  remove.setAttribute('aria-label', `删除${label}`);
  remove.title = `删除${label}`;
  remove.innerHTML = '<span class="provider-trash-icon" aria-hidden="true"></span>';
  summary.append(remove);
  remove.addEventListener('click', (event) => {
    // 删除折叠行时不触发标题栏的展开操作，并把焦点交给相邻行。
    event.preventDefault();
    event.stopPropagation();
    const index = rows.indexOf(row);
    rows.splice(index, 1);
    row.node.remove();
    onRemove?.();
    changed();
    const next = rows[index] ?? rows[index - 1];
    if (next) element<HTMLElement>(next.node, 'summary').focus();
    else add.focus();
  });

  // 同时调整表单节点和行数组的顺序。
  function move(source: T, target: T, after: boolean) {
    if (target === source) return;

    // 先移出源行，再以目标行在剩余列表中的位置计算插入点。
    rows.splice(rows.indexOf(source), 1);
    rows.splice(rows.indexOf(target) + Number(after), 0, source);
    if (after) target.node.after(source.node);
    else target.node.before(source.node);
    changed();
  }

  // 记录拖动来源，并仅允许当前列表内交换位置。
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

/** 挂载供应商和模型目录编辑表单。 */
export function providerSettings(root: HTMLElement) {
  root.innerHTML = `
    <h2>模型</h2>
    <label>默认模型<select data-default-model></select></label>
    ${listHeading('h3', '模型供应商', '添加模型供应商', 'data-add-provider')}
    <div class="provider-list" data-provider-list></div>`;
  const list = element(root, '[data-provider-list]');
  const addProviderButton = element<HTMLButtonElement>(root, '[data-add-provider]');
  const defaultSelect = element<HTMLSelectElement>(root, '[data-default-model]');
  let providers: ProviderRow[] = [];
  let nextKey = 0;
  let discoveryScope = new AbortController();

  // 根据供应商及模型行重建默认模型选项。
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

  // 创建供应商编辑行，并按需填入已保存的配置。
  function addProvider(previous?: ModelProvider) {
    const node = document.createElement('details');
    const keyID = `provider-api-key-${++nextKey}`;
    node.className = 'provider-card';
    node.innerHTML = `
      <summary><span data-title></span></summary>
      <div class="provider-fields">
        <label>供应商 ID<input data-provider-id pattern="[a-z][0-9a-z._\\-]*" required></label>
        <label>显示名称<input data-provider-name></label>
        <label>协议<select data-protocol></select></label>
        <label>Base URL<input type="url" autocomplete="off" data-url required></label>
        ${apiKeyFieldMarkup(keyID)}
        ${listHeading('h4', '模型', '添加模型', 'data-add-model')}
        <div class="provider-list" data-model-list></div>
        <p class="settings-status" id="provider-discovery-${++nextKey}" role="status" hidden></p>
      </div>`;
    const id = element<HTMLInputElement>(node, '[data-provider-id]');
    const name = element<HTMLInputElement>(node, '[data-provider-name]');
    const protocol = element<HTMLSelectElement>(node, '[data-protocol]');
    const url = element<HTMLInputElement>(node, '[data-url]');
    const key = apiKeyField(node, keyID, resetModelList);
    const title = element(node, '[data-title]');
    const modelList = element(node, '[data-model-list]');
    const addModelButton = element<HTMLButtonElement>(node, '[data-add-model]');
    const status = element<HTMLElement>(node, '[role="status"]');
    const scope = discoveryScope.signal;
    let request: AbortController | undefined;
    let options: { value: string; label: string }[] | undefined;
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
    orderedRow(row, providers, list, addProviderButton, '供应商', refreshDefault, () => request?.abort());

    // 空字符串表示主动清除密钥，省略时由服务决定是否沿用。
    function connection() {
      return {
        protocol: protocol.value as Protocol, baseURL: url.value.trim(),
        apiKey: key.read(),
      };
    }

    // 同步供应商折叠标题和默认模型选项。
    function syncTitle() {
      title.textContent = name.value.trim() || id.value.trim() || '新供应商';
      refreshDefault();
    }
    id.addEventListener('input', syncTitle);
    name.addEventListener('input', syncTitle);

    // 判断当前表单是否仍指向原供应商的连接端点。
    function sameEndpoint() {
      return previous?.protocol === protocol.value && previous.baseURL === url.value.trim().replace(/\/+$/, '');
    }

    // 连接或密钥变化后，丢弃原连接的模型候选项。
    function resetModelList() {
      request?.abort();
      request = undefined;
      options = undefined;
      for (const model of models) model.picker.setOptions([]);
      status.hidden = true;
    }

    function connectionChanged() {
      key.setSaved(Boolean(previous?.hasAPIKey && sameEndpoint()));
      resetModelList();
    }

    protocol.addEventListener('change', () => {
      url.value = protocols[protocol.value as Protocol].baseURL;
      key.reset();
      connectionChanged();
    });
    url.addEventListener('input', connectionChanged);

    // 首次与模型 ID 字段交互时读取同一供应商的候选模型。
    async function loadModels() {
      if (request || options || !url.value.trim() || !url.validity.valid) return;
      const current = request = new AbortController();
      const signal = AbortSignal.any([current.signal, scope, AbortSignal.timeout(17000)]);
      status.hidden = false;
      status.classList.remove('invalid');
      status.textContent = '正在读取模型列表…';
      try {
        const draft = connection();

        // 原端点且凭据未编辑时走已保存连接接口，其余情况用表单连接查询。
        const ids = previous && sameEndpoint() && draft.apiKey === undefined
          ? await discoverProviderModels(previous.id, signal)
          : await listModels(draft, signal, previous?.id);
        if (signal.aborted) return;
        options = ids.map((id) => ({ value: id, label: id }));
        for (const model of models) model.picker.setOptions(options);
        status.hidden = ids.length > 0;
        status.textContent = ids.length ? '' : '上游模型列表为空，可手动输入';
      } catch (error) {
        if (current.signal.aborted || scope.aborted) return;
        status.classList.add('invalid');
        const message = error instanceof Error && error.name === 'TimeoutError' ? '读取模型列表超时'
          : error instanceof Error && error.name === 'Error' ? error.message : '无法读取模型列表';
        status.textContent = `${message}，可手动输入`;
      } finally {
        if (request === current) request = undefined;
      }
    }

    // 为供应商新增一行可编辑的模型配置。
    function addModel(previous?: Model) {
      const detail = document.createElement('details');
      const modelKey = String(++nextKey);
      detail.className = 'provider-card';
      detail.innerHTML = `
        <summary><span data-title></span></summary>
        <div class="provider-fields">
          <div class="settings-combobox">
            <label for="provider-model-id-${modelKey}">模型 ID</label>
            <div class="combobox-input">
              <input id="provider-model-id-${modelKey}" data-id autocomplete="off" spellcheck="false" role="combobox"
                aria-autocomplete="list" aria-controls="provider-model-ids-${modelKey}" aria-expanded="false"
                aria-describedby="${status.id}" required>
            </div>
            <ul id="provider-model-ids-${modelKey}" class="combobox-options" role="listbox" aria-label="模型 ID" hidden></ul>
          </div>
          <label>显示名称<input data-name></label>
          <div class="settings-combobox">
            <label for="provider-model-effort-${modelKey}">思考强度</label>
            <div class="combobox-input">
              <input id="provider-model-effort-${modelKey}" data-effort autocomplete="off" spellcheck="false"
                placeholder="默认" role="combobox" aria-autocomplete="none"
                aria-controls="provider-model-efforts-${modelKey}" aria-expanded="false">
            </div>
            <ul id="provider-model-efforts-${modelKey}" class="combobox-options" role="listbox" aria-label="思考强度" hidden></ul>
          </div>
          <label>上下文长度（Token）<input data-context type="number" min="1" max="${Number.MAX_SAFE_INTEGER}" step="1" required></label>
          <label class="setting-check"><input type="checkbox" data-vision>支持视觉理解</label>
        </div>`;
      const id = element<HTMLInputElement>(detail, '[data-id]');
      const name = element<HTMLInputElement>(detail, '[data-name]');
      const effort = element<HTMLInputElement>(detail, '[data-effort]');
      const context = element<HTMLInputElement>(detail, '[data-context]');
      const vision = element<HTMLInputElement>(detail, '[data-vision]');
      const title = element(detail, '[data-title]');

      // 模型 ID 按输入筛选，思考强度保留完整候选列表。
      const picker = editableCombobox(id, element(detail, `#provider-model-ids-${modelKey}`), true);
      if (options) picker.setOptions(options);
      editableCombobox(effort, element(detail, `#provider-model-efforts-${modelKey}`)).setOptions(reasoningEffortOptions);
      for (const event of ['focus', 'click', 'input']) id.addEventListener(event, loadModels);
      id.value = previous?.id ?? '';
      name.value = previous?.name ?? '';
      effort.value = previous?.reasoningEffort ?? '';
      context.value = String(previous?.maxInputToken ?? defaultMaxInputToken);
      vision.checked = previous?.vision ?? true;
      const model: ModelRow = { node: detail, key: modelKey, picker, read: () => ({
        id: id.value.trim(), name: name.value.trim(), reasoningEffort: effort.value.trim(),
        maxInputToken: context.valueAsNumber, vision: vision.checked,
      }) };
      models.push(model);
      modelList.append(detail);
      orderedRow(model, models, modelList, addModelButton, '模型', refreshDefault);

      // 刷新模型折叠标题和默认模型候选项。
      function syncModel() {
        title.textContent = name.value.trim() || id.value.trim() || '新模型';
        refreshDefault();
      }
      id.addEventListener('input', syncModel);
      id.addEventListener('change', syncModel);
      name.addEventListener('input', syncModel);
      syncModel();
      if (!previous) {
        detail.open = true;
        id.focus();
      }
    }
    addModelButton.addEventListener('click', () => addModel());
    previous?.models.forEach(addModel);
    syncTitle();
    connectionChanged();
    if (!previous) {
      node.open = true;
      id.focus();
    }
  }

  addProviderButton.addEventListener('click', () => addProvider());

  return {
    // 取消旧发现请求，并从最新设置重建编辑表单。
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
    // 展开包含无效字段的编辑区并显示浏览器校验提示。
    validate() {
      const invalid = [...root.querySelectorAll<HTMLInputElement>('input:invalid')][0];
      if (!invalid) return true;
      for (let parent = invalid.parentElement; parent && parent !== root; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      invalid.reportValidity();
      return false;
    },
    // 导出供应商顺序，并将默认模型的稳定键转换为当前复合 ID。
    read() {
      const modelProviders = providers.map((provider) => provider.read());
      let defaultModel = '';
      for (const [i, provider] of providers.entries()) {
        // 用行的稳定键定位选择，再以编辑后的供应商及模型 ID 构造保存值。
        const j = provider.models.findIndex(({ key }) => key === defaultSelect.value);
        if (j >= 0) defaultModel = `${modelProviders[i].id}/${modelProviders[i].models[j].id}`;
      }
      return { defaultModel, modelProviders };
    },
  };
}
