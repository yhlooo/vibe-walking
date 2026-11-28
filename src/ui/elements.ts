/** 查询必需的 DOM 节点，节点缺失时报告选择器。 */
export function element<T extends HTMLElement>(parent: ParentNode, selector: string): T {
  const node = parent.querySelector<T>(selector);
  if (!node) throw new Error(`缺少页面元素 ${selector}`);
  return node;
}

/** 将毫秒时长格式化为界面用的可读文本。 */
export function formatDuration(durationMS: number) {
  const seconds = Math.round(durationMS / 100) / 10;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${(seconds % 60).toFixed(1)} 秒` : `${seconds.toFixed(1)} 秒`;
}
