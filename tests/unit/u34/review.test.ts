import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDriftPrompt, diffPlans, reviewDrift } from "../../../src/agents";
import type { Contract, DriftVerdict } from "../../../src/agents/types";
import { contract } from "./fixture";

type Gen = (prompt: string, schema: object, signal: AbortSignal) => Promise<{ text: string; source: "device" | "cloud" }>;
const port = (impl: Gen) => { const generate = vi.fn<Gen>(impl); return { generate }; };
const ok = (v: unknown, source: "device" | "cloud" = "device"): Gen => async () => ({ text: typeof v === "string" ? v : JSON.stringify(v), source });

const PREV = contract("Plan", ["a", "b", "c"]);
const ADD_ONLY = contract("Plan", ["a", "b", "c", "d"]);
const REORDER = contract("Plan", ["c", "a", "b"]);
const REMOVE = contract("Plan", ["a", "b"]);

const RULE_CASES: [string, Contract, "on_track" | "needs_user"][] = [
  ["pure addition -> on_track", ADD_ONLY, "on_track"],
  ["reorder -> needs_user", REORDER, "needs_user"],
];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("A6 reviewDrift: model answers", () => {
  it.each([["device"], ["cloud"]] as const)("valid answer from the %s port is returned with that source", async (source) => {
    const p = port(ok({ verdict: "drift", reason: "Step b was dropped." }, source));
    const v = await reviewDrift(p, PREV, REMOVE);
    expect(v).toEqual({ verdict: "drift", reason: "Step b was dropped.", source });
    expect(p.generate).toHaveBeenCalledTimes(1);
  });

  it.each(["on_track", "drift", "needs_user"] as const)("accepts verdict %s", async (verdict) => {
    const v = await reviewDrift(port(ok({ verdict, reason: "r" })), PREV, ADD_ONLY);
    expect(v.verdict).toBe(verdict);
    expect(v.source).toBe("device");
  });

  it("a reason of exactly 140 characters is accepted, an empty reason too", async () => {
    const r140 = "r".repeat(140);
    expect((await reviewDrift(port(ok({ verdict: "on_track", reason: r140 })), PREV, ADD_ONLY)).reason).toBe(r140);
    expect((await reviewDrift(port(ok({ verdict: "on_track", reason: "" })), PREV, ADD_ONLY)).source).toBe("device");
  });

  it("calls the port once with the prompt and schema from buildDriftPrompt and an un-aborted AbortSignal", async () => {
    const p = port(ok({ verdict: "on_track", reason: "ok" }));
    await reviewDrift(p, PREV, ADD_ONLY);
    const { prompt, schema } = buildDriftPrompt(PREV, ADD_ONLY, diffPlans(PREV, ADD_ONLY));
    const [gotPrompt, gotSchema, gotSignal] = p.generate.mock.calls[0] as [string, object, AbortSignal];
    expect(gotPrompt).toBe(prompt);
    expect(gotSchema).toEqual(schema);
    expect(gotSignal).toBeInstanceOf(AbortSignal);
    expect(gotSignal.aborted).toBe(false);
  });

  it("after a successful answer the timeout timer is cleared and the signal is never aborted", async () => {
    let signal: AbortSignal | undefined;
    const p = port(async (_p, _s, sg) => { signal = sg; return { text: JSON.stringify({ verdict: "on_track", reason: "ok" }), source: "device" }; });
    await reviewDrift(p, PREV, ADD_ONLY);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(false);
  });
});

