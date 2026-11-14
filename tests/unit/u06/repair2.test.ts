// Repair loop 2 regressions (Sol review r1). Concrete failing inputs from REVIEW.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import { runParity } from "../../../src/ai/parity";
import type { AiConfig, HybridParamsShape, ModelFactory, ModelHandle, ParityCase } from "../../../src/ai/types";
import { makeFake, OK_ORIGIN, PNG, req, type Fake } from "./harness";
import { validateTaskOutput, VALID } from "./schemaMock";

vi.mock("../../../src/schema", () => import("./schemaMock"));
afterEach(() => { vi.restoreAllMocks(); validateTaskOutput.mockClear(); });

const mk = (config: Partial<AiConfig> = {}, factory: ModelFactory = makeFake()) =>
  createHybrid({ factory, origin: OK_ORIGIN, appCheckReady: true, config });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const PENDING = Symbol("pending");
const settledWithin = <V,>(p: Promise<V>, ms = 30): Promise<V | typeof PENDING> =>
  Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);
/** resolve every manual initialisation until none is outstanding (also those started meanwhile) */
async function drainInits(fake: Fake) {
  for (let i = 0; i < 5; i++) { fake.initResolves.splice(0).forEach((r) => r()); fake.initRejects.splice(0); await flush(); }
}

describe("R2-1 B11: a request never blocks on device initialisation", () => {
  it("private summary whose lazily built handle's initializeDeviceModel never settles: run still resolves, no generateContent", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    expect(h.deviceStatus().state).toBe("ready");
    fake.initMode = "manual"; // every further initializeDeviceModel stays pending forever
    const out = await settledWithin(h.run({ task: "summary", projectId: "p", tier: "private", prompt: "x" }));
    expect(out).not.toBe(PENDING);
    expect(out).toMatchObject({ ok: false, code: "DEVICE_NOT_INITIALISED", meta: { called: false } });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("R2-2 B11/B12: admission follows the readiness of the handle that will serve the request", () => {
  it("applyConfig({}) after ready, replacement init pending: screenshot (ONLY_ON_DEVICE) is refused and never reaches generateContent", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    fake.initMode = "manual";
    h.applyConfig({});
    const r = await h.run(req("screenshot", { image: PNG }));
    expect(r).toMatchObject({ ok: false, code: "DEVICE_NOT_INITIALISED", meta: { called: false, configGen: 1 } });
    expect(fake.calls).toHaveLength(0);
  });

  it("same with a private request on an already-built private handle that was replaced by applyConfig", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    expect((await h.run(req("summary", { tier: "private" }))).ok).toBe(true); // builds + initialises the private handle
    fake.calls.length = 0;
    fake.initMode = "manual";
    h.applyConfig({});
    const r = await settledWithin(h.run(req("summary", { tier: "private" })));
    expect(r).not.toBe(PENDING);
    expect(r).toMatchObject({ ok: false, code: "DEVICE_NOT_INITIALISED" });
    expect(fake.calls).toHaveLength(0);
  });

  it("control: once the replacement initialisations resolve, the same screenshot request succeeds", async () => {
    const fake = makeFake();
    const h = mk({}, fake);
    await h.initDevice();
    fake.initMode = "manual";
    h.applyConfig({});
    await drainInits(fake);
    const r = await h.run(req("screenshot", { image: PNG }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("R2-3 B12: an obsolete download is not left stranded as `downloading`", () => {
  it("pending initDevice, applyConfig({}), original initialisations resolve: status does not stay `downloading` once nothing is in flight", async () => {
    const fake = makeFake();
    fake.initMode = "manual";
    const h = mk({}, fake);
    const first = h.initDevice();
    await flush();
    expect(h.deviceStatus().state).toBe("downloading");
    h.applyConfig({});
    await drainInits(fake); // resolves the original five and anything started for the replacements
    await first;
    await flush();
    expect(h.deviceStatus().state).not.toBe("downloading");
  });

  it("after that, an explicit initDevice() restarts initialisation and reaches ready", async () => {
    const fake = makeFake();
    fake.initMode = "manual";
    const h = mk({}, fake);
    const first = h.initDevice();
    await flush();
    h.applyConfig({});
    await drainInits(fake);
    await first;
    fake.initMode = "auto";
    const st = await h.initDevice();
    expect(st.state).toBe("ready");
    expect(h.deviceStatus().state).toBe("ready");
  });
});

describe("R2-4 B20: malformed responses in parity count as rejects instead of rejecting runParity", () => {
  const wrap = (fake: Fake, gen: ModelHandle["generateContent"]): ModelFactory => ({
    modeConst: (m) => fake.modeConst(m), sourceConst: fake.sourceConst,
    create(p: HybridParamsShape): ModelHandle {
      const h = fake.create(p);
      return { initializeDeviceModel: (cb) => h.initializeDeviceModel(cb), generateContent: gen };
    },
  });
  const cases: ParityCase[] = [{ task: "summary", prompt: "a" }, { task: "summary", prompt: "b" }];

  it("generateContent resolving { response: undefined }: both rows report rejects = n", async () => {
    const f = wrap(makeFake(), (async () => ({ response: undefined })) as never);
    const rows = await runParity(cases, f);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ n: 2, rejects: 2, rate: 1, t4: true });
  });

  it("generateContent resolving { response: null }: counted as rejects", async () => {
    const f = wrap(makeFake(), (async () => ({ response: null })) as never);
    const rows = await runParity(cases, f);
    for (const r of rows) expect(r).toMatchObject({ n: 2, rejects: 2 });
  });

  it("inferenceSource getter that throws: counted as rejects", async () => {
    const f = wrap(makeFake(), (async () => ({
      response: { text: () => VALID["summary"]!, get inferenceSource(): unknown { throw new Error("getter boom"); } },
    })) as never);
    const rows = await runParity(cases, f);
    for (const r of rows) expect(r).toMatchObject({ n: 2, rejects: 2, t4: true });
  });

});

/*
 * REJECTED (not tested), Review r1:
 * - "Unbounded retention" (readyHandles keeps obsolete handles): internal Set, unobservable through the public seam
 *   (createHybrid/ModelFactory); would need gc/WeakRef (flaky, non-deterministic) or reading private state. No spec rule.
 * - Fix 5a/5b "constraintPresent via undocumented handle.params / explicit receipt contract": same rejection as loop 1;
 *   SPEC ModelHandle has no params or receipt, so an opaque factory is unobservable. Needs a spec change first.
 * - "On-device response from the forced cloud handle passes as clean cloud observation": B20 enumerates rejects as
 *   SCHEMA_REJECT / BAD_SOURCE / SDK_ERROR; B16 (PRIVACY_VIOLATION) is defined only for ONLY_ON_DEVICE. No rule makes
 *   ON_DEVICE-on-forced-cloud a reject. Needs a spec change.
 * - "Test gaming" remark and obsolete-handle release: implementation matter.
 */
