import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveMode, SOURCE_FLOORS } from "../../../src/lens/floors";
import { routeEvent, routeWithFallback } from "../../../src/router/route";
import { buildClassifierPrompt, buildConstraint, parseLabel } from "../../../src/router/nano";
import { MAX_TEXT, NANO_TIMEOUT_MS } from "../../../src/router/score";
import { ROUTE_TARGETS } from "../../../src/router/types";
import type { ClassifierPort } from "../../../src/router/types";
import { ANCHORS, HOSTILE, decisionProblems, ev } from "./fixtures";

type Req = Parameters<ClassifierPort>[0];
const ENUM = [...ROUTE_TARGETS, "abstain"];
const ABSTAINING = ev("answer", "bake a cake for grandma");

function spy(reply: (req: Req) => ReturnType<ClassifierPort>): { port: ClassifierPort; calls: Req[] } {
  const calls: Req[] = [];
  const port: ClassifierPort = (req) => { calls.push(req); return reply(req); };
  return { port, calls };
}
const says = (text: string, source: "ON_DEVICE" | "IN_CLOUD" = "ON_DEVICE") => spy(async () => ({ text, source }));

describe("nano helpers", () => {
  it("buildConstraint is the fixed enum incl. abstain", () => {
    const c = buildConstraint();
    expect(c.type).toBe("string");
    expect(c.enum).toEqual(ENUM);
  });
  it("buildClassifierPrompt lists every label and carries the text as data", () => {
    const p = buildClassifierPrompt("necesito ayuda con el despliegue");
    for (const l of ENUM) expect(p).toContain(l);
    expect(p).toContain("necesito ayuda con el despliegue");
  });
  it("parseLabel accepts exactly the enum", () => {
    for (const l of ENUM) expect(parseLabel(l)).toBe(l);
    for (const bad of ["", "Status_Query!", "status", "launch_missiles", "{\"label\":\"handoff\"}", "handoff handoff", "__proto__", "constructor"]) expect(parseLabel(bad)).toBeNull();
  });
});

describe("A7 Nano guards", () => {
  it("off-enum label gives nano_off_enum", async () => {
    const { port } = says("launch_missiles");
    const d = await routeWithFallback(ABSTAINING, "standard", port);
    expect(d.status).toBe("ABSTAIN");
    expect(d.reason).toBe("nano_off_enum");
    expect(d.target).toBe("inbox");
  });
  it.each(["", "The answer is handoff", "HANDOFF", "handoff.", "{\"label\":\"handoff\"}", "__proto__"])("near-miss %j is off-enum", async (txt) => {
    const d = await routeWithFallback(ABSTAINING, "standard", says(txt).port);
    expect(d.status).toBe("ABSTAIN");
    expect(d.reason).toBe("nano_off_enum");
  });
  it("abstain gives nano_abstain", async () => {
    const d = await routeWithFallback(ABSTAINING, "standard", says("abstain").port);
    expect([d.status, d.reason, d.target]).toEqual(["ABSTAIN", "nano_abstain", "inbox"]);
  });
  it("null port result gives nano_unavailable", async () => {
    const d = await routeWithFallback(ABSTAINING, "standard", spy(async () => null).port);
    expect([d.status, d.reason]).toEqual(["ABSTAIN", "nano_unavailable"]);
  });
  it("absent port gives nano_unavailable", async () => {
    const d = await routeWithFallback(ABSTAINING, "standard");
    expect([d.status, d.reason, d.target]).toEqual(["ABSTAIN", "nano_unavailable", "inbox"]);
  });
  it("a valid label is accepted at stage nano with the port's source", async () => {
    for (const label of ROUTE_TARGETS.filter((t) => t !== "inbox")) {
      const d = await routeWithFallback(ABSTAINING, "standard", says(label).port);
      expect([d.status, d.target, d.stage, d.source], label).toEqual(["OK", label, "nano", "ON_DEVICE"]);
      expect(decisionProblems(d)).toEqual([]);
    }
  });
  it("every stage-2 call carries constraint.enum == [...ROUTE_TARGETS, 'abstain']", async () => {
    const s = says("handoff");
    await routeWithFallback(ABSTAINING, "standard", s.port);
    await routeWithFallback(ev("answer", "zzz qqq"), "private", s.port);
    expect(s.calls.length).toBe(2);
    for (const c of s.calls) {
      expect((c.constraint as { enum: unknown }).enum).toEqual(ENUM);
      expect((c.constraint as { type: unknown }).type).toBe("string");
      expect(c.signal).toBeInstanceOf(AbortSignal);
      expect(c.prompt).toContain("abstain");
    }
  });
  it("the prompt carries the message text", async () => {
    const s = says("abstain");
    await routeWithFallback(ev("answer", "bake a cake for grandma"), "standard", s.port);
    expect(s.calls[0]!.prompt).toContain("bake a cake for grandma");
  });
});

