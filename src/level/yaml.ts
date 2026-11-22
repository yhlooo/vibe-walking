import { parseDocument, stringify, visit } from 'yaml';
import { playableError, readLevel } from './definition.ts';
import type { LevelDefinition } from './definition.ts';

export const maxLevelBytes = 64 * 1024;

export function importLevel(source: string): LevelDefinition {
  const document = parseDocument(source, { uniqueKeys: true, version: '1.2', merge: false });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw new Error(issue.message);
  visit(document, {
    Alias() { throw new Error('关卡 YAML 不能使用别名'); },
    Node(_, node) {
      if (node.tag && !node.tag.startsWith('tag:yaml.org,2002:')) {
        throw new Error('关卡 YAML 不能使用自定义标签');
      }
    },
  });
  const level = readLevel(document.toJS({ maxAliasCount: 0 }));
  const problem = playableError(level);
  if (problem) throw new Error(problem);
  return level;
}

export function exportLevel(level: LevelDefinition): string {
  const normalized = readLevel(level);
  const problem = playableError(normalized);
  if (problem) throw new Error(problem);
  return stringify(normalized, { lineWidth: 0 });
}
