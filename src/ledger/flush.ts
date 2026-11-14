// Delta bookkeeping for the U19 inference ledger (B13/B14).
// Pending shape: dayKey -> projectId -> tier -> counter -> count.

export type PendingDeltas = Map<string, Map<string, Map<string, Map<string, number>>>>;

export function countPendingKeys(pending: PendingDeltas): number {
  let n = 0;
  for (const day of pending.values()) {
    for (const project of day.values()) {
      for (const tier of project.values()) {
        for (const count of tier.values()) {
          if (count > 0) n++;
        }
      }
    }
  }
  return n;
}

export function buildDeltasForDay(
  dayPending: Map<string, Map<string, Map<string, number>>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [projectId, tierMap] of dayPending.entries()) {
    const perProject: Record<string, number> = {};
    for (const [tier, counterMap] of tierMap.entries()) {
      for (const [counter, n] of counterMap.entries()) {
        if (n <= 0) continue;
        const key = `${tier}.${counter}`;
        perProject[key] = (perProject[key] ?? 0) + n;
      }
    }
    if (Object.keys(perProject).length > 0) {
      out[projectId] = perProject;
    }
  }
  return out;
}

export function mergePendingInto(
  target: PendingDeltas,
  source: PendingDeltas,
): void {
  for (const [dayKey, dayMap] of source.entries()) {
    let targetDay = target.get(dayKey);
    if (targetDay === undefined) {
      targetDay = new Map();
      target.set(dayKey, targetDay);
    }
    for (const [projectId, tierMap] of dayMap.entries()) {
      let targetProject = targetDay.get(projectId);
      if (targetProject === undefined) {
        targetProject = new Map();
        targetDay.set(projectId, targetProject);
      }
      for (const [tier, counterMap] of tierMap.entries()) {
        let targetTier = targetProject.get(tier);
        if (targetTier === undefined) {
          targetTier = new Map();
          targetProject.set(tier, targetTier);
        }
        for (const [counter, n] of counterMap.entries()) {
          targetTier.set(counter, (targetTier.get(counter) ?? 0) + n);
        }
      }
    }
  }
}

export function addDelta(
  pending: PendingDeltas,
  dayKey: string,
  projectId: string,
  tier: string,
  counter: string,
): void {
  let day = pending.get(dayKey);
  if (day === undefined) {
    day = new Map();
    pending.set(dayKey, day);
  }
  let project = day.get(projectId);
  if (project === undefined) {
    project = new Map();
    day.set(projectId, project);
  }
  let tierMap = project.get(tier);
  if (tierMap === undefined) {
    tierMap = new Map();
    project.set(tier, tierMap);
  }
  tierMap.set(counter, (tierMap.get(counter) ?? 0) + 1);
}
