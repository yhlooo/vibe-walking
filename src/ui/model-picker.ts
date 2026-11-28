import { formatModelOptions, modelSettings, reasoningEfforts } from '../agent/settings.ts';
import type { ModelCatalog, ModelProvider, ModelSettings } from '../agent/settings.ts';
import { element } from './elements.ts';

/** 挂载游玩时使用的供应商、模型和参数选择弹窗。 */
export function modelPicker(root: HTMLElement, trigger: HTMLButtonElement, signal: AbortSignal, select: (model: ModelSettings) => void) {
  const modelName = document.createElement('span');
  modelName.className = 'model-trigger-name';
  const modelOptions = document.createElement('span');
  trigger.append(modelName, modelOptions);
  const dialog = document.createElement('dialog');
  dialog.className = 'model-picker';
  dialog.setAttribute('aria-labelledby', 'model-picker-title');
  dialog.innerHTML = `
    <div class="dialog-header">
      <h2 id="model-picker-title"></h2>
      <form method="dialog"><button class="icon-button" aria-label="关闭模型选择">×</button></form>
    </div>
    <div class="model-choices"></div>
    <form class="model-options" hidden>
      <label>思考强度<input list="model-picker-efforts" placeholder="默认"></label>
      <datalist id="model-picker-efforts"></datalist>
      <label>上下文长度（Token）<input type="number" min="1" max="${Number.MAX_SAFE_INTEGER}" step="1" required></label>
      <div class="dialog-actions"><button class="primary" type="submit">应用</button></div>
    </form>
    <button type="button" class="text-button" data-picker-back hidden>← 返回</button>`;
  root.append(dialog);
  const title = element(dialog, 'h2');
  const choices = element(dialog, '.model-choices');
  const parameters = element<HTMLFormElement>(dialog, '.model-options');
  const effort = element<HTMLInputElement>(parameters, 'input[list]');
  const context = element<HTMLInputElement>(parameters, 'input[type="number"]');
  const back = element<HTMLButtonElement>(dialog, '[data-picker-back]');
  element(dialog, 'datalist').append(...reasoningEfforts.map((value) => new Option(value, value)));

  let catalog: ModelCatalog;
  let current: ModelSettings;
  let provider: ModelProvider | undefined;
  let picked: ModelSettings | undefined;

  // 为当前选择层级建立一个可操作的选项。
  function option(label: string, action: () => void, selected: boolean) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (selected) button.className = 'current-model-choice';
    button.addEventListener('click', action);
    choices.append(button);
  }

  // 展示可选供应商并标记当前模型的来源。
  function showProviders() {
    provider = undefined;
    picked = undefined;
    parameters.hidden = back.hidden = true;
    title.textContent = '选择供应商';
    choices.replaceChildren();

    // 用复合 ID 的供应商部分标记当前选项。
    const activeProvider = current.model.split('/', 1)[0];
    for (const entry of catalog.modelProviders) {
      if (entry.models.length) option(entry.name || entry.id, () => showModels(entry), entry.id === activeProvider);
    }
    choices.querySelector('button')?.focus();
  }

  // 列出所选供应商的模型。
  function showModels(entry: ModelProvider) {
    provider = entry;
    picked = undefined;
    title.textContent = entry.name || entry.id;
    parameters.hidden = true;
    back.hidden = false;
    choices.replaceChildren();
    for (const model of entry.models) {
      // 回到当前模型时显示本局参数，其他模型使用目录中保存的值。
      const configured = modelSettings(entry, model);
      const selected = configured.model === current.model;
      option(configured.name, () => showParameters(selected ? current : configured), selected);
    }
    choices.querySelector('button')?.focus();
  }

  // 填入所选模型的可临时调整参数。
  function showParameters(model: ModelSettings) {
    picked = model;
    title.textContent = model.name;
    choices.replaceChildren();
    parameters.hidden = false;
    effort.value = model.reasoningEffort;
    context.value = String(model.maxInputToken);
    effort.focus();
  }

  back.addEventListener('click', () => {
    if (picked && provider) showModels(provider);
    else showProviders();
  }, { signal });

  // 提交本次游玩使用的模型参数覆盖值。
  parameters.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!picked || trigger.disabled) return;
    select({ ...picked, reasoningEffort: effort.value.trim(), maxInputToken: context.valueAsNumber });
    dialog.close();
  }, { signal });

  return {
    // 以当前模型目录和已选模型打开弹窗。
    open(nextCatalog: ModelCatalog, nextModel: ModelSettings) {
      catalog = nextCatalog;
      current = nextModel;
      dialog.showModal();
      showProviders();
    },
    close() { dialog.close(); },
    // 同步触发按钮上的当前模型摘要。
    showModel(model: ModelSettings | null) {
      modelName.textContent = model?.name ?? '';
      modelOptions.textContent = model ? formatModelOptions(model) : '';
      const label = model ? `${model.name} ${modelOptions.textContent}` : '';
      trigger.title = label;
      trigger.setAttribute('aria-label', label);
    },
  };
}
