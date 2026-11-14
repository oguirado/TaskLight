import { afterEach, describe, expect, test } from "vitest";
import { createDigestEngine, digestFreshness, localDigest, revVectorOf } from "../../../src/digest";
import type { DigestEngine, DigestRecord } from "../../../src/digest";
import { CFG, FRAME, NOW, cap, deferred, failRes, flush, makeEnv, okRes, pid, type Env } from "./helpers";

const engines: DigestEngine[] = [];
function boot(script?: Parameters<typeof makeEnv>[0], cfg = CFG): { env: Env; eng: DigestEngine } {
  const env = makeEnv(script);
  const eng = createDigestEngine(env.deps, { ...cfg });
  engines.push(eng);
  return { env, eng };
}
afterEach(() => { while (engines.length) { try { engines.pop()!.dispose(); } catch { /* stub */ } } });
const three = () => [cap("p1", { headline: "H1", rev: 1 }), cap("p2", { headline: "H2", rev: 1 }), cap("p3", { headline: "H3", rev: 1 })];

describe("localDigest (B12)", () => {
  test("origin LOCAL_RULES, needs_you from the floor only, brief '<n> project(s) need you', error passed through", () => {
    const caps = [cap("p1", { status: "blocked" }), cap("p2", { status: "failed", rev: 4 }), cap("p3", { status: "running" })];
    const d = localDigest(caps, CFG, NOW, "CLOUD_UNAVAILABLE");
    expect(d.origin).toBe("LOCAL_RULES");
    expect(d.needs_you.map((x) => x.projectId).sort()).toEqual(["p1", "p2"]);
    for (const x of d.needs_you) expect(x.by).toBe("rule");
    expect(d.needs_you.map((x) => x.rank)).toEqual([1, 2]);
    expect(d.brief).toBe("2 project(s) need you");
    expect(d.error).toBe("CLOUD_UNAVAILABLE");
    expect(d.builtAt).toBe(NOW);
    expect(d.prompt_version).toBe("v1");
    expect(d.revVector).toEqual({ p1: 1, p2: 4, p3: 1 });
    expect(d.invalidInputs).toBe(0);
  });
  test("no error argument -> no error key; invalid capsules are counted and excluded", () => {
    const d = localDigest([cap("p1", { status: "blocked" }), cap("bad", { status: "exploding" })], CFG, NOW);
    expect("error" in d && d.error !== undefined).toBe(false);
    expect(d.invalidInputs).toBe(1);
    expect(Object.keys(d.revVector)).toEqual(["p1"]);
  });
  test("private capsules produce no text in the local digest", () => {
    const d = localDigest([cap("p1", { tier: "private", status: "blocked", headline: "PRIV-HL" })], CFG, NOW);
    expect(JSON.stringify(d)).not.toContain("PRIV-HL");
  });
  test("zero capsules: empty needs_you", () => {
    expect(localDigest([], CFG, NOW, "NO_CAPSULES").needs_you).toEqual([]);
  });
});

