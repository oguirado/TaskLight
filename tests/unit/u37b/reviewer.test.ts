import { afterEach, describe, expect, it, vi } from "vitest";
import { diffPlans, driftRules } from "../../../src/agents";
import type { AgentState } from "../../../src/agents/types";
import type { DriftPort } from "../../../src/agents";
import type { ModeName } from "../../../src/ai/types";
import { createDriftReviewer } from "../../../src/app/agent_drift";
import { PLAN_V3_ADD, PLAN_V3_DROP_DONE, PLAN_V3_DROP_PENDING, claudeAt, planV3, pick } from "./fixture";

afterEach(() => { vi.useRealTimers(); });

type Gen = DriftPort["generate"];
const answer = (verdict: string, source: "device" | "cloud" = "device") => ({ text: JSON.stringify({ verdict, reason: "model says so" }), source });
const portOf = (impl: Gen) => { const generate = vi.fn(impl); return { port: { generate } satisfies DriftPort, generate }; };
const okPort = (verdict = "on_track", source: "device" | "cloud" = "device") => portOf(async () => answer(verdict, source));
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** claude: v1 (step 2 active) at lamport 11 -> v2 edits that step at lamport 12. */
const before = (): AgentState => claudeAt(11);
const after = (): AgentState => claudeAt(14);

