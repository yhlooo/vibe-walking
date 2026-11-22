export function element<T extends HTMLElement>(parent: ParentNode, selector: string): T {
  const node = parent.querySelector<T>(selector);
  if (!node) throw new Error(`缺少页面元素 ${selector}`);
  return node;
}

export function formatDuration(durationMS: number) {
  const seconds = Math.round(durationMS / 100) / 10;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${(seconds % 60).toFixed(1)} 秒` : `${seconds.toFixed(1)} 秒`;
}
