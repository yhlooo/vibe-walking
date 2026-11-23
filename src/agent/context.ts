import { summaryImagePlaceholder } from './prompts.ts';

type Item = Record<string, unknown>;

export type ContextUsage = { key: string; estimate: number; tokens: number };

function contextJSON(history: Item[], image: string): string {
  return JSON.stringify(history, (key, value: unknown) => {
    if (key === 'encrypted_content' || key === 'signature' || key === 'reasoning_content') return undefined;
    if (key === 'images' && Array.isArray(value)) return value.map(() => image);
    if (typeof value === 'string' && (value.startsWith('data:image/') || key === 'data')) return image;
    return value;
  });
}

export function estimateContext(prompt: string, history: Item[]): number {
  const text = prompt + contextJSON(history, '<image>');
  const nonASCII = text.match(/[^\x00-\x7f]/gu)?.length ?? 0;
  const images = text.match(/<image>/g)?.length ?? 0;
  return Math.ceil((text.length - nonASCII) / 3.5 + nonASCII + images * 1500) + 500;
}

export function contextToSummarize(history: Item[]): string {
  return contextJSON(history, summaryImagePlaceholder);
}
