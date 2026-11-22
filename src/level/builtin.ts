import catalog from '../../levels/meta.json';
import { playableError, readLevel } from './definition.ts';

const definitions = import.meta.glob('../../levels/definitions/*.json', { eager: true, import: 'default' });
export const builtInLevels = catalog.map((entry) => {
  const level = readLevel(definitions[`../../levels/definitions/${entry.definition}`]);
  const problem = playableError(level);
  if (problem || entry.name !== level.name) throw new Error(problem ?? '内置关卡名称不一致');
  return { ...entry, level };
});
