import { isRecord, readLevel } from '../level/definition.ts';
import type { LevelDefinition } from '../level/definition.ts';

/** 描述关卡目录条目及其物理修订号。 */
export type LevelEntry = {
  id: string;
  kind: 'builtin' | 'custom';
  description?: string;
  revision: string;
  level: LevelDefinition;
};

/** 描述用于关卡卡片的首次通关时间和最快用时。 */
type CompletionSummary = { completedAt: string; bestDurationMS?: number };
/** 携带一次通关的尝试 ID、关卡版本及模型成绩。 */
export type CompletionUpdate = { attemptID: string; revision: string; model?: string; durationMS?: number };
/** 记录一次由服务确认的通关。 */
export type Completion = CompletionUpdate & { completedAt: string };
/** 保存单个关卡的汇总与逐次通关记录。 */
export type LevelProgress = CompletionSummary & { completions?: Completion[] };
/** 描述服务保存的通关记录及最近进入的关卡。 */
export type Progress = { recentLevel?: string; levels: Record<string, LevelProgress> };

// 发送本地关卡 API 请求并解码成功或错误响应。
async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch('/api/v1/' + path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(10000),
    keepalive: method !== 'GET',
    ...(data === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),
  });
  const value = response.status === 204 ? undefined : await response.json();
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

/** 标记本次进入的正式游玩关卡。 */
export function markRecentLevel(id: string) {
  return request<void>(`progress/recent/${encodeURIComponent(id)}`, 'PUT');
}

/** 提交指定关卡的一次通关。 */
export function recordCompletion(id: string, { attemptID, ...update }: CompletionUpdate) {
  return request<Completion>(`progress/${encodeURIComponent(id)}/completions/${encodeURIComponent(attemptID)}`, 'PUT', update);
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
  const levels: [string, CompletionSummary][] = [];
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