describe("O3 request shape (B4)", () => {
  test("one call: task digest, tier standard, projectId _digest, ctx.knownProjectIds = the ids, prompt <= 7300, no mode", async () => {
    const { env, eng } = boot();
    await eng.request(three());
    expect(env.calls).toHaveLength(1);
    const q = env.calls[0]!;
    expect(Object.keys(q).sort()).toEqual(["ctx", "projectId", "prompt", "task", "tier"]);
    expect(q.task).toBe("digest"); expect(q.tier).toBe("standard"); expect(q.projectId).toBe("_digest");
    expect([...q.ctx!.knownProjectIds!].sort()).toEqual(["p1", "p2", "p3"]);
    expect(q.prompt.length).toBeLessThanOrEqual(7300);
    expect(q.prompt.startsWith(FRAME)).toBe(true);
    expect(q.prompt).toContain("H2");
    expect(env.runArgCounts).toEqual([1]);
    expect(env.prompts).toHaveLength(1);
    expect(env.prompts[0]!.serialized).toBe(q.prompt.slice(FRAME.length));
  });
  test("tier stays standard even when private capsules are present, and their text never reaches the prompt (O2)", async () => {
    const { env, eng } = boot();
    await eng.request([cap("p1", { tier: "private", status: "blocked", headline: "PRIV-HL", summary: "PRIV-SUM", next_action: "PRIV-NEXT" }), cap("p2", { headline: "STD-HL" })]);
    const q = env.calls[0]!;
    expect(q.tier).toBe("standard");
    for (const t of ["PRIV-HL", "PRIV-SUM", "PRIV-NEXT"]) expect(q.prompt).not.toContain(t);
    expect(q.prompt).toContain("STD-HL");
  });
  test("O1 end to end: an outer raw_event key never reaches the prompt", async () => {
    const { env, eng } = boot();
    const c = { ...cap("p1", { headline: "H" }), raw_event: "SECRET-RAW" } as never;
    await eng.request([c]);
    expect(env.calls[0]!.prompt).not.toContain("SECRET-RAW");
  });
  test("prompt over the on-device cap (frame lies about its size) -> no call, INPUT_FLOOR_OVER_BUDGET", async () => {
    const env = makeEnv();
    env.deps.buildPrompt = (i) => "X".repeat(9000) + i.serialized;
    const eng = createDigestEngine(env.deps, { ...CFG }); engines.push(eng);
    const r = await eng.request(three());
    expect(env.calls).toHaveLength(0);
    expect(r.origin).toBe("LOCAL_RULES");
    expect(r.error).toBe("INPUT_FLOOR_OVER_BUDGET");
  });
  test("buildPrompt throwing never rejects: LOCAL_RULES, no call", async () => {
    const env = makeEnv();
    env.deps.buildPrompt = () => { throw new Error("prompt boom"); };
    const eng = createDigestEngine(env.deps, { ...CFG }); engines.push(eng);
    const r = await eng.request(three());
    expect(r.origin).toBe("LOCAL_RULES");
    expect(env.calls).toHaveLength(0);
  });
  test("invalid numeric config (NaN / Infinity) fails closed: no call, LOCAL_RULES", async () => {
    for (const bad of [{ ondevice_max_input_tokens: NaN }, { prompt_frame_chars: Infinity }, { ondevice_max_input_tokens: -5 }]) {
      const { env, eng } = boot(undefined, { ...CFG, ...bad });
      const r = await eng.request(three());
      expect(env.calls, JSON.stringify(bad)).toHaveLength(0);
      expect(r.origin).toBe("LOCAL_RULES");
    }
  });
});

describe("O5 floor over budget", () => {
  test("12 blocked capsules with prompt_frame_chars 7290 -> INPUT_FLOOR_OVER_BUDGET, 0 calls, LOCAL_RULES, resolves", async () => {
    const { env, eng } = boot(undefined, { ...CFG, prompt_frame_chars: 7290 });
    const r = await eng.request(Array.from({ length: 12 }, (_, k) => cap(pid(k + 1), { status: "blocked", attention: "now" })));
    expect(env.calls).toHaveLength(0);
    expect(r.origin).toBe("LOCAL_RULES");
    expect(r.error).toBe("INPUT_FLOOR_OVER_BUDGET");
    expect(r.needs_you).toHaveLength(12);
  });
});

describe("O4 truncation reaches the record", () => {
  test("12 fat capsules: prompt <= 7300, record.truncated true; 3 capsules: truncated false", async () => {
    const fat = Array.from({ length: 12 }, (_, k) => cap(pid(k + 1), { waiting: (13 - k) * 1000, headline: "h".repeat(100), next_action: "n".repeat(150), summary: String(k % 10).repeat(600) }));
    const a = boot();
    const r = await a.eng.request(fat);
    expect(a.env.calls[0]!.prompt.length).toBeLessThanOrEqual(7300);
    expect(r.truncated).toBe(true);
    const b = boot();
    expect((await b.eng.request(three())).truncated).toBe(false);
  });
  test("B8: a model item for an omitted project is not offered as known (ctx lists only retained ids)", async () => {
    const { env, eng } = boot(undefined, { ...CFG, prompt_frame_chars: 7000 });   // budget 300 -> only a few lines fit
    const caps = Array.from({ length: 12 }, (_, k) => cap(pid(k + 1), { waiting: (13 - k) * 1000 }));
    await eng.request(caps);
    const known = env.calls[0]!.ctx!.knownProjectIds!;
    expect(known.size).toBeGreaterThan(0);
    expect(known.size).toBeLessThan(12);
    expect(known.has(pid(1))).toBe(true);
    expect(known.has(pid(12))).toBe(false);
  });
});

