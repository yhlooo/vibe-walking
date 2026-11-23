type Option = { value: string; label: string };

export function editableCombobox(input: HTMLInputElement, list: HTMLElement, searchable = false) {
  let options: Option[] = [];
  let visible: Option[] = [];
  let open = false;
  let query = '';
  let active = -1;

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

  function show() {
    if (open) return;
    open = true;
    render();
  }

  function close() {
    if (!open) return;
    open = false;
    render();
  }

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
      active = active === -1 && direction < 0 ? visible.length - 1 : (active + direction + visible.length) % visible.length;
      const item = list.children[active];
      item.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    }
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const index = event.target.closest<HTMLElement>('[data-option-index]')?.dataset.optionIndex;
    if (index !== undefined) setValue(visible[Number(index)].value);
  });

  return {
    close,
    setValue,
    setOptions(next: Option[]) {
      options = next;
      if (open) render();
    },
  };
}
