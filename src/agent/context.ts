import { summaryImagePlaceholder } from './prompts.ts';

// 表示一项协议原生历史消息。
type Item = Record<string, unknown>;

/** 把上游输入用量和同次本地估算绑定到一个请求配置。 */
export type ContextUsage = { key: string; estimate: number; tokens: number };

// 序列化历史，并以指定文本替换截图数据。
function contextJSON(history: Item[], image: string): string {
  return JSON.stringify(history, (key, value: unknown) => {
    // 压缩与估算只使用可读内容，协议附带的加密数据和签名不会进入文本。
    if (key === 'encrypted_content' || key === 'signature' || key === 'reasoning_content') return undefined;
    if (key === 'images' && Array.isArray(value)) return value.map(() => image);
    if (typeof value === 'string' && (value.startsWith('data:image/') || key === 'data')) return image;
    return value;
  });
}

/** 根据提示词和序列化历史粗估 Token 用量。 */
export function estimateContext(prompt: string, history: Item[]): number {
  const text = prompt + contextJSON(history, '<image>');

  // 区分 ASCII、其他字符和截图的估算开销，再加上固定余量。
  const nonASCII = text.match(/[^\x00-\x7f]/gu)?.length ?? 0;
  const images = text.match(/<image>/g)?.length ?? 0;
  return Math.ceil((text.length - nonASCII) / 3.5 + nonASCII + images * 1500) + 500;
}

/** 生成供模型进行历史压缩的文本。 */
export function contextToSummarize(history: Item[]): string {
  return contextJSON(history, summaryImagePlaceholder);
}
