// Repair loop 1 regressions (Sol review r0). Concrete failing inputs from REVIEW.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import type { AiConfig, ModelFactory, ModelHandle, HybridParamsShape } from "../../../src/ai/types";
import { CLOUD, makeFake, modeNameOf, ON, OK_ORIGIN, req, type Fake } from "./harness";
import { validateTaskOutput, VALID } from "./schemaMock";

vi.mock("../../../src/schema", () => import("./schemaMock"));
afterEach(() => { vi.restoreAllMocks(); validateTaskOutput.mockClear(); });

const mk = (config: Partial<AiConfig> = {}, factory: ModelFactory = makeFake()) =>
  createHybrid({ factory, origin: OK_ORIGIN, appCheckReady: true, config });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** Wrap a fake so every generateContent waits on a gate the test releases. */
function gated(fake: Fake) {
  const gates: Array<() => void> = [];
  const f: ModelFactory = {
    modeConst: (m) => fake.modeConst(m), sourceConst: fake.sourceConst,
    create(p: HybridParamsShape): ModelHandle {
      const h = fake.create(p);
      return {
        initializeDeviceModel: (cb) => h.initializeDeviceModel(cb),
        generateContent: async (r) => { await new Promise<void>((res) => gates.push(res)); return h.generateContent(r); },
      };
    },
  };
  return { f, release: () => gates.splice(0).forEach((g) => g()), pending: () => gates.length };
}

describe("R1 B7/B11/B12: private handle needs its own initialisation", () => {
  it("private summary after initDevice: the lazily built ONLY_ON_DEVICE handle is initialised before it generates", async () => {
    const fake = makeFake();
    // a device-only handle that was never initialised refuses to generate
    fake.reply = (task, p) => {
      const h = fake.handles.find((x) => x.params === p)!;
      if (modeNameOf(p) === "ONLY_ON_DEVICE" && h.inits === 0) return { throws: new Error("model not initialised") };
      return { text: VALID[task]!, inferenceSource: ON };
    };
    const h = mk({}, fake);
    await h.initDevice();
    expect(h.deviceStatus().state).toBe("ready");
    const r = await h.run(req("summary", { tier: "private" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const priv = fake.handles.filter((x) => x.task === "summary" && modeNameOf(x.params) === "ONLY_ON_DEVICE");
    expect(priv).toHaveLength(1);
    expect(priv[0]!.inits).toBeGreaterThanOrEqual(1);
  });

  it("a private request never reaches generateContent on a handle whose initializeDeviceModel rejected", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    fake.initFail = () => true;
    const r = await h.run(req("summary", { tier: "private" }));
    const priv = fake.handles.find((x) => x.task === "summary" && modeNameOf(x.params) === "ONLY_ON_DEVICE");
    if (priv) expect(priv.calls).toHaveLength(0);
    expect(r.ok).toBe(false);
  });
});

describe("R2 B18: run never rejects", () => {
  it("factory.create throwing for the lazy private variant -> resolved failure, not a rejection", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    const orig = fake.create.bind(fake);
    fake.create = () => { throw new Error("create boom"); };
    const r = await h.run(req("summary", { tier: "private" }));
    fake.create = orig;
    expect(r.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("generateContent resolves { response: undefined } -> SDK_ERROR, run resolves", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    for (const hd of fake.handles) (hd as { generateContent: unknown }).generateContent = async () => ({ response: undefined });
    const r = await h.run(req("summary"));
    expect(r).toMatchObject({ ok: false, code: "SDK_ERROR" });
  });

  it("response.inferenceSource getter that throws -> SDK_ERROR, run resolves", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    for (const hd of fake.handles) (hd as { generateContent: unknown }).generateContent = async () => ({
      response: { text: () => VALID["summary"]!, get inferenceSource(): unknown { throw new Error("getter boom"); } },
    });
    const r = await h.run(req("summary"));
    expect(r).toMatchObject({ ok: false, code: "SDK_ERROR" });
  });
});

describe("R3 B3/RunMeta: metadata comes from the request-time snapshot", () => {
  it("applyConfig({prompt_version:'v2'}) while a summary call is suspended: old call still reports configGen 0 / v1", async () => {
    const fake = makeFake();
    const g = gated(fake);
    const h = mk({}, g.f);
    await h.initDevice();
    const p = h.run(req("summary"));
    await flush();
    expect(g.pending()).toBe(1);
    expect(h.applyConfig({ prompt_version: "v2" }).configGen).toBe(1);
    g.release();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.meta.configGen).toBe(0);
    expect(r.meta.prompt_version).toBe("v1");
  });

  it("a failing suspended call also keeps its snapshot meta", async () => {
    const fake = makeFake();
    fake.reply = () => ({ throws: new Error("x") });
    const g = gated(fake);
    const h = mk({}, g.f);
    await h.initDevice();
    const p = h.run(req("next_action"));
    await flush();
    h.applyConfig({ prompt_version: "v9" });
    g.release();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.meta).toMatchObject({ configGen: 0, prompt_version: "v1", task: "next_action" });
  });
});

