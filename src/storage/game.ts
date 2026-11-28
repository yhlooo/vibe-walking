import type { WorldState } from '../game/world.ts';
import { isRecord, readLevel } from '../level/definition.ts';
import type { LevelDefinition } from '../level/definition.ts';

/** 描述关卡目录条目及其存档修订号。 */
export type LevelEntry = {
  id: string;
  kind: 'builtin' | 'custom';
  description?: string;
  revision: string;
  level: LevelDefinition;
};

/** 保存可恢复的物理状态及当前用时。 */
export type SavedRun = { world: WorldState; elapsedMS?: number };
/** 描述通关时间及可用的最快成绩。 */
export type Completion = { completedAt: string; bestDurationMS?: number };
/** 合并单个关卡的成绩、修订号和当前存档。 */
export type LevelProgress = Partial<Completion> & { revision?: string; savedAt?: number; run?: SavedRun };
/** 描述本地服务保存的关卡进度集合。 */
export type Progress = { recentBuiltin?: string; recentBuiltinAt?: number; levels: Record<string, LevelProgress> };
/** 携带一次客户端存档或通关更新。 */
export type ProgressUpdate = { revision: string; savedAt: number; run: SavedRun | null; recent?: boolean; won?: boolean; durationMS?: number };

// 发送本地关卡 API 请求并解码成功或错误响应。
async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch('/api/v1/' + path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(10000),
    ...(data === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true,
    }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message ?? '无法读取或保存本地游戏数据');
  return value as T;
}

/** 获取内置及自建关卡目录。 */
export function readCatalog() {
  return request<{ levels: LevelEntry[]; warnings?: string[] }>('levels');
}

/** 获取本地游玩进度。 */
export function readProgress() {
  return request<Progress>('progress');
}

/** 创建空白自建关卡。 */
export function createLevel() {
  return request<LevelEntry>('levels', 'POST', {});
}

/** 保存自建关卡在列表中的顺序。 */
export function updateLevelOrder(ids: string[]) {
  return request<string[]>('levels', 'PUT', { ids });
}

/** 保存指定关卡的编辑内容。 */
export function updateLevel(id: string, level: LevelDefinition) {
  return request<LevelEntry>(`levels/${encodeURIComponent(id)}`, 'PUT', level);
}

/** 提交指定关卡的新存档或通关成绩。 */
export function updateProgress(id: string, update: ProgressUpdate) {
  return request<LevelProgress>(`progress/${encodeURIComponent(id)}`, 'PUT', update);
}

// 标识旧版浏览器中待迁移的草稿和进度数据。
const draftKey = 'vibe-walking:v1:draft';
const progressKey = 'vibe-walking:v1:progress';
const recentKey = 'vibe-walking:v1:recent-level';

// 在浏览器存储不可用时将旧数据当作缺省。
function oldValue(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// 仅删除已成功迁移且内容未被更改的旧值。
function removeOld(key: string, value: string | null) {
  try {
    if (localStorage.getItem(key) === value) localStorage.removeItem(key);
  } catch {
    // Both migrations can be retried safely if browser storage is read-only.
  }
}

/** 将浏览器中的旧版草稿迁移为自建关卡。 */
export async function migrateDraft() {
  const saved = oldValue(draftKey);
  if (!saved) return;
  let legacy: LevelDefinition;
  try {
    legacy = readLevel(JSON.parse(saved));
  } catch {
    return;
  }

  // 后端确认迁移成功后才清理浏览器中的原草稿。
  const entry = await request<LevelEntry>('levels', 'POST', { legacy });
  removeOld(draftKey, saved);
  return entry;
}

/** 将浏览器旧进度合并到本地服务。 */
export async function migrateProgress() {
  const saved = oldValue(progressKey);
  const recentBuiltin = oldValue(recentKey);
  if (!saved && !recentBuiltin) return;

  let previous: unknown;
  try {
    previous = JSON.parse(saved ?? '{}');
  } catch {
    previous = {};
  }

  // 旧进度逐条筛选有效日期和成绩，再交给服务合并。
  const levels: [string, Completion][] = [];
  if (isRecord(previous)) {
    for (const [id, entry] of Object.entries(previous)) {
      if (!isRecord(entry) || typeof entry.completedAt !== 'string') continue;
      const completedAt = new Date(entry.completedAt);
      if (!Number.isFinite(completedAt.getTime())) continue;
      const best = entry.bestDurationMS;
      levels.push([id, {
        completedAt: completedAt.toISOString(),
        ...(typeof best === 'number' && Number.isSafeInteger(best) && best >= 0 ? { bestDurationMS: best } : {}),
      }]);
    }
  }

  // 确认服务已持久化后，再清理旧进度和最近关卡键。
  const progress = await request<Progress>('progress', 'POST', { recentBuiltin: recentBuiltin ?? '', levels: Object.fromEntries(levels) });
  removeOld(progressKey, saved);
  removeOld(recentKey, recentBuiltin);
  return progress;
}