describe("A6 privacy", () => {
  it("private tier sends mode ONLY_ON_DEVICE (derived through the existing effectiveMode/SOURCE_FLOORS)", async () => {
    const s = says("handoff");
    await routeWithFallback(ABSTAINING, "private", s.port);
    expect(s.calls[0]!.mode).toBe("ONLY_ON_DEVICE");
    expect(s.calls[0]!.mode).toBe(effectiveMode(SOURCE_FLOORS.agent.private, "PREFER_ON_DEVICE"));
  });
  it.each(["standard", "shared"] as const)("%s tier mode equals the shared helper's answer", async (tier) => {
    const s = says("handoff");
    await routeWithFallback(ABSTAINING, tier, s.port);
    expect(s.calls[0]!.mode).toBe(effectiveMode(SOURCE_FLOORS.agent[tier], "PREFER_ON_DEVICE"));
  });
  it("IN_CLOUD answer under the private tier gives ABSTAIN/privacy_cloud and never routes", async () => {
    const d = await routeWithFallback(ABSTAINING, "private", says("handoff", "IN_CLOUD").port);
    expect([d.status, d.reason, d.target]).toEqual(["ABSTAIN", "privacy_cloud", "inbox"]);
    expect(d.stage === "nano" && d.status === "OK").toBe(false);
  });
  it("IN_CLOUD under a non-private tier is allowed only if the mode permits it", async () => {
    const mode = effectiveMode(SOURCE_FLOORS.agent.standard, "PREFER_ON_DEVICE");
    const d = await routeWithFallback(ABSTAINING, "standard", says("handoff", "IN_CLOUD").port);
    if (mode === "ONLY_ON_DEVICE") expect(d.reason).toBe("privacy_cloud");
    else expect([d.status, d.source]).toEqual(["OK", "IN_CLOUD"]);
  });
  it("ON_DEVICE under the private tier is accepted", async () => {
    const d = await routeWithFallback(ABSTAINING, "private", says("escalate").port);
    expect([d.status, d.target, d.source]).toEqual(["OK", "escalate", "ON_DEVICE"]);
  });
});

describe("A8 stage order: Nano only when the deterministic stage abstains", () => {
  it("stage-0 OK never calls the port", async () => {
    const s = says("handoff");
    const d = await routeWithFallback(ev("question", "bake a cake", { to: "codex" }), "standard", s.port);
    expect([d.status, d.stage]).toEqual(["OK", "exact"]);
    expect(s.calls.length).toBe(0);
  });
  it("stage-1 OK never calls the port", async () => {
    for (const a of ANCHORS) {
      const s = says("handoff");
      const d = await routeWithFallback(ev("answer", a.text), "standard", s.port);
      expect([d.status, d.stage, d.target], a.text).toEqual(["OK", "lexical", a.target]);
      expect(s.calls.length, a.text).toBe(0);
    }
  });
  it("a stage-1 abstention calls the port exactly once", async () => {
    const s = says("abstain");
    await routeWithFallback(ABSTAINING, "standard", s.port);
    expect(s.calls.length).toBe(1);
  });
  it("a deterministic decision is returned unchanged when stage 1 answers (same JSON as routeEvent)", async () => {
    const e = ev("answer", "cambio de planificación");
    expect(JSON.stringify(await routeWithFallback(e, "standard", says("handoff").port))).toBe(JSON.stringify(routeEvent(e)));
  });
  it("text over MAX_TEXT never reaches the port", async () => {
    const s = says("handoff");
    const d = await routeWithFallback(ev("answer", "z".repeat(MAX_TEXT + 1)), "standard", s.port);
    expect(s.calls.length).toBe(0);
    expect(d.status).not.toBe("OK");
    expect(d.target).toBe("inbox");
  });
});

