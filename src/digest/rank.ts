import type { DigestItem } from "../schema";
import type { DigestCapsuleIn, RankedItem } from "./types";
import { projectCapsule } from "./project";

const ATT: Record<string, number> = { none: 0, low: 1, high: 2, now: 3 };
const STATUS_ORDER = ["blocked", "failed", "waiting_input", "running", "idle", "done"];
const STATUS_RANK: Record<string, number> = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i]));
const FLOOR_STATUSES: ReadonlySet<string> = new Set(["blocked", "failed", "waiting_input"]);

function attRank(a: string): number { const r = ATT[a]; return r === undefined ? -1 : r; }
function statusRank(s: string): number { const r = STATUS_RANK[s]; return r === undefined ? STATUS_ORDER.length : r; }

interface Cand {
  projectId: string;
  reason: string;
  attention: "none" | "low" | "high" | "now";
  status: string;
  waiting: number;
  by: "model" | "rule";
  effRank: number;
}

export function rankNeedsYou(model: readonly DigestItem[] | null, caps: readonly DigestCapsuleIn[], now: number): RankedItem[] {
  const capMap = new Map<string, { status: string; attention: string; waiting: number; floor: boolean }>();
  for (const c of caps) {
    let line;
    try { line = projectCapsule(c, now); } catch { line = null; }
    if (line === null) continue;
    if (capMap.has(line.projectId)) continue;
    const floor = line.attention === "now" || line.attention === "high" || FLOOR_STATUSES.has(String(line.status));
    capMap.set(line.projectId, { status: String(line.status), attention: String(line.attention), waiting: line.waiting_ms, floor });
  }
  const modelBy = new Map<string, { reason: string; attention: string }>();
  if (model !== null) {
    for (const it of model) {
      if (it === null || typeof it !== "object") continue;
      const pid = (it as DigestItem).projectId;
      const att = (it as DigestItem).attention;
      const reason = (it as DigestItem).reason;
      if (typeof pid !== "string" || typeof att !== "string" || typeof reason !== "string") continue;
      if (!capMap.has(pid)) continue;
      const cur = modelBy.get(pid);
      if (cur === undefined) {
        modelBy.set(pid, { reason, attention: att });
      } else {
        const nr = attRank(att); const cr = attRank(cur.attention);
        if (nr > cr || (nr === cr && reason < cur.reason)) modelBy.set(pid, { reason, attention: att });
      }
    }
  }
  const cands: Cand[] = [];
  for (const [pid, cap] of capMap) {
    const mi = modelBy.get(pid);
    const capRank = attRank(cap.attention);
    if (mi !== undefined) {
      const mr = attRank(mi.attention);
      const effR = Math.max(capRank, mr);
      const eff = effR >= 3 ? "now" : effR === 2 ? "high" : effR === 1 ? "low" : "none";
      if (eff === "none" && !cap.floor) continue;
      cands.push({ projectId: pid, reason: mi.reason, attention: eff as Cand["attention"], status: cap.status, waiting: cap.waiting, by: "model", effRank: effR });
    } else {
      if (!cap.floor) continue;
      const effR = Math.max(capRank, 2);
      const eff = effR >= 3 ? "now" : "high";
      cands.push({ projectId: pid, reason: `status: ${cap.status}`, attention: eff, status: cap.status, waiting: cap.waiting, by: "rule", effRank: effR });
    }
  }
  cands.sort((a, b) => {
    if (b.effRank !== a.effRank) return b.effRank - a.effRank;
    const srA = statusRank(a.status); const srB = statusRank(b.status);
    if (srA !== srB) return srA - srB;
    if (b.waiting !== a.waiting) return b.waiting - a.waiting;
    return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
  });
  return cands.slice(0, 12).map((c, i) => ({ projectId: c.projectId, reason: c.reason, attention: c.attention, rank: i + 1, by: c.by }));
}
