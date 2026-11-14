// U39 routing: sync stages 0-1 (routeText/routeEvent) + Nano fallback.
import type { RoomEvent } from "../agents/types";
import type { PrivacyTier } from "../schema/index";
import type { ClassifierPort, RouteDecision, RouteTable } from "./types";
import { MAX_TEXT, MIN_COVERAGE_PPM, MIN_MARGIN_PPM, NANO_TIMEOUT_MS, exactRoute, lexicalRank, marginPpm } from "./score";
import { tokenize } from "./tokenize";
import { ROUTE_TABLE, tableHash } from "./table";
import { buildClassifierPrompt, buildConstraint, parseLabel } from "./nano";
import { SOURCE_FLOORS, effectiveMode } from "../lens/floors";
import type { LensMode } from "../lens/types";

function safeTextOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function lexicalDecision(text: string, table: RouteTable): RouteDecision {
  const hash = tableHash(table);
  const work = text.length > 5000 ? text.slice(0, 5000) : text;
  const tokens = tokenize(work);
  const ranked = lexicalRank(tokens, table);
  if (ranked.length === 0) {
    return { status: "NO_MATCH", target: "inbox", reason: "no_terms", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: hash };
  }
  const top = ranked[0]!;
  const margin = marginPpm(ranked);
  // Recompute matched (sorted distinct query tokens hitting the winning rule).
  const matched = matchedTokens(tokens, top.rule, table);
  if (top.coveragePpm < MIN_COVERAGE_PPM) {
    return { status: "ABSTAIN", target: "inbox", reason: "low_coverage", scorePpm: top.scorePpm, coveragePpm: top.coveragePpm, marginPpm: margin, matched, tableHash: hash };
  }
  if (margin < MIN_MARGIN_PPM) {
    return { status: "ABSTAIN", target: "inbox", reason: "low_margin", scorePpm: top.scorePpm, coveragePpm: top.coveragePpm, marginPpm: margin, matched, tableHash: hash };
  }
  return { status: "OK", target: top.rule.target, stage: "lexical", ruleId: top.rule.id, scorePpm: top.scorePpm, coveragePpm: top.coveragePpm, marginPpm: margin, matched, tableHash: hash };
}

function matchedTokens(tokens: string[], rule: { terms: string[] }, table: RouteTable): string[] {
  const folded = new Set<string>();
  const terms = Array.isArray(rule.terms) ? rule.terms : [];
  for (const term of terms as string[]) {
    if (typeof term !== "string") continue;
    for (const tk of tokenize(term)) folded.add(tk);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tk of tokens) {
    if (typeof tk !== "string" || seen.has(tk)) continue;
    seen.add(tk);
    if (folded.has(tk)) out.push(tk);
    else {
      // Bilingual bridge: query token -> mapped token.
      try {
        const bi = table.bilingual as Record<string, string> | undefined;
        const mapped = bi?.[tk];
        if (typeof mapped === "string" && folded.has(mapped)) out.push(tk);
      } catch {
        // ignore
      }
    }
  }
  out.sort();
  return out;
}

export function routeText(text: string, t?: RouteTable): RouteDecision {
  try {
    const table = t ?? ROUTE_TABLE;
    return lexicalDecision(safeTextOf(text as unknown), table);
  } catch {
    try {
      return { status: "ERROR", target: "inbox", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(t ?? ROUTE_TABLE) };
    } catch {
      return { status: "ERROR", target: "inbox", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: "0".repeat(64) };
    }
  }
}

export function routeEvent(ev: RoomEvent, t?: RouteTable): RouteDecision {
  try {
    const table = t ?? ROUTE_TABLE;
    const exact = exactRoute(ev);
    if (exact !== null) {
      return { ...exact, tableHash: tableHash(table) };
    }
    const text = ev !== null && typeof ev === "object" ? safeTextOf((ev as unknown as Record<string, unknown>)["text"]) : "";
    return lexicalDecision(text, table);
  } catch {
    try {
      return { status: "ERROR", target: "inbox", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(t ?? ROUTE_TABLE) };
    } catch {
      return { status: "ERROR", target: "inbox", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: "0".repeat(64) };
    }
  }
}

type PortValue = { text: string; source: "ON_DEVICE" | "IN_CLOUD" };

