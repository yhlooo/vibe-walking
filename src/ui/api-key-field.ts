import { element } from './elements.ts';

/** 生成带本地存储说明和清除按钮的密钥输入框。 */
export function apiKeyFieldMarkup(id: string) {
  return `
    <div class="api-key-field">
      <div class="api-key-caption">
        <label for="${id}">API Key</label>
        <span class="api-key-note" id="${id}-note">（所有 API Key 都在本地存储仅用于调用模型 API ，不会上传到任何第三方）</span>
      </div>
      <div class="api-key-input">
        <input id="${id}" type="password" autocomplete="off" aria-describedby="${id}-note">
        <button class="api-key-clear" type="button" aria-label="清除 API Key" title="清除 API Key" hidden>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>`;
}

/** 管理密钥替换和清除状态，已保存的密钥只以占位符显示。 */
export function apiKeyField(root: HTMLElement, id: string, changed: () => void) {
  const input = element<HTMLInputElement>(root, `#${id}`);
  const clear = element<HTMLButtonElement>(root, `#${id} + button`);
  let saved = false;
  let cleared = false;

  // 仅在失焦时显示掩码，输入值始终只含用户填写的新密钥。
  function render() {
    const retained = saved && !cleared;
    input.placeholder = retained && !input.matches(':focus') ? '******' : '';
    clear.hidden = !retained && !input.value.trim();
  }

  input.addEventListener('focus', render);
  input.addEventListener('blur', render);
  input.addEventListener('input', () => {
    render();
    changed();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    cleared = saved;
    input.focus();
    render();
    changed();
  });

  return {
    /** 更新当前连接是否拥有可沿用的密钥。 */
    setSaved(next: boolean) {
      saved = next;
      if (!saved) cleared = false;
      render();
    },
    /** 清空当前编辑状态。 */
    reset() {
      input.value = '';
      cleared = false;
      render();
    },
    /** 空字符串明确清除密钥，未编辑时省略该字段。 */
    read() {
      return input.value.trim() || (cleared ? '' : undefined);
    },
  };
}