describe("no review without a previous contract", () => {
  it("returns undefined and never calls the port (plan v1 only, or no plan at all)", async () => {
    const { port, generate } = okPort();
    const r = createDriftReviewer({ port });
    expect(await r.review(before())).toBeUndefined();
    expect(await r.review(claudeAt(1))).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
  it("without a port too", async () => {
    expect(await createDriftReviewer().review(before())).toBeUndefined();
  });
});

describe("model answers", () => {
  it("passes a valid on-device answer through with its source; port called once with (prompt, schema, AbortSignal)", async () => {
    const { port, generate } = okPort("needs_user", "device");
    const r = createDriftReviewer({ port });
    await r.review(before());
    const v = await r.review(after());
    expect(v).toEqual({ verdict: "needs_user", reason: "model says so", source: "device" });
    expect(generate).toHaveBeenCalledTimes(1);
    const [prompt, schema, signal] = pick(generate.mock.calls, 0);
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Implement token refresh with rotation");
    expect(prompt).toContain("untrusted");
    expect(schema).toMatchObject({ type: "object", required: ["verdict", "reason"] });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  it("cloud source passes through", async () => {
    const r = createDriftReviewer({ port: okPort("drift", "cloud").port });
    await r.review(before());
    expect((await r.review(after()))?.source).toBe("cloud");
  });
  it("a valid model verdict wins over the rules (model on_track although rules say drift)", async () => {
    const r = createDriftReviewer({ port: okPort("on_track").port });
    await r.review(before());
    expect((await r.review(after()))?.verdict).toBe("on_track");
  });
});

describe("memoisation by room/agent/prevHash->hash", () => {
  it("same state reviewed twice -> one port call, same verdict", async () => {
    const { port, generate } = okPort();
    const r = createDriftReviewer({ port });
    await r.review(before());
    const a = await r.review(after());
    const b = await r.review(after());
    expect(b).toEqual(a);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("concurrent reviews of the same state share one call", async () => {
    const d = deferred<ReturnType<typeof answer>>();
    const { port, generate } = portOf(() => d.promise);
    const r = createDriftReviewer({ port });
    await r.review(before());
    const p1 = r.review(after()); const p2 = r.review(after());
    d.resolve(answer("on_track"));
    expect(await p1).toEqual(await p2);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("a new plan (new hash, previous = old contract) is reviewed again", async () => {
    const { port, generate } = okPort();
    const r = createDriftReviewer({ port });
    await r.review(before());
    await r.review(after());
    await r.review(claudeAt(14, [planV3(PLAN_V3_ADD)]));
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("different room or agent with identical hashes are separate keys", async () => {
    const { port, generate } = okPort();
    const r = createDriftReviewer({ port });
    const a = after();
    await r.review(before());
    await r.review(a);
    await r.review({ ...a, room: "other-room" });
    await r.review({ ...a, agent: "other-agent" });
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it("the rules fallback is memoised too (a failing port is not hammered on every refresh)", async () => {
    const { port, generate } = portOf(async () => { throw new Error("down"); });
    const r = createDriftReviewer({ port });
    await r.review(before());
    const a = await r.review(after());
    const b = await r.review(after());
    expect(b).toEqual(a);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("one review at a time", () => {
  it("a second review starts only after the first has settled", async () => {
    const d1 = deferred<ReturnType<typeof answer>>();
    let n = 0;
    const { port, generate } = portOf(() => (++n === 1 ? d1.promise : Promise.resolve(answer("drift"))));
    const r = createDriftReviewer({ port });
    await r.review(before());
    const p1 = r.review(after());
    const p2 = r.review(claudeAt(14, [planV3(PLAN_V3_ADD)]));
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    d1.resolve(answer("on_track"));
    expect((await p1)?.verdict).toBe("on_track");
    expect((await p2)?.verdict).toBe("drift");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("never more than one port call in flight across many queued reviews", async () => {
    let inflight = 0; let max = 0;
    const { port } = portOf(async () => { inflight++; max = Math.max(max, inflight); await Promise.resolve(); await Promise.resolve(); inflight--; return answer("on_track"); });
    const r = createDriftReviewer({ port });
    await r.review(before());
    const a = after();
    await Promise.all([1, 2, 3, 4, 5].map((i) => r.review({ ...a, agent: `agent-${i}` })));
    expect(max).toBe(1);
  });
  it("a failed review does not wedge the queue", async () => {
    let n = 0;
    const { port } = portOf(async () => { if (++n === 1) throw new Error("x"); return answer("on_track"); });
    const r = createDriftReviewer({ port });
    await r.review(before());
    await r.review(after());
    expect((await r.review(claudeAt(14, [planV3(PLAN_V3_ADD)])))?.source).toBe("device");
  });
});

describe("mode selection (floor x kill switch)", () => {
  const modes = async (floor: "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE" | undefined, killSwitchCloud: boolean | undefined): Promise<ModeName[]> => {
    const seen: ModeName[] = [];
    const factory = (m: ModeName): DriftPort => { seen.push(m); return okPort().port; };
    const r = createDriftReviewer({ port: factory, ...(killSwitchCloud === undefined ? {} : { killSwitchCloud }) });
    await r.review(before(), floor);
    await r.review(after(), floor);
    return seen;
  };
  it("no floor given -> ONLY_ON_DEVICE (private by default)", async () => { expect(await modes(undefined, false)).toEqual(["ONLY_ON_DEVICE"]); });
  it("floor ONLY_ON_DEVICE -> ONLY_ON_DEVICE even with the kill switch off", async () => { expect(await modes("ONLY_ON_DEVICE", false)).toEqual(["ONLY_ON_DEVICE"]); });
  it("floor PREFER_ON_DEVICE and kill switch off -> PREFER_ON_DEVICE", async () => { expect(await modes("PREFER_ON_DEVICE", false)).toEqual(["PREFER_ON_DEVICE"]); });
  it("kill switch unset counts as off", async () => { expect(await modes("PREFER_ON_DEVICE", undefined)).toEqual(["PREFER_ON_DEVICE"]); });
  it("floor PREFER_ON_DEVICE but kill switch on -> ONLY_ON_DEVICE", async () => { expect(await modes("PREFER_ON_DEVICE", true)).toEqual(["ONLY_ON_DEVICE"]); });
  it("a plain DriftPort object is accepted regardless of mode", async () => {
    const { port, generate } = okPort();
    const r = createDriftReviewer({ port });
    await r.review(before(), "PREFER_ON_DEVICE");
    await r.review(after(), "PREFER_ON_DEVICE");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("rules with the REAL step states (no port, or port failure)", () => {
  const rulesOnly = () => createDriftReviewer();
  it("edit of an ACTIVE step -> drift (U34's reviewDrift fallback alone would say on_track)", async () => {
    const r = rulesOnly();
    expect(await r.review(before())).toBeUndefined();
    const v = await r.review(after());
    expect(v?.verdict).toBe("drift");
    expect(v?.source).toBe("rules");
    expect((v?.reason.length ?? 999)).toBeLessThanOrEqual(140);
    // sanity: with all-pending states (what reviewDrift's internal fallback uses) the same diff is only on_track
    const s = after();
    const diff = diffPlans(s.previous!, s.contract!);
    expect(driftRules(diff, { ...s, contract: s.previous!, stepStates: s.previous!.steps.map(() => "pending" as const) }).verdict).toBe("on_track");
  });
  it("addition only -> on_track", async () => {
    const r = rulesOnly();
    await r.review(claudeAt(14));
    expect((await r.review(claudeAt(14, [planV3(PLAN_V3_ADD)])))).toMatchObject({ verdict: "on_track", source: "rules" });
  });
  it("removal of a pending step -> needs_user", async () => {
    const r = rulesOnly();
    await r.review(claudeAt(14));
    expect((await r.review(claudeAt(14, [planV3(PLAN_V3_DROP_PENDING)])))).toMatchObject({ verdict: "needs_user", source: "rules" });
  });
  it("removal of a DONE step -> drift", async () => {
    const r = rulesOnly();
    await r.review(claudeAt(14));
    expect((await r.review(claudeAt(14, [planV3(PLAN_V3_DROP_DONE)])))).toMatchObject({ verdict: "drift", source: "rules" });
  });
  it("port that rejects -> same real-state rules verdict (drift), source rules", async () => {
    const { port } = portOf(async () => { throw new Error("nano unavailable"); });
    const r = createDriftReviewer({ port });
    await r.review(before());
    expect(await r.review(after())).toMatchObject({ verdict: "drift", source: "rules" });
  });
  it.each([["not json", "<<nope>>"], ["wrong enum", JSON.stringify({ verdict: "great", reason: "x" })], ["over-long reason", JSON.stringify({ verdict: "drift", reason: "x".repeat(141) })]])("port answering %s -> rules with real states", async (_n, text) => {
    const r = createDriftReviewer({ port: portOf(async () => ({ text, source: "device" as const })).port });
    await r.review(before());
    expect(await r.review(after())).toMatchObject({ verdict: "drift", source: "rules" });
  });
  it("cold start (first sight is already v2, real states of the removed step unknowable) still yields a rules verdict, no rejection", async () => {
    const v = await rulesOnly().review(after());
    expect(v).toBeDefined();
    expect(v?.source).toBe("rules");
    expect(["on_track", "drift", "needs_user"]).toContain(v?.verdict);
  });
});

describe("timeout and robustness", () => {
  it("timeoutMs is honoured: hanging port -> rules verdict after the timeout, signal aborted", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { port } = portOf((_p, _s, sg) => { signal = sg; return new Promise<never>(() => undefined); });
    const r = createDriftReviewer({ port, timeoutMs: 500 });
    await r.review(before());
    const p = r.review(after());
    await vi.advanceTimersByTimeAsync(499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await p).toMatchObject({ verdict: "drift", source: "rules" });
  });
  it("after a timeout the queue is free for the next review", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { port } = portOf(() => (++n === 1 ? new Promise<never>(() => undefined) : Promise.resolve(answer("on_track"))));
    const r = createDriftReviewer({ port, timeoutMs: 100 });
    await r.review(before());
    const p1 = r.review(after());
    const p2 = r.review(claudeAt(14, [planV3(PLAN_V3_ADD)]));
    await vi.advanceTimersByTimeAsync(100);
    await p1;
    expect((await p2)?.source).toBe("device");
  });
  it("never rejects: synchronous port throw, null state, malformed state, port returning garbage", async () => {
    const thrower = createDriftReviewer({ port: { generate: () => { throw new Error("sync"); } } });
    await thrower.review(before());
    await expect(thrower.review(after())).resolves.toMatchObject({ source: "rules" });
    const r = createDriftReviewer({ port: okPort().port });
    await expect(r.review(null as unknown as AgentState)).resolves.toBeUndefined();
    await expect(r.review({} as unknown as AgentState)).resolves.toBeUndefined();
    const broken = { ...after(), previous: { ...after().previous!, steps: "nope" } } as unknown as AgentState;
    await expect(r.review(broken)).resolves.toSatisfy((v: unknown) => v === undefined || typeof v === "object");
    const garbage = createDriftReviewer({ port: { generate: async () => 42 as never } });
    await garbage.review(before());
    await expect(garbage.review(after())).resolves.toMatchObject({ source: "rules" });
  });
  it("a state whose previous equals its contract (no change) is not reviewed", async () => {
    const { port, generate } = okPort();
    const s = after();
    expect(await createDriftReviewer({ port }).review({ ...s, previous: s.contract! })).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
});