describe("outcomes (B11-B13)", () => {
  test("success: origin from result.source, ranking applied, brief passed through, record stamped", async () => {
    const { env, eng } = boot(() => okRes([
      { projectId: "p3", reason: "slow", attention: "low" }, { projectId: "p1", reason: "urgent", attention: "now" }], "two things", "IN_CLOUD", false));
    const caps = [cap("p1", { rev: 7 }), cap("p2", { status: "blocked", rev: 9 }), cap("p3", { rev: 2 })];
    const r = await eng.request(caps);
    expect(r.origin).toBe("IN_CLOUD");
    expect(r.fallback).toBe(false);
    expect(r.brief).toBe("two things");
    expect(r.needs_you.map((x) => [x.projectId, x.by, x.rank])).toEqual([["p1", "model", 1], ["p2", "rule", 2], ["p3", "model", 3]]);
    expect(r.revVector).toEqual({ p1: 7, p2: 9, p3: 2 });
    expect(r.prompt_version).toBe("v1");
    expect(r.builtAt).toBe(env.timers.now());
    expect(r.invalidInputs).toBe(0);
    expect(r.error).toBeUndefined();
    expect(eng.latest()).toEqual(r);
    expect(env.ledger).toEqual({ on_device: 0, in_cloud: 1, fallbacks: 0, schema_rejects: 0 });
  });
  test("O13 fallback and ledger: ON_DEVICE+fallback counts on_device and fallbacks; then SCHEMA_REJECT -> LOCAL_RULES and schema_rejects 1", async () => {
    let n = 0;
    const { env, eng } = boot(() => (++n === 1 ? okRes([], "b", "ON_DEVICE", true) : failRes("SCHEMA_REJECT", { rejects: [{ code: "UNKNOWN_PROJECT", path: "needs_you.0.projectId" }] })));
    const a = await eng.request([cap("p1", { status: "blocked", rev: 1 })]);
    expect(a.origin).toBe("ON_DEVICE"); expect(a.fallback).toBe(true);
    expect(env.ledger).toEqual({ on_device: 1, in_cloud: 0, fallbacks: 1, schema_rejects: 0 });
    await env.timers.advance(20000);
    const b = await eng.request([cap("p1", { status: "blocked", rev: 2 })]);
    expect(b.origin).toBe("LOCAL_RULES");
    expect(b.error).toBe("SCHEMA_REJECT");
    expect(b.rejects?.[0]?.code).toBe("UNKNOWN_PROJECT");
    expect(env.ledger).toEqual({ on_device: 1, in_cloud: 0, fallbacks: 1, schema_rejects: 1 });
    expect(eng.latest()).toEqual(b);
  });
  test("O6 offline: thrown error and rejected promise both resolve LOCAL_RULES with the blocked capsule", async () => {
    for (const script of [() => { throw new Error("offline"); }, () => Promise.reject(new Error("offline")), () => failRes("SDK_ERROR")]) {
      const { eng } = boot(script as never);
      const r = await eng.request([cap("p1", { status: "blocked" }), cap("p2")]);
      expect(r.origin).toBe("LOCAL_RULES");
      expect(r.needs_you.map((x) => x.projectId)).toEqual(["p1"]);
      expect(r.error).toBeDefined();
      expect(r.brief).toBe("1 project(s) need you");
    }
    const { eng: e2 } = boot(() => failRes("SDK_ERROR"));
    expect((await e2.request([cap("p1", { status: "blocked" })])).error).toBe("SDK_ERROR");
  });
  test("failure codes other than SCHEMA_REJECT touch no ledger counter", async () => {
    for (const code of ["APP_CHECK_REJECTED", "CLOUD_UNAVAILABLE", "DEVICE_NOT_INITIALISED", "INPUT_OVER_BUDGET", "CLOUD_DISABLED"] as const) {
      const { env, eng } = boot(() => failRes(code));
      const r = await eng.request([cap("p1", { status: "blocked" })]);
      expect(r.error, code).toBe(code);
      expect(env.ledger, code).toEqual({ on_device: 0, in_cloud: 0, fallbacks: 0, schema_rejects: 0 });
    }
  });
  test("a malformed ok result (missing needs_you) degrades to LOCAL_RULES instead of throwing", async () => {
    const { eng } = boot(() => ({ ok: true, value: {}, source: "IN_CLOUD", fallback: false, meta: {} }) as never);
    const r = await eng.request([cap("p1", { status: "blocked" })]);
    expect(r.origin).toBe("LOCAL_RULES");
    expect(r.needs_you.map((x) => x.projectId)).toEqual(["p1"]);
  });
  test("O8 end to end: model returns [] and p2 is blocked -> p2 present with by:'rule'", async () => {
    const { eng } = boot(() => okRes([], "nothing"));
    const r = await eng.request([cap("p1"), cap("p2", { status: "blocked" }), cap("p3")]);
    expect(r.needs_you).toHaveLength(1);
    expect(r.needs_you[0]).toMatchObject({ projectId: "p2", by: "rule" });
    expect(r.origin).toBe("IN_CLOUD");
  });
  test("O14 no_capsules: 0 calls, empty needs_you, NO_CAPSULES; also when every capsule is invalid", async () => {
    const a = boot();
    const r = await a.eng.request([]);
    expect(a.env.calls).toHaveLength(0);
    expect(r.needs_you).toEqual([]);
    expect(r.error).toBe("NO_CAPSULES");
    expect(r.origin).toBe("LOCAL_RULES");
    const b = boot();
    const r2 = await b.eng.request([cap("a", { status: "exploding" }), cap("b", { attention: "urgent" as never })]);
    expect(b.env.calls).toHaveLength(0);
    expect(r2.error).toBe("NO_CAPSULES");
    expect(r2.invalidInputs).toBe(2);
  });
  test("invalid capsules among valid ones are excluded and counted; valid ones are still sent", async () => {
    const { env, eng } = boot();
    const r = await eng.request([cap("p1"), cap("bad", { status: "exploding" }), cap("p2")]);
    expect(r.invalidInputs).toBe(1);
    expect([...env.calls[0]!.ctx!.knownProjectIds!].sort()).toEqual(["p1", "p2"]);
  });
  test("cross-lens: dev blocked + study reading both sent; a dev-status study capsule is excluded", async () => {
    const { env, eng } = boot();
    const r = await eng.request([cap("p1", { status: "blocked", headline: "DEV-H" }), cap("s1", { lens: "study", status: "reading", headline: "STUDY-H" }), cap("s2", { lens: "study", status: "blocked" })]);
    expect([...env.calls[0]!.ctx!.knownProjectIds!].sort()).toEqual(["p1", "s1"]);
    expect(env.calls[0]!.prompt).toContain("STUDY-H");
    expect(r.invalidInputs).toBe(1);
  });
  test("a private project in a failed digest still shows status only", async () => {
    const { eng } = boot(() => failRes("CLOUD_UNAVAILABLE"));
    const r = await eng.request([cap("p1", { tier: "private", status: "failed", headline: "PRIV-HL" })]);
    expect(JSON.stringify(r)).not.toContain("PRIV-HL");
    expect(r.needs_you.map((x) => x.projectId)).toEqual(["p1"]);
  });
});

