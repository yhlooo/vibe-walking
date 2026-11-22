import type { WorldState } from '../game/world.ts';
import { isRecord, readLevel } from '../level/definition.ts';
import type { LevelDefinition } from '../level/definition.ts';

export type LevelEntry = {
  id: string;
  kind: 'builtin' | 'custom';
  description?: string;
  revision: string;
  level: LevelDefinition;
};

export type SavedRun = { world: WorldState; elapsedMS?: number };
export type Completion = { completedAt: string; bestDurationMS?: number };
export type LevelProgress = Partial<Completion> & { revision?: string; savedAt?: number; run?: SavedRun };
export type Progress = { recentBuiltin?: string; recentBuiltinAt?: number; levels: Record<string, LevelProgress> };
export type ProgressUpdate = { revision: string; savedAt: number; run: SavedRun | null; recent?: boolean; won?: boolean; durationMS?: number };

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

export function readCatalog() {
  return request<{ levels: LevelEntry[]; warnings?: string[] }>('levels');
}

export function readProgress() {
  return request<Progress>('progress');
}

export function createLevel() {
  return request<LevelEntry>('levels', 'POST', {});
}

export function updateLevelOrder(ids: string[]) {
  return request<string[]>('levels', 'PUT', { ids });
}

export function updateLevel(id: string, level: LevelDefinition) {
  return request<LevelEntry>(`levels/${encodeURIComponent(id)}`, 'PUT', level);
}

export function updateProgress(id: string, update: ProgressUpdate) {
  return request<LevelProgress>(`progress/${encodeURIComponent(id)}`, 'PUT', update);
}

const draftKey = 'vibe-walking:v1:draft';
const progressKey = 'vibe-walking:v1:progress';
const recentKey = 'vibe-walking:v1:recent-level';

function oldValue(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeOld(key: string, value: string | null) {
  try {
    if (localStorage.getItem(key) === value) localStorage.removeItem(key);
  } catch {
    // Both migrations can be retried safely if browser storage is read-only.
  }
}

export async function migrateDraft() {
  const saved = oldValue(draftKey);
  if (!saved) return;
  let legacy: LevelDefinition;
  try {
    legacy = readLevel(JSON.parse(saved));
  } catch {
    return;
  }
  const entry = await request<LevelEntry>('levels', 'POST', { legacy });
  removeOld(draftKey, saved);
  return entry;
}

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
  const progress = await request<Progress>('progress', 'POST', { recentBuiltin: recentBuiltin ?? '', levels: Object.fromEntries(levels) });
  removeOld(progressKey, saved);
  removeOld(recentKey, recentBuiltin);
  return progress;
}
