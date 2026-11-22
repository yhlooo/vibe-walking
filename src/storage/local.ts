import { gridSizes, isRecord, readLevel } from '../level/definition.ts';
import type { LevelDefinition } from '../level/definition.ts';

const draftKey = 'vibe-walking:v1:draft';
const progressKey = 'vibe-walking:v1:progress';
const recentLevelKey = 'vibe-walking:v1:recent-level';
const playSizeKey = 'vibe-walking:v1:play-size';

export function playGridSize(): (typeof gridSizes)[number] {
  try {
    const rows = Number(localStorage.getItem(playSizeKey));
    return gridSizes.find((size) => size.rows === rows) ?? gridSizes[1];
  } catch {
    return gridSizes[1];
  }
}

export function savePlayGridSize(rows: number) {
  localStorage.setItem(playSizeKey, String(rows));
}

export function recentLevel(): string | null {
  try {
    return localStorage.getItem(recentLevelKey);
  } catch {
    return null;
  }
}

export function rememberLevel(id: string) {
  try {
    localStorage.setItem(recentLevelKey, id);
  } catch {
    // Starting a level does not depend on browser storage.
  }
}

export function loadDraft(fallback: LevelDefinition): LevelDefinition {
  try {
    const saved = localStorage.getItem(draftKey);
    if (saved) return readLevel(JSON.parse(saved));
  } catch {
    // Recovery starts from a fresh copy of the built-in level.
  }
  return readLevel(fallback);
}

export function saveDraft(draft: LevelDefinition) {
  localStorage.setItem(draftKey, JSON.stringify(draft));
}

function readProgress(): Record<string, { completedAt: string }> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(progressKey) ?? '{}');
    if (isRecord(saved)) {
      return Object.fromEntries(Object.entries(saved).flatMap(([id, item]) =>
        isRecord(item) && typeof item.completedAt === 'string' && Number.isFinite(Date.parse(item.completedAt))
          ? [[id, { completedAt: item.completedAt }]] : []));
    }
  } catch {
    // Missing or invalid progress is equivalent to a fresh game.
  }
  return {};
}

export function completion(id: string): string | undefined {
  return readProgress()[id]?.completedAt;
}

export function markCompleted(id: string) {
  const progress = readProgress();
  if (progress[id]) return;
  progress[id] = { completedAt: new Date().toISOString() };
  localStorage.setItem(progressKey, JSON.stringify(progress));
}