describe("R4 B12: initialisation ownership across applyConfig", () => {
  it("old initDevice completing after applyConfig({}) must not mark replacement handles ready", async () => {
    const fake = makeFake();
    fake.initMode = "manual";
    const h = mk({}, fake);
    const first = h.initDevice();
    await flush();
    expect(h.deviceStatus().state).toBe("downloading");
    h.applyConfig({});
    fake.initResolves.splice(0).forEach((r) => r());
    await first;
    await flush();
    expect(h.deviceStatus().state).not.toBe("ready");
    const r = await h.run(req("screenshot", { image: { mimeType: "image/png", data: "AAAA" } }));
    expect(r).toMatchObject({ ok: false, code: "DEVICE_NOT_INITIALISED" });
  });

  it("stale progress callback from an obsolete initialisation does not overwrite current status", async () => {
    const fake = makeFake();
    fake.initMode = "manual";
    const h = mk({}, fake);
    void h.initDevice();
    await flush();
    const old = fake.handles.slice(0, 5);
    h.applyConfig({});
    // replacement handles report nothing; old handles report 0.9 after being replaced
    for (const o of old) o.initCb?.(0.9);
    expect(h.deviceStatus()).not.toMatchObject({ state: "downloading", progress: 0.9 });
  });

  it("obsolete reinitialisation rejection must not overwrite a later successful one with needs_gesture", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    expect(h.deviceStatus().state).toBe("ready");
    fake.initMode = "manual";
    h.applyConfig({});            // reinit #1 (pending)
    const n1 = fake.initRejects.splice(0);
    fake.initResolves.splice(0);
    h.applyConfig({});            // reinit #2 supersedes #1
    const n2 = fake.initResolves.splice(0);
    fake.initRejects.splice(0);
    n2.forEach((r) => r());
    await flush();
    n1.forEach((r) => r(new Error("stale gesture")));
    await flush();
    expect(h.deviceStatus().state).toBe("ready");
  });

  it("control: a rejection of the CURRENT reinitialisation still yields needs_gesture (B12)", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    fake.initMode = "manual";
    h.applyConfig({});
    fake.initRejects.splice(0).forEach((r) => r(new Error("gesture")));
    await flush();
    expect(h.deviceStatus().state).toBe("needs_gesture");
  });
});

/*
 * REJECTED (not tested): Review finding 5 / fix 5 ("constraintPresent must not read undocumented handle.params";
 * wrapper that hides params must turn the verdict red).
 * Why: SPEC_U06 ModelHandle exposes only generateContent/initializeDeviceModel and B20 defines no factory receipt,
 * so a conforming opaque factory that strips onDeviceParams is unobservable by ANY implementation; the spec's own
 * O15 case (wrapper that strips onDeviceParams, tested in parity.test.ts) is the only observable form. Asserting
 * red for a params-hiding wrapper would invent an interface. Needs a spec change (e.g. an explicit receipt) first.
 * The review's "test gaming" remark concerns production code reading the harness-only `params` field; that is an
 * implementation matter and is not asserted here.
 */
void [CLOUD];
