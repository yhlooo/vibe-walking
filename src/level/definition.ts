/** 列出编辑器可选择的地图行列尺寸。 */
export const gridSizes = [
  { rows: 10, columns: 15, label: '小' },
  { rows: 20, columns: 30, label: '中' },
  { rows: 32, columns: 48, label: '大' },
] as const;

/** 从地图数据取得行数和列数。 */
export function gridSize(tiles: string[]) {
  return { rows: tiles.length, columns: tiles[0].length };
}

/** 定义地图 JSON 使用的单格标记。 */
export type Tile = '.' | '#' | 'B';
/** 表示从地图左上角起算的网格坐标。 */
export type Point = { x: number; y: number };

/** 定义内置、编辑和导入导出共享的关卡结构。 */
export type LevelDefinition = {
  schemaVersion: 1;
  name: string;
  tiles: string[];
  spawn: Point;
  gravity: number;
  inertia: number;
  disableReadScreen?: boolean;
  // 自定义提示词，缺省时使用应用内置提示词。
  systemPrompt?: string;
};

/** 判断待校验值是否为可读取字段的对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 拒绝未列入关卡格式的字段。
function requireFields(value: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`未知字段：${unknown}`);
}

// 读取落在允许区间内的有限数值。
function numberField(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
  }
  return value;
}

/** 校验关卡结构并填充可省略的默认字段。 */
export function readLevel(value: unknown): LevelDefinition {
  if (!isRecord(value)) throw new Error('关卡定义必须是对象');
  requireFields(value, ['schemaVersion', 'name', 'tiles', 'spawn', 'gravity', 'inertia', 'disableReadScreen', 'systemPrompt']);
  if (value.schemaVersion !== 1) throw new Error('关卡 schemaVersion 必须为 1');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80) throw new Error('关卡名必须为 1 到 80 个字符');

  if (!Array.isArray(value.tiles) || typeof value.tiles[0] !== 'string') throw new Error('地图必须包含网格行');
  const { rows, columns } = gridSize(value.tiles);

  // 编辑器保留历史地图尺寸的读取能力。
  const legacy = rows === 9 && columns === 16;
  if (!legacy && !gridSizes.some((size) => size.rows === rows && size.columns === columns)) {
    throw new Error('地图尺寸须为 10 × 15、20 × 30 或 32 × 48');
  }

  // 验证每一行的宽度和格子字符，再检查全图的按钮数量。
  const tiles = value.tiles.map((row: unknown, index): string => {
    if (typeof row !== 'string' || row.length !== columns || /[^.#B]/.test(row)) {
      throw new Error(`地图第 ${index + 1} 行须为 ${columns} 个 .、# 或 B`);
    }
    return row;
  });

  if (tiles.join('').split('B').length > 2) throw new Error('地图只能放置一个红色按钮');

  // 确认出生点坐标是范围内的整数，并且对应的是空格。
  const spawn = value.spawn;
  if (!isRecord(spawn)) throw new Error('请填写出生点坐标');
  requireFields(spawn, ['x', 'y']);
  const x = numberField(spawn.x, '出生点 x', 0, columns - 1);
  const y = numberField(spawn.y, '出生点 y', 0, rows - 1);
  if (!Number.isInteger(x) || !Number.isInteger(y) || tiles[y][x] !== '.') {
    throw new Error(`出生点 (${x}, ${y}) 必须落在一个空格中`);
  }

  // 用缺省值补齐旧关卡，保留用户显式设置的零重力和零惯性。
  const gravity = numberField(value.gravity === undefined ? 1 : value.gravity, '重力', -10, 10);
  const inertia = numberField(value.inertia === undefined ? 0.5 : value.inertia, '惯性', 0, 10);

  const disableReadScreen = value.disableReadScreen;
  if (disableReadScreen !== undefined && typeof disableReadScreen !== 'boolean') {
    throw new Error('disableReadScreen 必须为布尔值');
  }
  const systemPrompt = value.systemPrompt;
  if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > 4096)) {
    throw new Error('系统提示词最多 4096 个字符');
  }
  return {
    schemaVersion: 1, name, tiles, spawn: { x, y }, gravity, inertia,
    ...(disableReadScreen ? { disableReadScreen } : {}),
    ...(typeof systemPrompt === 'string' ? { systemPrompt } : {}),
  };
}

/** 查找地图上的目标按钮。 */
export function findButton(level: LevelDefinition): Point | undefined {
  for (const [y, row] of level.tiles.entries()) {
    const x = row.indexOf('B');
    if (x >= 0) return { x, y };
  }
}

/** 把重力值转换为支撑方向。 */
export function gravityDirection(gravity: number): -1 | 1 {
  return gravity < 0 ? -1 : 1;
}

/** 检查关卡开局所需的按钮和支撑。 */
export function playableError(level: LevelDefinition): string | undefined {
  const button = findButton(level);
  if (!button) return '请在地图上放置一个红色按钮';
  const { x, y } = button;
  if (level.tiles[y + gravityDirection(level.gravity)]?.[x] !== '#') {
    const edge = level.gravity < 0 ? '上方' : '下方';
    return `按钮 (${x}, ${y}) 的${edge}需要相邻的实心块`;
  }
}

/** 调整地图尺寸，裁剪后为出生点和按钮重新找位置。 */
export function resizeLevel(level: LevelDefinition, rows: number, columns: number): LevelDefinition {
  // 缩放时保留重力方向一侧的地图边缘。
  const offset = level.gravity < 0 ? 0 : rows - level.tiles.length;
  const tiles = Array.from({ length: rows }, (_, y) =>
    (level.tiles[y - offset] ?? '').slice(0, columns).replace('B', '.').padEnd(columns, '.'));

  // 将坐标限制在新地图范围内。
  function fit(point: Point): Point {
    return { x: Math.min(columns - 1, point.x), y: Math.max(0, Math.min(rows - 1, point.y + offset)) };
  }

  // 在允许的位置中选取距原坐标最近的一格。
  function nearest(origin: Point, allowed: (point: Point) => boolean): Point | undefined {
    let best: Point | undefined;
    let distance = Infinity;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const steps = Math.abs(x - origin.x) + Math.abs(y - origin.y);
        if (steps < distance && tiles[y][x] === '.' && allowed({ x, y })) {
          distance = steps;
          best = { x, y };
        }
      }
    }
    return best;
  }

  // 写入新地图中的一个格子。
  function put({ x, y }: Point, tile: Tile) {
    tiles[y] = tiles[y].slice(0, x) + tile + tiles[y].slice(x + 1);
  }

  // 优先为出生点分配空格，再为按钮寻找带支撑的位置。
  const origin = fit(level.spawn);
  const spawn = nearest(origin, () => true) ?? origin;
  put(spawn, '.');
  const oldButton = findButton(level);
  if (oldButton) {
    const target = fit(oldButton);
    const outsideSpawn = ({ x, y }: Point) => x !== spawn.x || y !== spawn.y;
    const button = tiles[target.y][target.x] === '.' && outsideSpawn(target) ? target
      : nearest(target, ({ x, y }) => outsideSpawn({ x, y }) && tiles[y + gravityDirection(level.gravity)]?.[x] === '#')
        ?? nearest(target, outsideSpawn);
    if (button) put(button, 'B');
  }
  return { ...level, tiles, spawn };
}
