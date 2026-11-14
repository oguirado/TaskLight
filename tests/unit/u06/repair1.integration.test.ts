// Repair loop 1: integration against the REAL U05 validator and TASK_SCHEMAS (no vi.mock of ../schema).
import { describe, expect, it } from "vitest";
import { TASK_SCHEMAS } from "../../../src/schema";
import { createHybrid } from "../../../src/ai/hybrid";
import { runParity } from "../../../src/ai/parity";
import type { HybridParamsShape, ModelFactory, ModelHandle } from "../../../src/ai/types";

const ON = { s: "on" }, CLOUD = { s: "cloud" };
const OUT: Record<string, string> = {
  status: "running",
  summary: JSON.stringify({ headline: "h", summary: "s" }),
  next_action: JSON.stringify({ next_action: "x", attention: "low" }),
  screenshot: JSON.stringify({ status: "idle", note: "n" }),
  digest: JSON.stringify({ needs_you: [], brief: "b" }),
};
function factory(text: (task: string) => string) {
  const created: HybridParamsShape[] = [];
  const f: ModelFactory = {
    modeConst: (m) => m, sourceConst: { ON_DEVICE: ON, IN_CLOUD: CLOUD },
    create(p): ModelHandle {
      created.push(p);
      const task = (Object.keys(TASK_SCHEMAS) as Array<keyof typeof TASK_SCHEMAS>)
        .find((k) => TASK_SCHEMAS[k].schema === p.inCloudParams.generationConfig.responseSchema);
      if (!task) throw new Error("params.responseSchema is not a real TASK_SCHEMAS reference");
      return {
        initializeDeviceModel: async () => undefined,
        generateContent: async () => ({ response: { text: () => text(task), inferenceSource: p.mode === "ONLY_IN_CLOUD" ? CLOUD : ON } }),
      };
    },
  };
  return { f, created };
}
const mk = (f: ModelFactory) => createHybrid({ factory: f, origin: "https://hybrid-app.web.app", appCheckReady: true });

describe("U06 against real U05", () => {
  it("builds params from real TASK_SCHEMAS (same reference for constraint and responseSchema, real mimeType)", () => {
    const { f, created } = factory((t) => OUT[t]!);
    mk(f);
    expect(created).toHaveLength(5);
    for (const p of created) {
      const k = (Object.keys(TASK_SCHEMAS) as Array<keyof typeof TASK_SCHEMAS>)
        .find((x) => TASK_SCHEMAS[x].schema === p.inCloudParams.generationConfig.responseSchema)!;
      expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(TASK_SCHEMAS[k].schema);
      expect(p.inCloudParams.generationConfig.responseMimeType).toBe(TASK_SCHEMAS[k].mimeType);
    }
  });
  it("real validator accepts a valid summary and rejects an unknown-field / non-JSON one with U05 rejects", async () => {
    let body = OUT["summary"]!;
    const { f } = factory(() => body);
    const h = mk(f);
    await h.initDevice();
    const ok = await h.run({ task: "summary", projectId: "p", tier: "standard", prompt: "x" });
    expect(ok).toMatchObject({ ok: true, source: "ON_DEVICE", value: { headline: "h", summary: "s" } });
    body = "not json at all";
    const bad = await h.run({ task: "summary", projectId: "p", tier: "standard", prompt: "x" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) { expect(bad.code).toBe("SCHEMA_REJECT"); expect(bad.rejects?.length).toBeGreaterThan(0); }
  });
  it("status enum: real validator rejects an out-of-enum value", async () => {
    const { f } = factory(() => "exploding");
    const h = mk(f);
    await h.initDevice();
    const r = await h.run({ task: "status", projectId: "p", tier: "standard", prompt: "x" });
    expect(r).toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
  });
  it("runParity with real validator: clean on valid output, t4 on 100% invalid", async () => {
    const good = factory((t) => OUT[t]!);
    const rows = await runParity([{ task: "digest", prompt: "p" }], good.f);
    expect(rows.every((r) => r.rejects === 0 && !r.t4 && r.constraintPresent)).toBe(true);
    const badF = factory(() => "{}");
    const bad = await runParity([{ task: "digest", prompt: "p" }], badF.f);
    expect(bad.every((r) => r.t4)).toBe(true);
  });
});
