import { isRecord, readLevel } from '../level/definition.ts';
import type { LevelDefinition } from '../level/definition.ts';

const draftKey = 'vibe-walking:v1:draft';
const progressKey = 'vibe-walking:v1:progress';
const recentLevelKey = 'vibe-walking:v1:recent-level';
type Completion = { completedAt: string; bestDurationMS?: number };

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

function readProgress(): Record<string, Completion> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(progressKey) ?? '{}');
    if (isRecord(saved)) {
      const entries: [string, Completion][] = [];
      for (const [id, item] of Object.entries(saved)) {
        if (!isRecord(item) || typeof item.completedAt !== 'string' || !Number.isFinite(Date.parse(item.completedAt))) continue;
        const { completedAt, bestDurationMS } = item;
        const record: Completion = { completedAt };
        if (typeof bestDurationMS === 'number' && Number.isFinite(bestDurationMS) && bestDurationMS >= 0) {
          record.bestDurationMS = bestDurationMS;
        }
        entries.push([id, record]);
      }
      return Object.fromEntries(entries);
    }
  } catch {
    // Missing or invalid progress is equivalent to a fresh game.
  }
  return {};
}

export function completion(id: string): Completion | undefined {
  return readProgress()[id];
}

export function markCompleted(id: string, durationMS?: number) {
  const progress = readProgress();
  const previous = progress[id];
  if (previous && (durationMS === undefined || durationMS >= (previous.bestDurationMS ?? Infinity))) return;
  progress[id] = {
    completedAt: previous?.completedAt ?? new Date().toISOString(),
    bestDurationMS: durationMS,
  };
  localStorage.setItem(progressKey, JSON.stringify(progress));
}
