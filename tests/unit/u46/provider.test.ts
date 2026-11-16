import { describe, expect, it } from "vitest";
import { PROVIDER_KINDS, assertProviderAllowed, isProviderKind } from "../../../src/privacy";
import type { ProviderKind } from "../../../src/privacy";
import type { PrivacyTier, TaskId } from "../../../src/schema/enums";
import { KINDS, OPTS8, TASKS, TIERS, expected } from "./fixtures";

const call = (t: unknown, ti: unknown, k: unknown, o: unknown) =>
  assertProviderAllowed(t as TaskId, ti as PrivacyTier, k as ProviderKind, o as never);

describe("O1 PROVIDER_KINDS / isProviderKind", () => {
  it("PROVIDER_KINDS equals the 5-value union order and is frozen", () => {
    expect([...PROVIDER_KINDS]).toEqual([...KINDS]);
    expect(Object.isFrozen(PROVIDER_KINDS)).toBe(true);
  });
  it.each([...KINDS])("isProviderKind(%s) is true", (k) => { expect(isProviderKind(k)).toBe(true); });
  it.each(["firebase", "FIREBASE-HYBRID", "", " firebase-hybrid", "firebase-hybrid ", null, undefined, {}, [], 0, 1, true, ["firebase-hybrid"]])(
    "isProviderKind(%j) is false", (v) => { expect(isProviderKind(v)).toBe(false); });
  it("never throws on hostile values (symbol, bigint, object with toString)", () => {
    for (const v of [Symbol("x"), 10n, { toString: () => "firebase-hybrid" }, () => 0]) expect(isProviderKind(v)).toBe(false);
  });
});

describe("O2 exhaustive matrix 6 tasks x 3 tiers x 5 kinds x 8 opts = 720", () => {
  it("the matrix has 720 cases", () => { expect(TASKS.length * TIERS.length * KINDS.length * OPTS8.length).toBe(720); });
  for (const kind of KINDS) for (const tier of TIERS) for (const task of TASKS) {
    it(`${kind} / ${tier} / ${task} (8 opts)`, () => {
      for (const o of OPTS8) expect(call(task, tier, kind, o), JSON.stringify(o)).toStrictEqual(expected(task, tier, kind, o));
    });
  }
  it("spot pins (reference model sanity, spec section 3 literal)", () => {
    const all = { loopback: true, allowPrivate: true, endpointEnabled: true };
    expect(call("status", "private", "local-openai-compatible", all)).toStrictEqual({ ok: true });
    expect(call("status", "private", "local-openai-compatible", { ...all, allowPrivate: false })).toStrictEqual({ ok: false, violation: "LOCAL_PRIVATE_NOT_ALLOWED" });
    expect(call("status", "standard", "remote-openai-compatible", all)).toStrictEqual({ ok: true });
    expect(call("status", "shared", "remote-openai-compatible", all)).toStrictEqual({ ok: false, violation: "REMOTE_FOR_SHARED" });
    expect(call("status", "private", "remote-openai-compatible", all)).toStrictEqual({ ok: false, violation: "REMOTE_FOR_PRIVATE" });
    expect(call("screenshot", "standard", "firebase-ondevice", all)).toStrictEqual({ ok: true });
    expect(call("screenshot", "standard", "firebase-cloud", all)).toStrictEqual({ ok: false, violation: "CLOUD_PROVIDER_FOR_SCREENSHOT" });
    expect(call("status", "private", "firebase-hybrid", all)).toStrictEqual({ ok: false, violation: "CLOUD_PROVIDER_FOR_PRIVATE" });
  });
  it("evaluation order: local screenshot beats not-loopback; loopback beats disabled; disabled beats private-not-allowed", () => {
    const none = { loopback: false, allowPrivate: false, endpointEnabled: false };
    expect(call("screenshot", "private", "local-openai-compatible", none)).toEqual({ ok: false, violation: "LOCAL_FOR_SCREENSHOT" });
    expect(call("plan", "private", "local-openai-compatible", none)).toEqual({ ok: false, violation: "LOCAL_NOT_LOOPBACK" });
    expect(call("plan", "private", "local-openai-compatible", { ...none, loopback: true })).toEqual({ ok: false, violation: "LOCAL_ENDPOINT_DISABLED" });
    expect(call("plan", "private", "local-openai-compatible", { ...none, loopback: true, endpointEnabled: true })).toEqual({ ok: false, violation: "LOCAL_PRIVATE_NOT_ALLOWED" });
  });
  it("evaluation order: remote screenshot > private > shared > disabled", () => {
    const none = { loopback: false, allowPrivate: false, endpointEnabled: false };
    expect(call("screenshot", "shared", "remote-openai-compatible", none)).toEqual({ ok: false, violation: "REMOTE_FOR_SCREENSHOT" });
    expect(call("plan", "private", "remote-openai-compatible", none)).toEqual({ ok: false, violation: "REMOTE_FOR_PRIVATE" });
    expect(call("plan", "shared", "remote-openai-compatible", none)).toEqual({ ok: false, violation: "REMOTE_FOR_SHARED" });
    expect(call("plan", "standard", "remote-openai-compatible", none)).toEqual({ ok: false, violation: "REMOTE_ENDPOINT_DISABLED" });
  });
  it("remote ignores allowPrivate and loopback (no override)", () => {
    for (const loopback of [false, true]) {
      expect(call("plan", "private", "remote-openai-compatible", { loopback, allowPrivate: true, endpointEnabled: true })).toEqual({ ok: false, violation: "REMOTE_FOR_PRIVATE" });
      expect(call("plan", "standard", "remote-openai-compatible", { loopback, allowPrivate: false, endpointEnabled: true })).toEqual({ ok: true });
    }
  });
  it("firebase-ondevice ignores opts entirely", () => {
    for (const o of OPTS8) for (const t of TASKS) for (const ti of TIERS) expect(call(t, ti, "firebase-ondevice", o)).toStrictEqual({ ok: true });
  });
});