describe("A7 timeout (fake timers) and never rejects", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a port that never resolves gives nano_timeout within 450 ms", async () => {
    let signal: AbortSignal | undefined;
    const port: ClassifierPort = (r) => { signal = r.signal; return new Promise(() => undefined); };
    let settled: Awaited<ReturnType<typeof routeWithFallback>> | undefined;
    void routeWithFallback(ABSTAINING, "standard", port).then((d) => { settled = d; });
    await vi.advanceTimersByTimeAsync(NANO_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBeDefined();
    expect([settled!.status, settled!.reason, settled!.target]).toEqual(["ABSTAIN", "nano_timeout", "inbox"]);
    expect(signal!.aborted).toBe(true);
  });
  it("honours opts.timeoutMs", async () => {
    const port: ClassifierPort = () => new Promise(() => undefined);
    let settled: { reason?: string } | undefined;
    void routeWithFallback(ABSTAINING, "standard", port, { timeoutMs: 50 }).then((d) => { settled = d; });
    await vi.advanceTimersByTimeAsync(60);
    expect(settled?.reason).toBe("nano_timeout");
  });
  it("a late answer after the timeout is ignored", async () => {
    let resolve!: (v: { text: string; source: "ON_DEVICE" }) => void;
    const port: ClassifierPort = () => new Promise((r) => { resolve = r; });
    const p = routeWithFallback(ABSTAINING, "standard", port);
    await vi.advanceTimersByTimeAsync(NANO_TIMEOUT_MS + 10);
    resolve({ text: "handoff", source: "ON_DEVICE" });
    const d = await p;
    expect([d.status, d.reason]).toEqual(["ABSTAIN", "nano_timeout"]);
  });
  it("a fast answer clears the timer (no timers left pending)", async () => {
    const d = await routeWithFallback(ABSTAINING, "standard", says("handoff").port);
    expect(d.status).toBe("OK");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a timeout leaves no timers behind", async () => {
    const port: ClassifierPort = () => new Promise(() => undefined);
    const p = routeWithFallback(ABSTAINING, "standard", port);
    await vi.advanceTimersByTimeAsync(NANO_TIMEOUT_MS + 10);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never rejects: port rejects, throws synchronously, or returns garbage", async () => {
    const ports: ClassifierPort[] = [
      () => Promise.reject(new Error("boom")),
      () => { throw new Error("sync boom"); },
      () => Promise.reject(undefined),
      (() => Promise.resolve({})) as unknown as ClassifierPort,
      (() => Promise.resolve({ text: 42, source: "ON_DEVICE" })) as unknown as ClassifierPort,
      (() => Promise.resolve({ text: "handoff", source: "MARS" })) as unknown as ClassifierPort,
      (() => undefined) as unknown as ClassifierPort,
      (() => "handoff") as unknown as ClassifierPort,
    ];
    for (const port of ports) {
      const d = await routeWithFallback(ABSTAINING, "standard", port);
      expect(d.status).not.toBe("OK");
      expect(d.target).toBe("inbox");
      expect(decisionProblems(d)).toEqual([]);
    }
  });
  it("never rejects on hostile events, any tier, with or without a port", async () => {
    for (const s of HOSTILE.slice(0, 40)) {
      for (const tier of ["private", "standard", "shared"] as const) {
        await expect(routeWithFallback(ev("answer", s), tier, says("abstain").port)).resolves.toBeDefined();
        await expect(routeWithFallback(ev("answer", s), tier)).resolves.toBeDefined();
      }
    }
    await expect(routeWithFallback({} as never, "standard", says("abstain").port)).resolves.toBeDefined();
    await expect(routeWithFallback(ABSTAINING, "nonsense" as never, says("handoff").port)).resolves.toBeDefined();
  });
  it("timeout path ends in the human inbox", async () => {
    const port: ClassifierPort = () => new Promise(() => undefined);
    const p = routeWithFallback(ABSTAINING, "private", port);
    await vi.advanceTimersByTimeAsync(NANO_TIMEOUT_MS + 1);
    expect((await p).target).toBe("inbox");
  });
});
