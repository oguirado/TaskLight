import type { CapsuleTask, JobKey } from './types';

// Fallback ids for project values JSON cannot encode (hostile objects whose
// toJSON throws, or circular graphs). Keyed by identity so the same value
// always maps to the same fallback; string behaviour is unchanged.
const fallbackIds = new Map<unknown, string>();
let fallbackSeq = 0;

function fallbackFor(projectId: unknown): string {
  const cached = fallbackIds.get(projectId);
  if (cached !== undefined) return cached;
  const id = `__hostile_${fallbackSeq++}`;
  fallbackIds.set(projectId, id);
  return id;
}

export function jobKeyId(k: JobKey): string {
  try {
    return JSON.stringify([k.projectId, k.observedRev, k.promptVersion, k.templateHash]);
  } catch {
    return JSON.stringify([fallbackFor(k.projectId), k.observedRev, k.promptVersion, k.templateHash]);
  }
}

export function slotId(projectId: string, task: CapsuleTask): string {
  try {
    return JSON.stringify([projectId, task]);
  } catch {
    return JSON.stringify([fallbackFor(projectId), task]);
  }
}