function abstainLike(base: RouteDecision, reason: NonNullable<RouteDecision["reason"]>, stage?: RouteDecision["stage"]): RouteDecision {
  const out: RouteDecision = { status: "ABSTAIN", target: "inbox", reason, scorePpm: base.scorePpm, coveragePpm: base.coveragePpm, marginPpm: base.marginPpm, matched: base.matched, tableHash: base.tableHash };
  if (stage !== undefined) out.stage = stage;
  return out;
}

export async function routeWithFallback(ev: RoomEvent, tier: PrivacyTier, port?: ClassifierPort, opts?: { timeoutMs?: number }): Promise<RouteDecision> {
  let base: RouteDecision;
  try {
    base = routeEvent(ev);
  } catch {
    base = { status: "ABSTAIN", target: "inbox", reason: "nano_unavailable", scorePpm: 0, coveragePpm: 0, marginPpm: 0, matched: [], tableHash: tableHash(ROUTE_TABLE) };
  }
  try {
    // Stage-1 OK never calls the port.
    if (base.status === "OK") return base;

    const rawText = ev !== null && typeof ev === "object" ? safeTextOf((ev as unknown as Record<string, unknown>)["text"]) : "";
    // Oversize text never reaches the port.
    if (rawText.length > MAX_TEXT) return base;
    if (port === undefined || port === null || typeof port !== "function") {
      return abstainLike(base, "nano_unavailable");
    }
    const mode: LensMode = modeForTier(tier);
    const prompt = buildClassifierPrompt(rawText);
    const constraint = buildConstraint();

    let timeoutMs = NANO_TIMEOUT_MS;
    try {
      const v = opts?.timeoutMs;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) timeoutMs = v;
    } catch {
      timeoutMs = NANO_TIMEOUT_MS;
    }

    const controller = new AbortController();
    type Outcome = { kind: "value"; value: unknown } | { kind: "error" } | { kind: "timeout" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });

    let portP: Promise<Outcome>;
    try {
      const raw = port({ prompt, constraint, mode, signal: controller.signal });
      portP = Promise.resolve(raw).then(
        (v): Outcome => ({ kind: "value", value: v }),
        (): Outcome => ({ kind: "error" }),
      );
    } catch {
      portP = Promise.resolve<Outcome>({ kind: "error" });
    }

    let outcome: Outcome;
    try {
      outcome = await Promise.race([portP, timeoutP]);
    } catch {
      outcome = { kind: "error" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (outcome.kind === "timeout") return abstainLike(base, "nano_timeout", "nano");
    if (outcome.kind === "error") return abstainLike(base, "nano_unavailable", "nano");
    const value = outcome.value;
    if (value === null || value === undefined) return abstainLike(base, "nano_unavailable", "nano");
    if (typeof value !== "object") return abstainLike(base, "nano_unavailable", "nano");
    const rec = value as Record<string, unknown>;
    const txt = rec["text"];
    const src = rec["source"];
    if (typeof txt !== "string" || (src !== "ON_DEVICE" && src !== "IN_CLOUD")) {
      return abstainLike(base, "nano_unavailable", "nano");
    }
    const label = parseLabel(txt);
    if (label === null) return abstainLike(base, "nano_off_enum", "nano");
    if (label === "abstain") return abstainLike(base, "nano_abstain", "nano");
    if (src === "IN_CLOUD" && mode === "ONLY_ON_DEVICE") return abstainLike(base, "privacy_cloud", "nano");
    const ok: RouteDecision = {
      status: "OK",
      target: label,
      stage: "nano",
      scorePpm: base.scorePpm,
      coveragePpm: base.coveragePpm,
      marginPpm: base.marginPpm,
      matched: base.matched,
      source: src as PortValue["source"],
      tableHash: base.tableHash,
    };
    return ok;
  } catch {
    try {
      return abstainLike(base, "nano_unavailable");
    } catch {
      return base;
    }
  }
}

function modeForTier(tier: PrivacyTier): LensMode {
  try {
    if (tier === "private" || tier === "standard" || tier === "shared") {
      return effectiveMode(SOURCE_FLOORS.agent[tier], "PREFER_ON_DEVICE");
    }
    return "PREFER_ON_DEVICE";
  } catch {
    return "PREFER_ON_DEVICE";
  }
}
