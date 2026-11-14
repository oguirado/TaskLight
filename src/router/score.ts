// U39 scoring: constants, exact stage, lexical BM25-lite ranking, margin.
import type { RoomEvent } from "../agents/types";
import type { RouteDecision, RouteRule, RouteTable } from "./types";
import { tokenize } from "./tokenize";
import { ROUTE_TABLE, tableHash } from "./table";

export const MIN_MARGIN_PPM = 100_000;
export const MIN_COVERAGE_PPM = 250_000;
export const NANO_TIMEOUT_MS = 400;
export const MAX_TEXT = 1000;

const K1 = 1.2;

function safeText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function exactRoute(ev: RoomEvent): RouteDecision | null {
  try {
    if (ev === null || typeof ev !== "object") return null;
    const base = ev as unknown as Record<string, unknown>;
    const act = base["act"];
    const text = safeText(base["text"]);
    // J3/A1: question with a non-empty `to` wins regardless of text.
    if (act === "question") {
      const to = base["to"];
      if (typeof to === "string" && to.length > 0) {
        return { status: "OK", target: "ask_agent", agent: to, stage: "exact", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(ROUTE_TABLE) };
      }
    }
    // J1: plan act with a plan body.
    if (act === "plan") {
      const plan = base["plan"];
      if (plan !== null && typeof plan === "object") {
        return { status: "OK", target: "plan_change", stage: "exact", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(ROUTE_TABLE) };
      }
    }
    // J2: verdict mentioning needs_user.
    if (act === "verdict" && text.includes("needs_user")) {
      return { status: "OK", target: "escalate", stage: "exact", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(ROUTE_TABLE) };
    }
    // J3: @<agent-id> mention anywhere in text.
    const m = text.match(/@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/);
    if (m !== null && m[1] !== undefined && m[1].length > 0) {
      return { status: "OK", target: "ask_agent", agent: m[1], stage: "exact", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(ROUTE_TABLE) };
    }
    return null;
  } catch {
    return null;
  }
}

interface CachedTable {
  ruleSets: Set<string>[];
  df: Map<string, number>;
}

const cache = new WeakMap<object, CachedTable>();

function cached(t: RouteTable): CachedTable {
  const hit = cache.get(t as object);
  if (hit !== undefined) return hit;
  const rules = Array.isArray(t.rules) ? t.rules : [];
  const ruleSets: Set<string>[] = [];
  const df = new Map<string, number>();
  for (const r of rules) {
    const s = new Set<string>();
    const terms = Array.isArray(r.terms) ? r.terms : [];
    for (const term of terms as string[]) {
      if (typeof term !== "string") continue;
      for (const tok of tokenize(term)) s.add(tok);
    }
    ruleSets.push(s);
    for (const tok of s) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  const entry: CachedTable = { ruleSets, df };
  cache.set(t as object, entry);
  return entry;
}

function bilingualVariants(token: string, t: RouteTable): string[] {
  const out: string[] = [token];
  try {
    const bi = t.bilingual;
    if (bi !== null && typeof bi === "object") {
      const fwd = (bi as Record<string, string>)[token];
      if (typeof fwd === "string" && fwd.length > 0) out.push(fwd);
    }
  } catch {
    // ignore
  }
  return out;
}

function matchesRule(token: string, set: Set<string>, t: RouteTable): boolean {
  if (set.has(token)) return true;
  const variants = bilingualVariants(token, t);
  for (const v of variants) {
    if (v !== token && set.has(v)) return true;
  }
  return false;
}

export function lexicalRank(tokens: string[], table: RouteTable): { rule: RouteRule; scorePpm: number; coveragePpm: number }[] {
  try {
    if (!Array.isArray(tokens) || table === null || typeof table !== "object") return [];
    const query: string[] = [];
    for (const tk of tokens as unknown[]) {
      if (typeof tk === "string" && tk.length > 0) query.push(tk);
    }
    const total = query.length;
    if (total === 0) return [];
    const rules = Array.isArray(table.rules) ? table.rules : [];
    if (rules.length === 0) return [];
    const { ruleSets, df } = cached(table);
    const N = rules.length;

    // Query term frequencies (deterministic order via sorted keys later).
    const tf = new Map<string, number>();
    for (const tk of query) tf.set(tk, (tf.get(tk) ?? 0) + 1);

    const ranked: { rule: RouteRule; scorePpm: number; coveragePpm: number; matched: string[] }[] = [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      const set = ruleSets[i]!;
      const matched: string[] = [];
      for (const tk of tf.keys()) {
        if (matchesRule(tk, set, table)) matched.push(tk);
      }
      if (matched.length === 0) continue;
      matched.sort();
      let sum = 0;
      for (const tk of matched) {
        // Resolve the rule term this token matched (direct or bilingual) for idf.
        let idfTok = tk;
        if (!set.has(tk)) {
          for (const v of bilingualVariants(tk, table)) {
            if (set.has(v)) {
              idfTok = v;
              break;
            }
          }
        }
        const dfv = df.get(idfTok) ?? 1;
        const idf = Math.log(1 + N / dfv);
        const freq = tf.get(tk) ?? 1;
        const tfSat = (freq * (K1 + 1)) / (freq + K1);
        const w = typeof r.weight === "number" && Number.isFinite(r.weight) ? r.weight : 1;
        sum += idf * tfSat * w;
      }
      const scorePpm = Math.max(0, Math.floor(sum * 1_000_000));
      if (scorePpm <= 0) continue;
      let coveragePpm = Math.floor((matched.length * 1_000_000) / total);
      if (coveragePpm > 1_000_000) coveragePpm = 1_000_000;
      ranked.push({ rule: r, scorePpm, coveragePpm, matched });
    }
    ranked.sort((a, b) => {
      if (b.scorePpm !== a.scorePpm) return b.scorePpm - a.scorePpm;
      if (b.coveragePpm !== a.coveragePpm) return b.coveragePpm - a.coveragePpm;
      if (a.rule.id < b.rule.id) return -1;
      if (a.rule.id > b.rule.id) return 1;
      return 0;
    });
    return ranked.map(({ rule: rl, scorePpm, coveragePpm }) => ({ rule: rl, scorePpm, coveragePpm }));
  } catch {
    return [];
  }
}

export function marginPpm(ranked: readonly { scorePpm: number }[]): number {
  try {
    if (!Array.isArray(ranked) || ranked.length === 0) return 0;
    const s1 = ranked[0]?.scorePpm ?? 0;
    if (typeof s1 !== "number" || !Number.isFinite(s1) || s1 <= 0) return 0;
    if (ranked.length < 2) return 1_000_000;
    const s2 = ranked[1]?.scorePpm ?? 0;
    if (typeof s2 !== "number" || !Number.isFinite(s2) || s2 < 0) return 1_000_000;
    const m = Math.floor(((s1 - s2) * 1_000_000) / s1);
    if (Number.isNaN(m)) return 0;
    return m < 0 ? 0 : m;
  } catch {
    return 0;
  }
}
