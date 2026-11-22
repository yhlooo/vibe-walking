import { playableError, readLevel } from './definition.ts';
import type { LevelDefinition } from './definition.ts';

export const maxLevelBytes = 64 * 1024;

function playableLevel(value: unknown): LevelDefinition {
  const level = readLevel(value);
  const problem = playableError(level);
  if (problem) throw new Error(problem);
  return level;
}

export function importLevel(source: string): LevelDefinition {
  return playableLevel(JSON.parse(source));
}

export function exportLevel(level: LevelDefinition): string {
  return JSON.stringify(playableLevel(level), null, 2) + '\n';
}
