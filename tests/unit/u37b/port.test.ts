import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDriftPrompt, diffPlans, reviewDrift } from "../../../src/agents";
import type { HybridParamsShape, ModeName, ModelFactory, ModelHandle } from "../../../src/ai/types";
import { driftPortFromFactory } from "../../../src/app/agent_drift";
import { claudeAt } from "./fixture";

/** Minimal structural fake of the U06 ModelFactory (src/ai/types.ts); `inferenceSource` is compared with `sourceConst`. */
const ON = Symbol("ON_DEVICE");
const CLOUD = Symbol("IN_CLOUD");
interface Rig { factory: ModelFactory; created: HybridParamsShape[]; prompts: unknown[] }
type Reply = { text: string; inferenceSource?: unknown } | Error | "hang";
const rig = (reply: Reply): Rig => {
  const created: HybridParamsShape[] = []; const prompts: unknown[] = [];
  const factory: ModelFactory = {
    modeConst: (m: ModeName): unknown => `mode:${m}`,
    sourceConst: { ON_DEVICE: ON, IN_CLOUD: CLOUD },
    create(params): ModelHandle {
      created.push(params);
      return {
        initializeDeviceModel: async () => undefined,
        generateContent: async (req) => {
          prompts.push(req);
          if (reply === "hang") return new Promise<never>(() => undefined);
          if (reply instanceof Error) throw reply;
          const r = reply;
          return { response: { text: () => r.text, ...("inferenceSource" in r ? { inferenceSource: r.inferenceSource } : {}) } };
        },
      };
    },
  };
  return { factory, created, prompts };
};
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } } };
const ok = (src: unknown, v = "on_track"): Reply => ({ text: JSON.stringify({ verdict: v, reason: "fine" }), inferenceSource: src });
const sig = () => new AbortController().signal;

afterEach(() => { vi.useRealTimers(); });

describe("driftPortFromFactory request shape", () => {
  it.each(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as const)("mode %s goes through factory.modeConst", async (mode) => {
    const r = rig(ok(ON));
    await driftPortFromFactory(r.factory, mode).generate("p", SCHEMA, sig());
    expect(r.created).toHaveLength(1);
    expect(pick0(r).mode).toBe(`mode:${mode}`);
  });

  it("passes the schema as responseConstraint (on device) AND responseSchema (cloud), same reference", async () => {
    const r = rig(ok(ON));
    await driftPortFromFactory(r.factory, "ONLY_ON_DEVICE").generate("p", SCHEMA, sig());
    const p = pick0(r);
    expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(SCHEMA);
    expect(p.inCloudParams.generationConfig.responseSchema).toBe(SCHEMA);
    expect(p.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
  });

  it("cloud params are complete: non-empty model name, positive integer maxOutputTokens", async () => {
    const r = rig(ok(CLOUD));
    await driftPortFromFactory(r.factory, "PREFER_ON_DEVICE").generate("p", SCHEMA, sig());
    const c = pick0(r).inCloudParams;
    expect(typeof c.model).toBe("string");
    expect(c.model.length).toBeGreaterThan(0);
    expect(Number.isInteger(c.generationConfig.maxOutputTokens)).toBe(true);
    expect(c.generationConfig.maxOutputTokens).toBeGreaterThan(0);
  });

  it("sends the prompt as a plain string, exactly once, using the real U34 schema", async () => {
    const prev = claudeAt(11).contract!; const next = claudeAt(14).contract!;
    const { prompt, schema } = buildDriftPrompt(prev, next, diffPlans(prev, next));
    const r = rig(ok(ON));
    await driftPortFromFactory(r.factory, "ONLY_ON_DEVICE").generate(prompt, schema, sig());
    expect(r.prompts).toEqual([prompt]);
    expect(pick0(r).onDeviceParams.promptOptions.responseConstraint).toBe(schema);
  });

  it("forwards each prompt of successive calls in order", async () => {
    const r = rig(ok(ON));
    const port = driftPortFromFactory(r.factory, "ONLY_ON_DEVICE");
    await port.generate("a", SCHEMA, sig());
    await port.generate("b", SCHEMA, sig());
    expect(r.prompts).toEqual(["a", "b"]);
  });
});

describe("driftPortFromFactory result mapping", () => {
  it("ON_DEVICE -> source device, IN_CLOUD -> source cloud, text from response.text()", async () => {
    const dev = await driftPortFromFactory(rig(ok(ON)).factory, "ONLY_ON_DEVICE").generate("p", SCHEMA, sig());
    expect(dev).toEqual({ text: JSON.stringify({ verdict: "on_track", reason: "fine" }), source: "device" });
    const cl = await driftPortFromFactory(rig(ok(CLOUD)).factory, "PREFER_ON_DEVICE").generate("p", SCHEMA, sig());
    expect(cl.source).toBe("cloud");
  });

  it.each([["missing", undefined], ["unknown symbol", Symbol("x")], ["string", "ON_DEVICE"], ["null", null]])("unrecognised inference source (%s) rejects instead of guessing", async (_n, src) => {
    const reply: Reply = src === undefined ? { text: "{}" } : { text: "{}", inferenceSource: src };
    await expect(driftPortFromFactory(rig(reply).factory, "ONLY_ON_DEVICE").generate("p", SCHEMA, sig())).rejects.toBeDefined();
  });

  it("SDK rejection propagates as port rejection (same error)", async () => {
    const boom = new Error("boom");
    await expect(driftPortFromFactory(rig(boom).factory, "ONLY_ON_DEVICE").generate("p", SCHEMA, sig())).rejects.toBe(boom);
  });

  it("a throwing response.text() rejects", async () => {
    const factory = rig(ok(ON)).factory;
    const f2: ModelFactory = { ...factory, create: () => ({ initializeDeviceModel: async () => undefined, generateContent: async () => ({ response: { text: () => { throw new Error("bad text"); }, inferenceSource: ON } }) }) };
    await expect(driftPortFromFactory(f2, "ONLY_ON_DEVICE").generate("p", SCHEMA, sig())).rejects.toThrow("bad text");
  });

  it("a throwing factory.create() rejects (never throws synchronously)", async () => {
    const f3: ModelFactory = { ...rig(ok(ON)).factory, create: () => { throw new Error("no model"); } };
    const port = driftPortFromFactory(f3, "ONLY_ON_DEVICE");
    let p: Promise<unknown> | undefined;
    expect(() => { p = port.generate("p", SCHEMA, sig()); }).not.toThrow();
    await expect(p).rejects.toThrow("no model");
  });
});

describe("driftPortFromFactory abort / timeout", () => {
  it("rejects when the signal aborts while the SDK call hangs", async () => {
    const ac = new AbortController();
    const p = driftPortFromFactory(rig("hang").factory, "ONLY_ON_DEVICE").generate("p", SCHEMA, ac.signal);
    const settled = vi.fn();
    p.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });

  it("an already aborted signal rejects", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(driftPortFromFactory(rig("hang").factory, "ONLY_ON_DEVICE").generate("p", SCHEMA, ac.signal)).rejects.toBeDefined();
  });
});

