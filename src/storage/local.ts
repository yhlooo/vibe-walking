import { isRecord, readLevel } from '../level/definition.ts';
import type { LevelDefinition } from '../level/definition.ts';

const draftKey = 'vibe-walking:v1:draft';
const progressKey = 'vibe-walking:v1:progress';

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
