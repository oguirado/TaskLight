import { DIGEST_REQUEST_ID } from "./types";
import type { DigestCapsuleIn, DigestConfig, DigestDeps, DigestRecord, RevVector } from "./types";
import { buildDigestInput } from "./budget";
import { localDigest } from "./local";
import { projectCapsule } from "./project";
import { rankNeedsYou } from "./rank";
import { revVectorOf } from "./freshness";

export interface DigestEngine {
  request(caps: readonly DigestCapsuleIn[]): Promise<DigestRecord>;
  latest(): DigestRecord | undefined;
  updateConfig(cfg: DigestConfig): void;
  dispose(): void;
}

function revEq(a: RevVector, b: RevVector): boolean {
  const ka = Object.keys(a as Record<string, number>);
  const kb = Object.keys(b as Record<string, number>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if ((b as Record<string, number>)[k] !== (a as Record<string, number>)[k]) return false;
  }
  return true;
}

export function createDigestEngine(deps: DigestDeps, cfgInit: DigestConfig): DigestEngine {
  let cfg: DigestConfig = { ...cfgInit };
  let latestRec: DigestRecord | undefined = undefined;
  let lastCallAt: number | undefined = undefined;
  let inFlight = false;
  let inFlightPromise: Promise<DigestRecord> | undefined = undefined;
  let inFlightRev: RevVector | undefined = undefined;
  let inFlightVer: string | undefined = undefined;
  let pendingCaps: readonly DigestCapsuleIn[] | null = null;
  let pendingWaiters: Array<(r: DigestRecord) => void> = [];
  let timerCancel: (() => void) | undefined = undefined;
  let disposed = false;

  function configValid(): boolean {
    const c = cfg;
    if (typeof c.ondevice_max_input_tokens !== "number" || !Number.isFinite(c.ondevice_max_input_tokens) || c.ondevice_max_input_tokens <= 0) return false;
    if (typeof c.prompt_frame_chars !== "number" || !Number.isFinite(c.prompt_frame_chars) || c.prompt_frame_chars < 0) return false;
    if (typeof c.min_inference_interval_ms !== "number" || !Number.isFinite(c.min_inference_interval_ms) || c.min_inference_interval_ms < 0) return false;
    const budget = c.ondevice_max_input_tokens - c.prompt_frame_chars;
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return false;
    return true;
  }

  function scheduleTimer(): void {
    if (disposed || timerCancel !== undefined) return;
    if (pendingCaps === null) return;
    if (inFlight) return;
    if (lastCallAt === undefined) return;
    const interval = cfg.min_inference_interval_ms;
    const now = deps.clock.now();
    let delay = lastCallAt + interval - now;
    if (delay <= 0) {
      const c = pendingCaps;
      const w = pendingWaiters;
      pendingCaps = null;
      pendingWaiters = [];
      void doCall(c, w);
      return;
    }
    timerCancel = deps.clock.setTimer(delay, () => {
      timerCancel = undefined;
      if (disposed || pendingCaps === null || inFlight) return;
      const c = pendingCaps;
      const w = pendingWaiters;
      pendingCaps = null;
      pendingWaiters = [];
      void doCall(c, w);
    });
  }

  function finishPending(): void {
    if (pendingCaps === null) return;
    if (inFlight) return;
    const interval = cfg.min_inference_interval_ms;
    if (lastCallAt === undefined) {
      const c = pendingCaps;
      const w = pendingWaiters;
      pendingCaps = null;
      pendingWaiters = [];
      void doCall(c, w);
      return;
    }
    const now = deps.clock.now();
    if (now >= lastCallAt + interval) {
      const c = pendingCaps;
      const w = pendingWaiters;
      pendingCaps = null;
      pendingWaiters = [];
      void doCall(c, w);
    } else {
      scheduleTimer();
    }
  }

  async function doCall(caps: readonly DigestCapsuleIn[], waiters: Array<(r: DigestRecord) => void>): Promise<DigestRecord> {
    inFlight = true;
    const now = deps.clock.now();
    let rec: DigestRecord;
    let markCall = false;
    try {
      const budget = cfg.ondevice_max_input_tokens - cfg.prompt_frame_chars;
      const built = buildDigestInput(caps, budget, now);
      if ("error" in built) {
        rec = localDigest(caps, cfg, now, "INPUT_FLOOR_OVER_BUDGET");
      } else {
        let prompt: string | undefined = undefined;
        let promptOk = true;
        try {
          prompt = deps.buildPrompt(built);
        } catch {
          promptOk = false;
          prompt = undefined;
        }
        if (!promptOk || prompt === undefined) {
          rec = localDigest(caps, cfg, now, "SDK_ERROR");
        } else if (prompt.length > cfg.ondevice_max_input_tokens) {
          rec = localDigest(caps, cfg, now, "INPUT_FLOOR_OVER_BUDGET");
        } else {
          inFlightRev = built.revVector;
          inFlightVer = cfg.prompt_version;
          markCall = true;
          lastCallAt = now;
          const req = {
            task: "digest" as const,
            projectId: DIGEST_REQUEST_ID,
            tier: "standard" as const,
            prompt,
            ctx: { knownProjectIds: built.knownProjectIds },
          };
          let result: unknown = undefined;
          let thrown = false;
          try {
            result = await deps.hybrid.run(req as never);
          } catch {
            thrown = true;
          }
          if (thrown || result === null || typeof result !== "object") {
            rec = localDigest(caps, cfg, deps.clock.now(), "SDK_ERROR");
          } else {
            const r = result as { ok: boolean; code?: string; value?: { needs_you?: unknown; brief?: string }; source?: string; fallback?: boolean; rejects?: unknown };
            if (r.ok === true) {
              const needs = (r.value as { needs_you?: unknown } | undefined)?.needs_you;
              const brief = (r.value as { brief?: string } | undefined)?.brief;
              if (!Array.isArray(needs) || typeof brief !== "string") {
                rec = localDigest(caps, cfg, deps.clock.now(), "SDK_ERROR");
              } else {
                const ranked = rankNeedsYou(needs as never, caps, deps.clock.now());
                rec = {
                  needs_you: ranked,
                  brief,
                  origin: r.source as never,
                  fallback: r.fallback === true,
                  truncated: built.truncation.level > 0,
                  revVector: built.revVector,
                  prompt_version: cfg.prompt_version,
                  builtAt: deps.clock.now(),
                  invalidInputs: caps.length - countValid(caps, deps.clock.now()),
                };
                if (r.source === "ON_DEVICE") { try { deps.ledger.inc("on_device"); } catch { /* ignore */ } }
                else if (r.source === "IN_CLOUD") { try { deps.ledger.inc("in_cloud"); } catch { /* ignore */ } }
                if (r.fallback === true) { try { deps.ledger.inc("fallbacks"); } catch { /* ignore */ } }
              }
            } else {
              const code = typeof r.code === "string" ? (r.code as never) : ("SDK_ERROR" as never);
              rec = localDigest(caps, cfg, deps.clock.now(), code as never);
              if (r.rejects !== undefined) rec.rejects = r.rejects as never;
              if (r.code === "SCHEMA_REJECT") { try { deps.ledger.inc("schema_rejects"); } catch { /* ignore */ } }
            }
          }
          inFlightRev = undefined;
          inFlightVer = undefined;
        }
      }
    } catch {
      try { rec = localDigest(caps, cfg, deps.clock.now(), "SDK_ERROR"); }
      catch { rec = { needs_you: [], brief: "0 project(s) need you", origin: "LOCAL_RULES", fallback: false, truncated: false, revVector: {}, prompt_version: cfg.prompt_version, builtAt: deps.clock.now(), invalidInputs: 0, error: "SDK_ERROR" as never }; }
      inFlightRev = undefined;
      inFlightVer = undefined;
    }
    latestRec = rec;
    inFlight = false;
    inFlightPromise = undefined;
    for (const w of waiters) { try { w(rec); } catch { /* ignore */ } }
    finishPending();
    return rec;
  }

  function countValid(caps: readonly DigestCapsuleIn[], now: number): number {
    let n = 0;
    for (const c of caps) {
      let line: unknown = null;
      try { line = projectCapsule(c, now); } catch { line = null; }
      if (line !== null) n++;
    }
    return n;
  }

  async function request(caps: readonly DigestCapsuleIn[]): Promise<DigestRecord> {
    try {
      const snap = Array.isArray(caps) ? caps.slice() : caps;
      if (disposed) {
        if (latestRec !== undefined) return latestRec;
        try { return localDigest(snap, cfg, deps.clock.now(), "SDK_ERROR"); }
        catch { return { needs_you: [], brief: "0 project(s) need you", origin: "LOCAL_RULES", fallback: false, truncated: false, revVector: {}, prompt_version: cfg.prompt_version, builtAt: deps.clock.now(), invalidInputs: 0, error: "SDK_ERROR" as never }; }
      }
      if (!configValid()) {
        const rec = localDigest(snap, cfg, deps.clock.now(), "INPUT_FLOOR_OVER_BUDGET");
        latestRec = rec;
        return rec;
      }
      const now = deps.clock.now();
      const valid = countValid(snap, now);
      if (valid === 0) {
        const rec = localDigest(snap, cfg, now, "NO_CAPSULES");
        latestRec = rec;
        return rec;
      }
      const rev = revVectorOf(snap);
      if (inFlight) {
        if (inFlightRev !== undefined && inFlightVer === cfg.prompt_version && revEq(inFlightRev, rev)) {
          if (inFlightPromise !== undefined) return inFlightPromise;
          return latestRec ?? localDigest(snap, cfg, deps.clock.now(), "SDK_ERROR");
        }
        pendingCaps = snap;
        return new Promise<DigestRecord>((res) => { pendingWaiters.push(res); });
      }
      if (latestRec !== undefined && latestRec.origin !== "LOCAL_RULES") {
        if (latestRec.prompt_version === cfg.prompt_version && revEq(latestRec.revVector, rev)) {
          return latestRec;
        }
      }
      if (lastCallAt !== undefined) {
        const interval = cfg.min_inference_interval_ms;
        if (now < lastCallAt + interval) {
          pendingCaps = snap;
          scheduleTimer();
          if (latestRec !== undefined) return latestRec;
          return localDigest(snap, cfg, now, "SDK_ERROR");
        }
      }
      const p = doCall(snap, []);
      inFlightPromise = p;
      return p;
    } catch {
      try { return localDigest(caps, cfg, deps.clock.now(), "SDK_ERROR"); }
      catch { return { needs_you: [], brief: "0 project(s) need you", origin: "LOCAL_RULES", fallback: false, truncated: false, revVector: {}, prompt_version: cfg.prompt_version, builtAt: deps.clock.now(), invalidInputs: 0, error: "SDK_ERROR" as never }; }
    }
  }

  return {
    request,
    latest(): DigestRecord | undefined { return latestRec; },
    updateConfig(next: DigestConfig): void { cfg = { ...next }; },
    dispose(): void {
      disposed = true;
      if (timerCancel !== undefined) { try { timerCancel(); } catch { /* ignore */ } timerCancel = undefined; }
    },
  };
}
