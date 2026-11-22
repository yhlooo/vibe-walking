import catalog from '../../levels/meta.json';
import { playableError, readLevel } from './definition.ts';

const definitions = import.meta.glob('../../levels/definitions/*.json', { eager: true, import: 'default' });
const entry = catalog[0];
export const builtInLevel = readLevel(definitions[`../../levels/definitions/${entry.definition}`]);
const problem = playableError(builtInLevel);
if (problem || entry.name !== builtInLevel.name) throw new Error(problem ?? '内置关卡名称不一致');

export const builtInID = entry.id;
