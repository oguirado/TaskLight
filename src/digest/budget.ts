import type { DigestCapsuleIn, DigestInput, DigestLine, RevVector } from "./types";
import { projectCapsule } from "./project";

const STATUS_ORDER = ["blocked", "failed", "waiting_input", "running", "idle", "done"];
const STATUS_RANK: Record<string, number> = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i]));
const ATT: Record<string, number> = { none: 0, low: 1, high: 2, now: 3 };
const FLOOR_STATUSES: ReadonlySet<string> = new Set(["blocked", "failed", "waiting_input"]);

function cmpLines(a: DigestLine, b: DigestLine): number {
  const ar = ATT[String(a.attention)] ?? -1; const br = ATT[String(b.attention)] ?? -1;
  if (ar !== br) return br - ar;
  const srA = STATUS_RANK[String(a.status)] ?? STATUS_ORDER.length;
  const srB = STATUS_RANK[String(b.status)] ?? STATUS_ORDER.length;
  if (srA !== srB) return srA - srB;
  if (a.waiting_ms !== b.waiting_ms) return b.waiting_ms - a.waiting_ms;
  return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
}

function isFloor(l: DigestLine): boolean {
  return FLOOR_STATUSES.has(String(l.status));
}

function dropKey(l: DigestLine, key: "headline" | "next_action" | "summary"): DigestLine | null {
  const nl: DigestLine = { projectId: l.projectId, status: l.status, attention: l.attention, waiting_ms: l.waiting_ms };
  const hl = l.headline; const na = l.next_action; const su = l.summary;
  if (key !== "headline" && hl !== undefined) nl.headline = hl;
  if (key !== "next_action" && na !== undefined) nl.next_action = na;
  if (key !== "summary" && su !== undefined) nl.summary = su;
  return nl;
}

function serialize(lines: DigestLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function setRev(out: Record<string, number>, k: string, v: number): void {
  Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
}

export function buildDigestInput(caps: readonly DigestCapsuleIn[], budgetChars: number, now: number): DigestInput | { error: "INPUT_FLOOR_OVER_BUDGET" } {
  if (typeof budgetChars !== "number" || !Number.isFinite(budgetChars) || budgetChars <= 0) {
    return { error: "INPUT_FLOOR_OVER_BUDGET" };
  }
  const rev: Record<string, number> = {};
  let lines: DigestLine[] = [];
  const seen = new Set<string>();
  for (const c of caps) {
    let line: DigestLine | null = null;
    try { line = projectCapsule(c, now); } catch { line = null; }
    if (line === null) continue;
    if (seen.has(line.projectId)) continue;
    seen.add(line.projectId);
    const st = (c as DigestCapsuleIn).state as unknown as Record<string, unknown> | null;
    const rv = st && typeof st["rev"] === "number" ? (st["rev"] as number) : undefined;
    if (typeof rv === "number" && Number.isFinite(rv)) setRev(rev, line.projectId, rv);
    lines.push(line);
  }
  lines.sort(cmpLines);
  const origIds = lines.map((l) => l.projectId);
  let level: 0 | 1 | 2 | 3 = 0;
  let dropped = 0;
  const work: DigestLine[] = lines.map((l) => ({ ...l }));
  let ser = serialize(work);
  let chars = ser.length;
  if (chars <= budgetChars) {
    return {
      lines: work, serialized: ser, chars,
      truncation: { level: 0, droppedFields: 0, omittedProjects: [] },
      revVector: rev as RevVector,
      knownProjectIds: new Set(work.map((l) => l.projectId)),
    };
  }
  level = 1;
  for (let i = work.length - 1; i >= 0 && chars > budgetChars; i--) {
    const l = work[i]!;
    if (l.summary !== undefined) {
      work[i] = dropKey(l, "summary")!;
      dropped++;
      ser = serialize(work); chars = ser.length;
    }
  }
  if (chars > budgetChars) {
    level = 2;
    for (let i = work.length - 1; i >= 0 && chars > budgetChars; i--) {
      const l = work[i]!;
      if (l.next_action !== undefined) {
        work[i] = dropKey(l, "next_action")!;
        dropped++;
        ser = serialize(work); chars = ser.length;
      }
    }
    for (let i = work.length - 1; i >= 0 && chars > budgetChars; i--) {
      const l = work[i]!;
      if (l.headline !== undefined) {
        work[i] = dropKey(l, "headline")!;
        dropped++;
        ser = serialize(work); chars = ser.length;
      }
    }
  }
  if (chars > budgetChars) {
    level = 3;
    let idx = work.length - 1;
    while (idx >= 0 && chars > budgetChars) {
      const l = work[idx]!;
      if (!isFloor(l)) {
        work.splice(idx, 1);
        ser = serialize(work); chars = ser.length;
      }
      idx--;
    }
    if (chars > budgetChars) return { error: "INPUT_FLOOR_OVER_BUDGET" };
    const kept = new Set(work.map((l) => l.projectId));
    const omitted = origIds.filter((id) => !kept.has(id));
    return {
      lines: work, serialized: ser, chars,
      truncation: { level: 3, droppedFields: dropped, omittedProjects: omitted },
      revVector: rev as RevVector,
      knownProjectIds: new Set(work.map((l) => l.projectId)),
    };
  }
  return {
    lines: work, serialized: ser, chars,
    truncation: { level, droppedFields: dropped, omittedProjects: [] },
    revVector: rev as RevVector,
    knownProjectIds: new Set(work.map((l) => l.projectId)),
  };
}