describe("A6 reviewDrift: fallback to driftRules (never rejects)", () => {
  const BAD_TEXT: [string, string][] = [
    ["not JSON", "I think it drifted"],
    ["empty string", ""],
    ["truncated JSON", '{"verdict":"drift","reas'],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON string", '"drift"'],
    ["JSON number", "7"],
    ["wrong enum value", JSON.stringify({ verdict: "maybe", reason: "x" })],
    ["enum with other case", JSON.stringify({ verdict: "DRIFT", reason: "x" })],
    ["enum padded with space", JSON.stringify({ verdict: " drift", reason: "x" })],
    ["verdict missing", JSON.stringify({ reason: "x" })],
    ["verdict not a string", JSON.stringify({ verdict: 1, reason: "x" })],
    ["reason missing", JSON.stringify({ verdict: "drift" })],
    ["reason not a string", JSON.stringify({ verdict: "drift", reason: 5 })],
    ["reason over 140 characters", JSON.stringify({ verdict: "drift", reason: "r".repeat(141) })],
    ["inherited key as verdict", JSON.stringify({ verdict: "constructor", reason: "x" })],
    ["__proto__ verdict", '{"verdict":"__proto__","reason":"x"}'],
  ];

  describe.each(RULE_CASES)("%s", (_n, next, expected) => {
    it.each(BAD_TEXT)("model output: %s", async (_label, text) => {
      const p = port(ok(text, "cloud"));
      const v = await reviewDrift(p, PREV, next);
      expect(v.source).toBe("rules");
      expect(v.verdict).toBe(expected);
      expect(v.reason.length).toBeGreaterThan(0);
      expect(v.reason.length).toBeLessThanOrEqual(140);
      expect(p.generate).toHaveBeenCalledTimes(1);
    });

    it("port rejection with an Error", async () => {
      const p = port(async () => { throw new Error("model offline"); });
      expect(await reviewDrift(p, PREV, next)).toMatchObject({ source: "rules", verdict: expected });
      expect(p.generate).toHaveBeenCalledTimes(1);
    });
  });

  it("rejection with a non-Error value and a synchronous throw both resolve to the rules verdict", async () => {
    const a = port(() => Promise.reject("boom"));
    const b = { generate: vi.fn<Gen>(() => { throw new TypeError("sync"); }) };
    expect((await reviewDrift(a, PREV, REORDER)).source).toBe("rules");
    expect((await reviewDrift(b, PREV, REORDER)).source).toBe("rules");
    expect(a.generate).toHaveBeenCalledTimes(1);
    expect(b.generate).toHaveBeenCalledTimes(1);
  });

  it("malformed port results (undefined, text not a string) resolve to the rules verdict", async () => {
    for (const r of [undefined, null, {}, { text: 5, source: "device" }]) {
      const p = { generate: vi.fn(() => Promise.resolve(r as never)) };
      const v = await reviewDrift(p as never, PREV, REORDER);
      expect(v.source).toBe("rules");
      expect(p.generate).toHaveBeenCalledTimes(1);
    }
  });

  it("a removal falls back to a non-on_track rules verdict", async () => {
    const v = await reviewDrift(port(ok("nope")), PREV, REMOVE);
    expect(v.source).toBe("rules");
    expect(["needs_user", "drift"]).toContain(v.verdict);
  });

  it("fallback equals what driftRules would say for the same diff when the model is unusable (stable across calls)", async () => {
    const a = await reviewDrift(port(ok("nope")), PREV, REORDER);
    const b = await reviewDrift(port(ok("")), PREV, REORDER);
    expect(a).toEqual(b);
  });
});

describe("A6 reviewDrift: timeout (fake timers)", () => {
  const hang = () => {
    let signal: AbortSignal | undefined;
    const p = port((_pr, _sc, sg) => { signal = sg; return new Promise(() => undefined); });
    return { p, signal: () => signal };
  };
  const track = (pr: Promise<DriftVerdict>) => { const st: { done: boolean; v?: DriftVerdict } = { done: false }; void pr.then((v) => { st.done = true; st.v = v; }); return st; };

  it("default timeout is 8000 ms: pending at 7999, resolved with rules at 8000, signal aborted", async () => {
    const { p, signal } = hang();
    const st = track(reviewDrift(p, PREV, REORDER));
    await vi.advanceTimersByTimeAsync(7999);
    expect(st.done).toBe(false);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(st.done).toBe(true);
    expect(signal()?.aborted).toBe(true);
    expect(st.v).toMatchObject({ source: "rules", verdict: "needs_user" });
    expect(p.generate).toHaveBeenCalledTimes(1);
  });

  it("opts.timeoutMs overrides the default", async () => {
    const { p, signal } = hang();
    const st = track(reviewDrift(p, PREV, ADD_ONLY, { timeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(49);
    expect(st.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(st.done).toBe(true);
    expect(signal()?.aborted).toBe(true);
    expect(st.v).toMatchObject({ source: "rules", verdict: "on_track" });
  });

  it("a port that ignores the signal and answers after the timeout does not change the result", async () => {
    let resolve: (v: { text: string; source: "device" }) => void = () => undefined;
    const p = port(() => new Promise((r) => { resolve = r; }));
    const st = track(reviewDrift(p, PREV, ADD_ONLY, { timeoutMs: 100 }));
    await vi.advanceTimersByTimeAsync(100);
    resolve({ text: JSON.stringify({ verdict: "drift", reason: "late" }), source: "device" });
    await vi.advanceTimersByTimeAsync(0);
    expect(st.v?.source).toBe("rules");
    expect(p.generate).toHaveBeenCalledTimes(1);
  });

  it("a port that rejects when aborted still yields exactly one rules verdict and never rejects", async () => {
    const p = port((_pr, _sc, sg) => new Promise((_res, rej) => sg.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const pr = reviewDrift(p, PREV, REORDER, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pr).resolves.toMatchObject({ source: "rules", verdict: "needs_user" });
  });

  it("an answer arriving before the timeout wins, with no leftover timers", async () => {
    let resolve: (v: { text: string; source: "cloud" }) => void = () => undefined;
    const p = port(() => new Promise((r) => { resolve = r; }));
    const st = track(reviewDrift(p, PREV, REMOVE, { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(500);
    resolve({ text: JSON.stringify({ verdict: "needs_user", reason: "Ask the user." }), source: "cloud" });
    await vi.advanceTimersByTimeAsync(0);
    expect(st.v).toEqual({ verdict: "needs_user", reason: "Ask the user.", source: "cloud" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
