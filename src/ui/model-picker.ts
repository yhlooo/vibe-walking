import { formatModelOptions, modelSettings, reasoningEffortOptions } from '../agent/settings.ts';
import type { ModelCatalog, ModelProvider, ModelSettings } from '../agent/settings.ts';
import { editableCombobox } from './combobox.ts';
import { element } from './elements.ts';

// 对话栏的弹出菜单共用视口定位及焦点管理。
function anchoredMenu(menu: HTMLElement, trigger: HTMLButtonElement, anchorPanel: HTMLElement, preferredWidth: number,
  signal: AbortSignal, opened: () => void, closed?: () => void) {
  const viewport = window.visualViewport;
  const isOpen = () => menu.matches(':popover-open');

  menu.popover = 'auto';
  trigger.setAttribute('popovertarget', menu.id);
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-expanded', 'false');

  // 用主面板决定展开方向，右侧子菜单的长度变化不会移动供应商列表。
  function position() {
    if (!isOpen()) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const gap = 5;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const leftEdge = viewportLeft + margin;
    const rightEdge = viewportLeft + (viewport?.width ?? document.documentElement.clientWidth) - margin;
    const topEdge = viewportTop + margin;
    const bottomEdge = viewportTop + (viewport?.height ?? document.documentElement.clientHeight) - margin;
    const width = Math.min(preferredWidth, rightEdge - leftEdge);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.min(Math.max(rect.left, leftEdge), rightEdge - width)}px`;

    const above = Math.max(0, Math.min(rect.top - gap, bottomEdge) - topEdge);
    const below = Math.max(0, bottomEdge - Math.max(rect.bottom + gap, topEdge));
    const naturalHeight = anchorPanel.scrollHeight + anchorPanel.offsetHeight - anchorPanel.clientHeight;
    const opensAbove = above >= naturalHeight || above >= below;
    menu.dataset.side = opensAbove ? 'above' : 'below';
    menu.style.setProperty('--model-menu-height', `${opensAbove ? above : below}px`);
    const top = opensAbove ? Math.min(rect.top - gap, bottomEdge) - menu.offsetHeight : Math.max(rect.bottom + gap, topEdge);
    menu.style.top = `${Math.max(topEdge, top)}px`;
    menu.style.visibility = 'visible';
  }

  function close(restoreFocus = false) {
    if (!isOpen()) return;
    menu.hidePopover();
    if (restoreFocus && !trigger.hidden && !trigger.disabled) trigger.focus({ preventScroll: true });
  }

  // 先收起当前菜单，避免 Esc 同时打开游戏菜单。
  function dismissOnEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !isOpen()) return;
    event.preventDefault();
    close(true);
  }

  const resize = new ResizeObserver(position);
  menu.addEventListener('beforetoggle', (event) => {
    const opening = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) {
      resize.observe(trigger);
      resize.observe(menu);
    } else {
      resize.disconnect();
      menu.style.visibility = '';
      closed?.();
    }
  }, { signal });
  menu.addEventListener('toggle', () => {
    if (!isOpen()) return;
    position();
    opened();
  }, { signal });
  window.addEventListener('resize', position, { signal });
  window.addEventListener('scroll', position, { capture: true, signal });
  viewport?.addEventListener('resize', position, { signal });
  viewport?.addEventListener('scroll', position, { signal });
  trigger.addEventListener('keydown', dismissOnEscape, { signal });
  menu.addEventListener('keydown', dismissOnEscape, { signal });
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof Node && event.target !== trigger && !menu.contains(event.target)) close();
  }, { signal });

  return { isOpen, position, close };
}

/** 挂载聊天栏的模型级联菜单及独立参数菜单。 */
export function modelPicker(root: HTMLElement, modelButton: HTMLButtonElement, optionsButton: HTMLButtonElement,
  signal: AbortSignal, select: (model: ModelSettings) => void) {
  const catalogMenu = document.createElement('section');
  catalogMenu.id = 'model-picker';
  catalogMenu.className = 'model-picker model-picker-catalog';
  catalogMenu.setAttribute('aria-labelledby', 'model-picker-title');
  catalogMenu.innerHTML = `
    <div class="model-picker-panel">
      <h2 id="model-picker-title" tabindex="-1">模型</h2>
      <div class="model-choices" data-model-providers></div>
    </div>
    <div class="model-picker-panel" id="model-picker-models" role="group" aria-labelledby="model-submenu-title" hidden>
      <h2 id="model-submenu-title"></h2>
      <div class="model-choices" data-provider-models></div>
    </div>`;
  root.append(catalogMenu);
  const providerPanel = element(catalogMenu, '.model-picker-panel');
  const catalogTitle = element(catalogMenu, '#model-picker-title');
  const providerList = element(catalogMenu, '[data-model-providers]');
  const modelPanel = element(catalogMenu, '#model-picker-models');
  const modelTitle = element(catalogMenu, '#model-submenu-title');
  const modelList = element(catalogMenu, '[data-provider-models]');
  const catalogPopup = anchoredMenu(catalogMenu, modelButton, providerPanel, 420, signal,
    () => catalogTitle.focus({ preventScroll: true }));

  const optionsMenu = document.createElement('section');
  optionsMenu.id = 'model-parameters';
  optionsMenu.className = 'model-picker model-picker-panel';
  optionsMenu.setAttribute('aria-labelledby', 'model-parameters-title');
  optionsMenu.innerHTML = `
    <h2 id="model-parameters-title" tabindex="-1">模型参数</h2>
    <div class="model-options">
      <div class="settings-combobox">
        <label for="model-picker-effort">思考强度</label>
        <div class="combobox-input">
          <input id="model-picker-effort" autocomplete="off" spellcheck="false" placeholder="默认" role="combobox"
            aria-autocomplete="none" aria-controls="model-picker-efforts" aria-expanded="false">
        </div>
        <ul id="model-picker-efforts" class="combobox-options" role="listbox" aria-label="思考强度" hidden></ul>
      </div>
      <label>上下文长度（Token）<input type="number" min="1" max="${Number.MAX_SAFE_INTEGER}" step="1" required></label>
    </div>`;
  root.append(optionsMenu);
  const optionsTitle = element(optionsMenu, '#model-parameters-title');
  const parameters = element(optionsMenu, '.model-options');
  const effort = element<HTMLInputElement>(parameters, '#model-picker-effort');
  const effortPicker = editableCombobox(effort, element(parameters, '#model-picker-efforts'));
  effortPicker.setOptions(reasoningEffortOptions);
  const context = element<HTMLInputElement>(parameters, 'input[type="number"]');
  const optionsPopup = anchoredMenu(optionsMenu, optionsButton, optionsMenu, 270, signal, () => {
    optionsMenu.scrollTop = 0;
    optionsTitle.focus({ preventScroll: true });
  }, effortPicker.close);

  let current: ModelSettings | null = null;
  let activeProviderButton: HTMLButtonElement | undefined;

  // 在供应商右侧展开对应模型，并保留左侧列表和当前指向。
  function showModels(provider: ModelProvider, button: HTMLButtonElement) {
    if (activeProviderButton === button) return;
    activeProviderButton?.setAttribute('aria-expanded', 'false');
    activeProviderButton = button;
    button.setAttribute('aria-expanded', 'true');
    modelPanel.hidden = false;
    modelTitle.textContent = provider.name || provider.id;
    modelList.replaceChildren();

    for (const model of provider.models) {
      const entry = modelSettings(provider, model);
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = entry.name;
      if (entry.model === current?.model) option.setAttribute('aria-current', 'true');
      option.addEventListener('click', () => {
        if (!current || modelButton.disabled) return;
        select(entry);
        catalogPopup.close(true);
      });
      modelList.append(option);
    }
    modelPanel.scrollTop = 0;
    catalogPopup.position();
  }

  // 失去鼠标悬停能力时，可用触摸或键盘进入右侧菜单。
  function showProviders(catalog: ModelCatalog, selected: ModelSettings) {
    activeProviderButton = undefined;
    modelPanel.hidden = true;
    modelList.replaceChildren();
    providerList.replaceChildren();
    providerPanel.scrollTop = 0;
    const providerID = selected.model.split('/', 1)[0];
    for (const provider of catalog.modelProviders) {
      if (!provider.models.length) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = provider.name || provider.id;
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', modelPanel.id);
      if (provider.id === providerID) button.setAttribute('aria-current', 'true');
      const reveal = () => showModels(provider, button);
      button.addEventListener('pointerenter', reveal);
      button.addEventListener('focus', reveal);
      button.addEventListener('click', (event) => {
        reveal();
        if (event.detail === 0) modelList.querySelector('button')?.focus();
      });
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        reveal();
        modelList.querySelector('button')?.focus();
      });
      providerList.append(button);
    }
  }

  modelList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft') return;
    event.preventDefault();
    activeProviderButton?.focus();
  }, { signal });

  optionsButton.addEventListener('click', () => {
    if (!current || optionsPopup.isOpen()) return;
    effortPicker.setValue(current.reasoningEffort);
    context.value = String(current.maxInputToken);
  }, { signal });

  // 合法输入和下拉选择直接更新当前对话参数。
  function updateOptions(event: Event) {
    if (!current || optionsButton.disabled || (event instanceof InputEvent && event.isComposing)) return;
    if (event.target === effort) {
      const reasoningEffort = effort.value.trim();
      if (current.reasoningEffort !== reasoningEffort) select({ ...current, reasoningEffort });
    } else if (event.target === context && context.validity.valid) {
      const maxInputToken = context.valueAsNumber;
      if (current.maxInputToken !== maxInputToken) select({ ...current, maxInputToken });
    }
  }

  parameters.addEventListener('input', updateOptions, { signal });
  parameters.addEventListener('change', updateOptions, { signal });
  effort.addEventListener('compositionend', updateOptions, { signal });
  context.addEventListener('blur', () => {
    if (current && !context.validity.valid) context.value = String(current.maxInputToken);
  }, { signal });

  return {
    // 在浏览器展开模型菜单前填入最新目录。
    prepare(catalog: ModelCatalog, selected: ModelSettings) {
      if (!catalogPopup.isOpen()) showProviders(catalog, selected);
    },
    close() {
      catalogPopup.close();
      optionsPopup.close();
    },
    showModel(model: ModelSettings | null) {
      current = model;
      modelButton.textContent = model?.name ?? '';
      modelButton.title = modelButton.textContent;
      const summary = model ? formatModelOptions(model) : '';
      optionsButton.textContent = summary;
      optionsButton.setAttribute('aria-label', summary ? `模型参数 ${summary}` : '模型参数');
    },
  };
}
