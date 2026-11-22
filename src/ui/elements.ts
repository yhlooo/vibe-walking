export function element<T extends HTMLElement>(parent: ParentNode, selector: string): T {
  const node = parent.querySelector<T>(selector);
  if (!node) throw new Error(`缺少页面元素 ${selector}`);
  return node;
}
