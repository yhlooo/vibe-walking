import { playableError, readLevel } from './definition.ts';
import type { LevelDefinition } from './definition.ts';

/** 限制可导入关卡 JSON 的字节数。 */
export const maxLevelBytes = 64 * 1024;

// 校验结构，并要求关卡具备可玩条件。
function playableLevel(value: unknown): LevelDefinition {
  const level = readLevel(value);
  const problem = playableError(level);
  if (problem) throw new Error(problem);
  return level;
}

/** 解析外部 JSON 并返回可用关卡。 */
export function importLevel(source: string): LevelDefinition {
  return playableLevel(JSON.parse(source));
}

/** 校验关卡后生成可下载的格式化 JSON。 */
export function exportLevel(level: LevelDefinition): string {
  return JSON.stringify(playableLevel(level), null, 2) + '\n';
}