describe("O11 single flight / coalescing (B15)", () => {
  test("3 requests during a flight coalesce: <= 2 calls total, the second with the newest revVector; then identical revVector -> no call", async () => {
    const gate = deferred<ReturnType<typeof okRes>>();
    let n = 0;
    const { env, eng } = boot(() => (++n === 1 ? gate.promise : okRes([], "second")));
    const mk = (rev: number) => [cap("p1", { rev }), cap("p2", { rev })];
    const a = eng.request(mk(1));
    await flush();
    expect(env.calls).toHaveLength(1);
    const b = eng.request(mk(2)); const c = eng.request(mk(3)); const d = eng.request(mk(4));
    await flush();
    expect(env.calls).toHaveLength(1);              // still single flight
    gate.resolve(okRes([], "first"));
    await a;
    await env.timers.advance(20000);                // interval gate (B16) before the coalesced call
    const all = await Promise.all([b, c, d]);
    expect(env.calls.length).toBeLessThanOrEqual(2);
    expect(env.calls).toHaveLength(2);
    expect(env.prompts[1]!.revVector).toEqual({ p1: 4, p2: 4 });
    for (const r of all) expect(r).toBeDefined();
    const before = env.calls.length;
    const same = await eng.request(mk(4));
    expect(env.calls).toHaveLength(before);
    expect(same.revVector).toEqual({ p1: 4, p2: 4 });
    expect(digestFreshness(same, revVectorOf(mk(4)))).toBe("fresh");
  });
  test("an identical request while one is in flight makes no second call", async () => {
    const gate = deferred<ReturnType<typeof okRes>>();
    const { env, eng } = boot(() => gate.promise);
    const a = eng.request(three()); await flush();
    const b = eng.request(three()); await flush();
    gate.resolve(okRes()); await Promise.all([a, b]);
    expect(env.calls).toHaveLength(1);
  });
  test("same revVector and prompt_version as the latest model digest -> no call, same record", async () => {
    const { env, eng } = boot();
    const a = await eng.request(three());
    await env.timers.advance(60000);
    const b = await eng.request(three());
    expect(env.calls).toHaveLength(1);
    expect(b).toEqual(a);
  });
  test("a prompt_version change (updateConfig) invalidates reuse: new call after the interval, stamped v2", async () => {
    const { env, eng } = boot();
    await eng.request(three());
    eng.updateConfig({ ...CFG, prompt_version: "v2" });
    await env.timers.advance(20000);
    const r = await eng.request(three());
    expect(env.calls).toHaveLength(2);
    expect(r.prompt_version).toBe("v2");
  });
  test("updateConfig of ondevice_max_input_tokens shrinks the next prompt", async () => {
    const { env, eng } = boot();
    const fat = Array.from({ length: 12 }, (_, k) => cap(pid(k + 1), { waiting: (13 - k) * 1000, headline: "h".repeat(100), next_action: "n".repeat(150), summary: "s".repeat(600), rev: 1 }));
    await eng.request(fat);
    eng.updateConfig({ ...CFG, ondevice_max_input_tokens: 4000 });
    await env.timers.advance(20000);
    await eng.request(fat.map((c) => ({ ...c, state: { ...c.state, rev: 2 } })));
    expect(env.calls[1]!.prompt.length).toBeLessThanOrEqual(4000);
  });
  test("a thrown run releases the lane: the next request after the interval calls again", async () => {
    let n = 0;
    const { env, eng } = boot(() => { if (++n === 1) throw new Error("offline"); return okRes(); });
    await eng.request(three());
    await env.timers.advance(20000);
    const r = await eng.request(three());
    expect(env.calls).toHaveLength(2);
    expect(r.origin).toBe("IN_CLOUD");
  });
});

