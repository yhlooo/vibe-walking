import catalog from '../../levels/meta.json';
import { gridSize, playableError, readLevel, resizeLevel } from './definition.ts';
import type { LevelDefinition } from './definition.ts';

export function builtInBoard(level: LevelDefinition, rows: number, columns: number) {
  const current = gridSize(level.tiles);
  return current.rows === rows && current.columns === columns ? level : resizeLevel(level, rows, columns);
}

const definitions = import.meta.glob('../../levels/definitions/*.json', { eager: true, import: 'default' });
export const builtInLevels = catalog.map((entry) => {
  const level = readLevel(definitions[`../../levels/definitions/${entry.definition}`]);
  const problem = playableError(level);
  if (problem || entry.name !== level.name) throw new Error(problem ?? '内置关卡名称不一致');
  return { ...entry, level };
});
