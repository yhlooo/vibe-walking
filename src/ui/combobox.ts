// 描述候选项的提交值和显示文字。
type Option = { value: string; label: string };

/** 为可自由输入的字段绑定可筛选、可键盘操作的候选列表。 */
export function editableCombobox(input: HTMLInputElement, list: HTMLElement, searchable = false) {
  let options: Option[] = [];
  let visible: Option[] = [];
  let open = false;
  let query = '';
  let active = -1;

  // 重绘当前候选项并同步辅助技术所需的选中状态。
  function render() {
    visible = open ? options.filter((option) => !query || option.label.toLowerCase().includes(query)) : [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.hidden = visible.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));

    const fragment = document.createDocumentFragment();
    for (const [index, option] of visible.entries()) {
      const item = document.createElement('li');
      item.id = `${list.id}-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.optionIndex = String(index);
      item.textContent = option.label;
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    list.scrollTop = 0;
  }

  // 按当前筛选结果打开下拉列表。
  function show() {
    if (open) return;
    open = true;
    render();
  }

  // 收起下拉列表并清除活动候选项。
  function close() {
    if (!open) return;
    open = false;
    render();
  }

  // 将选中的候选值应用到输入框并重置筛选条件。
  function setValue(value: string) {
    input.value = value;
    query = '';
    close();
  }

  input.addEventListener('focus', show);
  input.addEventListener('click', show);
  input.addEventListener('blur', close);
  input.addEventListener('input', () => {
    query = searchable ? input.value.trim().toLowerCase() : '';
    open = true;
    render();
  });

  // 处理导航、提交候选项和关闭列表的按键。
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      setValue(visible[active].value);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      show();
      if (list.hidden) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      list.children[active]?.setAttribute('aria-selected', 'false');

      // 从未选择状态向上移到末项，之后在候选列表首尾循环。
      active = active === -1 && direction < 0 ? visible.length - 1 : (active + direction + visible.length) % visible.length;
      const item = list.children[active];
      item.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    }
  });

  // 选择候选项时保留输入框焦点，避免列表先被收起。
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const index = event.target.closest<HTMLElement>('[data-option-index]')?.dataset.optionIndex;
    if (index !== undefined) setValue(visible[Number(index)].value);
  });

  return {
    close,
    setValue,
    // 替换候选列表并刷新展开状态。
    setOptions(next: Option[]) {
      options = next;
      if (open) render();
    },
  };
}