describe("O12 interval (B16)", () => {
  test("success at t=0, new revs at t=5000: no call before t=20000, exactly one at t=20000, a single wake-up timer", async () => {
    const { env, eng } = boot();
    const first = await eng.request(three());
    expect(env.calls).toHaveLength(1);
    await env.timers.advance(5000);
    const newer = three().map((c) => ({ ...c, state: { ...c.state, rev: 2 } }));
    const early = await eng.request(newer);
    expect(env.calls).toHaveLength(1);
    expect(digestFreshness(early, revVectorOf(newer))).toBe("stale");
    expect(early.origin === "LOCAL_RULES" || early.revVector["p1"] === first.revVector["p1"]).toBe(true);
    expect(env.timers.live()).toHaveLength(1);
    await env.timers.advance(14999);
    expect(env.calls).toHaveLength(1);
    await env.timers.advance(1);
    expect(env.calls).toHaveLength(2);
    expect(env.prompts[1]!.revVector).toEqual({ p1: 2, p2: 2, p3: 2 });
    await env.timers.advance(100000);
    expect(env.calls).toHaveLength(2);
  });
  test("several early requests still schedule exactly one wake-up and one call, with the newest input", async () => {
    const { env, eng } = boot();
    await eng.request(three());
    const mk = (rev: number) => three().map((c) => ({ ...c, state: { ...c.state, rev } }));
    await env.timers.advance(1000);
    const ps = [eng.request(mk(2)), eng.request(mk(3)), eng.request(mk(4))];
    await flush();
    expect(env.timers.live()).toHaveLength(1);
    await env.timers.advance(19000);
    await Promise.all(ps);
    expect(env.calls).toHaveLength(2);
    expect(env.prompts[1]!.revVector["p1"]).toBe(4);
  });
  test("a failed call also starts the interval (no hammering after errors)", async () => {
    const { env, eng } = boot(() => failRes("CLOUD_UNAVAILABLE"));
    await eng.request(three());
    await env.timers.advance(1000);
    const r = await eng.request(three().map((c) => ({ ...c, state: { ...c.state, rev: 2 } })));
    expect(env.calls).toHaveLength(1);
    expect(r.origin).toBe("LOCAL_RULES");
  });
  test("the interval follows min_inference_interval_ms from updateConfig", async () => {
    const { env, eng } = boot();
    eng.updateConfig({ ...CFG, min_inference_interval_ms: 5000 });
    await eng.request(three());
    await env.timers.advance(5000);
    await eng.request(three().map((c) => ({ ...c, state: { ...c.state, rev: 2 } })));
    expect(env.calls).toHaveLength(2);
  });
  test("no requestAnimationFrame is used for scheduling", async () => {
    const orig = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    let raf = 0;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => { raf++; return 0; };
    try {
      const { env, eng } = boot();
      await eng.request(three()); await env.timers.advance(1000);
      await eng.request(three().map((c) => ({ ...c, state: { ...c.state, rev: 2 } })));
    } finally { (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = orig; }
    expect(raf).toBe(0);
  });
});

describe("lifecycle and purity", () => {
  test("dispose cancels the wake-up timer; later requests resolve without calling", async () => {
    const { env, eng } = boot();
    await eng.request(three());
    await env.timers.advance(1000);
    void eng.request(three().map((c) => ({ ...c, state: { ...c.state, rev: 2 } })));
    await flush();
    expect(env.timers.live()).toHaveLength(1);
    eng.dispose();
    expect(env.timers.live()).toEqual([]);
    const r = await eng.request(three());
    expect(r).toBeDefined();
    await env.timers.advance(100000);
    expect(env.calls).toHaveLength(1);
  });
  test("dispose during a flight: the pending request still settles and no timer is left behind", async () => {
    const gate = deferred<ReturnType<typeof okRes>>();
    const { env, eng } = boot(() => gate.promise);
    const p = eng.request(three()); await flush();
    eng.dispose();
    gate.resolve(okRes());
    const r = await Promise.race([p, new Promise<"hung">((res) => setTimeout(() => res("hung"), 500))]);
    expect(r).not.toBe("hung");
    expect(env.timers.live()).toEqual([]);
  });
  test("B17: no logging of prompt or brief text", async () => {
    const logs: unknown[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    console.log = console.warn = console.error = console.info = console.debug = (...a: unknown[]) => { logs.push(a); };
    try {
      const { eng } = boot(() => { throw new Error("offline SECRET-BRIEF"); });
      await eng.request([cap("p1", { headline: "SECRET-HL", status: "blocked" })]);
    } finally { Object.assign(console, orig); }
    expect(logs).toEqual([]);
  });
  test("request never mutates the caller's capsules", async () => {
    const { eng } = boot();
    const caps = [cap("p1", { tier: "private", headline: "PRIV-HL" }), cap("p2", { headline: "H" })];
    const snap = JSON.stringify(caps);
    await eng.request(caps);
    expect(JSON.stringify(caps)).toBe(snap);
  });
  test("latest() is undefined before the first request", () => {
    const { eng } = boot();
    expect(eng.latest()).toBeUndefined();
  });
});

describe("record type sanity", () => {
  test("DigestRecord keys on success", async () => {
    const { eng } = boot();
    const r: DigestRecord = await eng.request(three());
    for (const k of ["needs_you", "brief", "origin", "fallback", "truncated", "revVector", "prompt_version", "builtAt", "invalidInputs"]) expect(r, k).toHaveProperty(k);
  });
});
