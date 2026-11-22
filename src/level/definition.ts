export const columns = 16;
export const rows = 9;

export type Tile = '.' | '#' | 'B';
export type Point = { x: number; y: number };

export type LevelDefinition = {
  schemaVersion: 1;
  name: string;
  tiles: string[];
  spawn: Point;
  gravity: number;
  inertia: number;
  systemPrompt?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFields(value: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`未知字段：${unknown}`);
}

function numberField(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
  }
  return value;
}

export function readLevel(value: unknown): LevelDefinition {
  if (!isRecord(value)) throw new Error('关卡定义必须是对象');
  requireFields(value, ['schemaVersion', 'name', 'tiles', 'spawn', 'gravity', 'inertia', 'systemPrompt']);
  if (value.schemaVersion !== 1) throw new Error('关卡 schemaVersion 必须为 1');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80) throw new Error('关卡名必须为 1 到 80 个字符');

  if (!Array.isArray(value.tiles) || value.tiles.length !== rows) {
    throw new Error(`地图必须包含 ${rows} 行`);
  }
  const tiles = value.tiles.map((row: unknown, index): string => {
    if (typeof row !== 'string' || row.length !== columns || /[^.#B]/.test(row)) {
      throw new Error(`地图第 ${index + 1} 行须为 ${columns} 个 .、# 或 B`);
    }
    return row;
  });
  if (tiles.join('').split('B').length > 2) throw new Error('地图只能放置一个红色按钮');

  const spawn = value.spawn;
  if (!isRecord(spawn)) throw new Error('请填写出生点坐标');
  requireFields(spawn, ['x', 'y']);
  const x = numberField(spawn.x, '出生点 x', 0, columns - 1);
  const y = numberField(spawn.y, '出生点 y', 0, rows - 1);
  if (!Number.isInteger(x) || !Number.isInteger(y) || tiles[y][x] !== '.') {
    throw new Error(`出生点 (${x}, ${y}) 必须落在一个空格中`);
  }
  const gravity = numberField(value.gravity === undefined ? 1 : value.gravity, '重力', -10, 10);
  const inertia = numberField(value.inertia === undefined ? 0.5 : value.inertia, '惯性', 0, 10);
  const systemPrompt = value.systemPrompt;
  if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > 4096)) {
    throw new Error('系统提示词最多 4096 个字符');
  }
  return {
    schemaVersion: 1, name, tiles, spawn: { x, y }, gravity, inertia,
    ...(typeof systemPrompt === 'string' && systemPrompt.trim() ? { systemPrompt } : {}),
  };
}

export function findButton(level: LevelDefinition): Point | undefined {
  for (const [y, row] of level.tiles.entries()) {
    const x = row.indexOf('B');
    if (x >= 0) return { x, y };
  }
}

export function gravityDirection(gravity: number): -1 | 1 {
  return gravity < 0 ? -1 : 1;
}

export function playableError(level: LevelDefinition): string | undefined {
  const button = findButton(level);
  if (!button) return '请在地图上放置一个红色按钮';
  const { x, y } = button;
  if (level.tiles[y + gravityDirection(level.gravity)]?.[x] !== '#') {
    const edge = level.gravity < 0 ? '上方' : '下方';
    return `按钮 (${x}, ${y}) 的${edge}需要相邻的实心块`;
  }
}