describe("O3 unknown tier behaves as private; unknown task as screenshot", () => {
  const BAD_TIERS: unknown[] = ["public", "", undefined, "PRIVATE", null, 0, {}, "Standard", " standard"];
  it.each(BAD_TIERS.map((t) => [String(t), t]))("tier %s == private for every kind/task/opts", (_n, bad) => {
    for (const k of KINDS) for (const t of TASKS) for (const o of OPTS8) {
      expect(call(t, bad, k, o), `${k}/${t}/${JSON.stringify(o)}`).toStrictEqual(call(t, "private", k, o));
      expect(call(t, bad, k, o)).toStrictEqual(expected(t, "private", k, o));
    }
  });
  const BAD_TASKS: unknown[] = ["chat", "", undefined, null, "STATUS", "Screenshot", 3];
  it.each(BAD_TASKS.map((t) => [String(t), t]))("task %s == screenshot for every kind/tier/opts", (_n, bad) => {
    for (const k of KINDS) for (const ti of TIERS) for (const o of OPTS8) {
      expect(call(bad, ti, k, o), `${k}/${ti}/${JSON.stringify(o)}`).toStrictEqual(call("screenshot", ti, k, o));
      expect(call(bad, ti, k, o)).toStrictEqual(expected("screenshot", ti, k, o));
    }
  });
  it("unknown task and unknown tier together: strictest of both (private screenshot)", () => {
    const all = { loopback: true, allowPrivate: true, endpointEnabled: true };
    expect(call("chat", "public", "firebase-ondevice", all)).toEqual({ ok: true });
    for (const k of KINDS.filter((x) => x !== "firebase-ondevice")) expect(call("chat", "public", k, all).ok, k).toBe(false);
  });
});