describe("driftPortFromFactory + U34 reviewDrift", () => {
  const prev = claudeAt(11).contract!; const next = claudeAt(14).contract!;

  it("device and cloud answers surface with their source", async () => {
    const d = await reviewDrift(driftPortFromFactory(rig(ok(ON, "needs_user")).factory, "ONLY_ON_DEVICE"), prev, next);
    expect(d).toEqual({ verdict: "needs_user", reason: "fine", source: "device" });
    const c = await reviewDrift(driftPortFromFactory(rig(ok(CLOUD, "drift")).factory, "PREFER_ON_DEVICE"), prev, next);
    expect(c.source).toBe("cloud");
    expect(c.verdict).toBe("drift");
  });

  it("SDK rejection and unknown source are absorbed by reviewDrift (rules, no rejection)", async () => {
    const a = await reviewDrift(driftPortFromFactory(rig(new Error("x")).factory, "ONLY_ON_DEVICE"), prev, next);
    const b = await reviewDrift(driftPortFromFactory(rig({ text: "{}" }).factory, "ONLY_ON_DEVICE"), prev, next);
    expect(a.source).toBe("rules");
    expect(b.source).toBe("rules");
  });

  it("a hanging SDK call times out through the abort signal and ends as rules", async () => {
    vi.useFakeTimers();
    const p = reviewDrift(driftPortFromFactory(rig("hang").factory, "ONLY_ON_DEVICE"), prev, next, { timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect((await p).source).toBe("rules");
  });
});

describe("static: no direct firebase import in U37b sources", () => {
  for (const f of ["agent_drift.ts", "agent_store.ts"]) {
    const src = readFileSync(resolve(process.cwd(), "src/app", f), "utf8");
    it(`${f} never imports firebase/* and uses no innerHTML/eval/new Function`, () => {
      expect(src).not.toMatch(/from\s+["']firebase\//);
      expect(src).not.toMatch(/require\(\s*["']firebase/);
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
    });
  }
});

function pick0(r: Rig): HybridParamsShape {
  const p = r.created[0];
  if (!p) throw new Error("factory.create was not called");
  return p;
}