describe("O4 unknown kind, non-boolean opts, missing opts", () => {
  const BAD_KINDS: unknown[] = ["openai", "local", "", undefined, null, "firebase", "FIREBASE-ONDEVICE", 5, {}];
  it.each(BAD_KINDS.map((k) => [String(k), k]))("kind %s -> PROVIDER_KIND_UNKNOWN for every task/tier/opts", (_n, bad) => {
    for (const t of TASKS) for (const ti of [...TIERS, "public"]) for (const o of [...OPTS8, undefined, null]) {
      expect(call(t, ti, bad, o)).toStrictEqual({ ok: false, violation: "PROVIDER_KIND_UNKNOWN" });
    }
  });
  it("unknown kind wins over unknown task/tier", () => {
    expect(call("chat", "public", "openai", undefined)).toStrictEqual({ ok: false, violation: "PROVIDER_KIND_UNKNOWN" });
  });
  it("truthy non-boolean opts count as false", () => {
    for (const bad of [1, "true", "yes", {}, [], [true], 2, -1]) {
      const o = { loopback: bad, allowPrivate: bad, endpointEnabled: bad };
      expect(call("plan", "standard", "local-openai-compatible", o)).toStrictEqual({ ok: false, violation: "LOCAL_NOT_LOOPBACK" });
      expect(call("plan", "standard", "remote-openai-compatible", o)).toStrictEqual({ ok: false, violation: "REMOTE_ENDPOINT_DISABLED" });
      expect(call("plan", "private", "local-openai-compatible", { loopback: true, endpointEnabled: true, allowPrivate: bad }))
        .toStrictEqual({ ok: false, violation: "LOCAL_PRIVATE_NOT_ALLOWED" });
      expect(call("plan", "standard", "local-openai-compatible", { loopback: true, endpointEnabled: bad }))
        .toStrictEqual({ ok: false, violation: "LOCAL_ENDPOINT_DISABLED" });
    }
  });
  it("missing / non-object opts: no throw, external kinds denied, firebase-ondevice ok", () => {
    for (const bad of [undefined, null, 0, 1, "", "loopback", true, [], () => 0]) {
      for (const t of TASKS) for (const ti of TIERS) {
        expect(() => call(t, ti, "local-openai-compatible", bad)).not.toThrow();
        expect(call(t, ti, "local-openai-compatible", bad).ok).toBe(false);
        expect(call(t, ti, "remote-openai-compatible", bad).ok).toBe(false);
        expect(call(t, ti, "firebase-ondevice", bad)).toStrictEqual({ ok: true });
        expect(call(t, ti, "firebase-cloud", bad)).toStrictEqual(expected(t, ti, "firebase-cloud", {}));
      }
    }
  });
  it("partial opts objects behave as missing fields = false", () => {
    expect(call("plan", "standard", "local-openai-compatible", { loopback: true })).toStrictEqual({ ok: false, violation: "LOCAL_ENDPOINT_DISABLED" });
    expect(call("plan", "standard", "local-openai-compatible", { loopback: true, endpointEnabled: true })).toStrictEqual({ ok: true });
    expect(call("plan", "standard", "remote-openai-compatible", { endpointEnabled: true })).toStrictEqual({ ok: true });
  });
  it("is pure: does not mutate frozen opts, deterministic across repeated calls", () => {
    const o = Object.freeze({ loopback: true, allowPrivate: false, endpointEnabled: true });
    const a = call("plan", "private", "local-openai-compatible", o);
    const b = call("plan", "private", "local-openai-compatible", o);
    expect(a).toStrictEqual(b);
    expect(o).toStrictEqual({ loopback: true, allowPrivate: false, endpointEnabled: true });
  });
  it("returns a fresh result object (callers cannot poison a shared constant)", () => {
    const a = call("plan", "standard", "firebase-ondevice", OPTS8[0]) as { ok: boolean; violation?: string };
    try { (a as { ok: boolean }).ok = false; (a as { violation?: string }).violation = "X"; } catch { /* frozen is also acceptable */ }
    expect(call("plan", "standard", "firebase-ondevice", OPTS8[0])).toStrictEqual({ ok: true });
  });
});

describe("O5 stop rule 1", () => {
  it("no (private|screenshot) case returns ok for remote or firebase-cloud/hybrid", () => {
    for (const k of ["remote-openai-compatible", "firebase-cloud", "firebase-hybrid"] as const)
      for (const t of TASKS) for (const ti of TIERS) for (const o of OPTS8) {
        if (ti === "private" || t === "screenshot") expect(call(t, ti, k, o).ok, `${k}/${t}/${ti}/${JSON.stringify(o)}`).toBe(false);
      }
  });
  it("screenshot is ok only for firebase-ondevice", () => {
    for (const k of KINDS) for (const ti of [...TIERS, "public"]) for (const o of OPTS8) {
      expect(call("screenshot", ti, k, o).ok, `${k}/${ti}`).toBe(k === "firebase-ondevice");
    }
  });
  it("shared + remote is never ok", () => {
    for (const t of TASKS) for (const o of OPTS8) expect(call(t, "shared", "remote-openai-compatible", o).ok).toBe(false);
  });
  it("private + local is ok only with loopback AND allowPrivate AND endpointEnabled (non-screenshot)", () => {
    for (const t of TASKS) for (const o of OPTS8) {
      const want = t !== "screenshot" && o.loopback && o.allowPrivate && o.endpointEnabled;
      expect(call(t, "private", "local-openai-compatible", o).ok, `${t}/${JSON.stringify(o)}`).toBe(want);
    }
  });
  it("any ok result for an external kind implies endpointEnabled === true", () => {
    for (const k of ["local-openai-compatible", "remote-openai-compatible"] as const)
      for (const t of TASKS) for (const ti of TIERS) for (const o of OPTS8) if (call(t, ti, k, o).ok) expect(o.endpointEnabled).toBe(true);
  });
});
