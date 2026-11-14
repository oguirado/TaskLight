// Repair r6 regressions (Sol review r5). Concrete failing inputs from REVIEW.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import { runParity } from "../../../src/ai/parity";
import type { ParityCase } from "../../../src/ai/types";
import { makeFake, modeNameOf, OK_ORIGIN, type Fake, type FakeHandle } from "./harness";
import { validateTaskOutput } from "./schemaMock";

vi.mock("../../../src/schema", () => import("./schemaMock"));
afterEach(() => { vi.restoreAllMocks(); validateTaskOutput.mockClear(); });

const mk = (fake: Fake = makeFake()) => ({ fake, h: createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true }) });
const throwing = (name: string): never => { throw new Error("boom-" + name); };

describe("R6-1 B18: run never rejects, even when reading the request or copying ctx throws", () => {
  const base = { task: "summary" as const, projectId: "p", tier: "standard" as const, prompt: "x" };
  const cases: Array<[string, () => unknown]> = [
    ["prompt getter throws", () => ({ ...base, get prompt(): string { return throwing("prompt"); } })],
    ["tier getter throws", () => ({ ...base, get tier(): string { return throwing("tier"); } })],
    ["projectId getter throws", () => ({ ...base, get projectId(): string { return throwing("pid"); } })],
    ["task getter throws", () => ({ ...base, get task(): string { return throwing("task"); } })],
    ["image getter throws", () => ({ ...base, get image(): unknown { return throwing("image"); } })],
    ["image.data getter throws", () => ({ ...base, image: { mimeType: "image/png", get data(): string { return throwing("data"); } } })],
    ["ctx getter throws", () => ({ ...base, get ctx(): unknown { return throwing("ctx"); } })],
    ["ctx.knownProjectIds getter throws", () => ({ ...base, ctx: { get knownProjectIds(): unknown { return throwing("ids"); } } })],
    ["knownProjectIds Set with throwing iterator", () => {
      const s = new Set<string>(["p"]);
      (s as unknown as { [Symbol.iterator]: () => never })[Symbol.iterator] = () => throwing("iter");
      return { ...base, ctx: { knownProjectIds: s } };
    }],
    ["req.ctx getter throws on second read (during validation copy)", () => {
      let n = 0;
      return { ...base, get ctx(): unknown { if (n++ >= 1) return throwing("ctx2"); return { knownProjectIds: new Set(["p"]) }; } };
    }],
  ];
  for (const [name, make] of cases) {
    it(`${name}: resolves SDK_ERROR, meta.called false, no SDK call`, async () => {
      const { fake, h } = mk();
      await h.initDevice();
      let out: unknown;
      let rejected: unknown;
      try { out = await h.run(make() as never); } catch (e) { rejected = e; }
      expect(rejected).toBeUndefined();
      expect(out).toMatchObject({ ok: false, code: "SDK_ERROR" });
      if (!name.includes("second read")) {
        // failure happens before any SDK call
        expect(out).toMatchObject({ meta: { called: false } });
        expect(fake.calls).toHaveLength(0);
      }
    });
  }
  it("control: a plain request still succeeds after a failed one", async () => {
    const { h } = mk();
    await h.initDevice();
    const bad = { ...base, get prompt(): string { return throwing("p"); } };
    await h.run(bad as never);
    expect(await h.run(base)).toMatchObject({ ok: true });
  });
});

/** A factory whose forced-on-device handles refuse to generate until initializeDeviceModel was called. */
function initEnforcing(failInit = false) {
  const fake = makeFake();
  const order: string[] = [];
  const ready = new Set<FakeHandle>();
  fake.initFail = () => failInit;
  const origCreate = fake.create.bind(fake);
  fake.create = (params) => {
    const h = origCreate(params) as FakeHandle;
    const isOn = modeNameOf(params) === "ONLY_ON_DEVICE";
    const gen = h.generateContent.bind(h);
    const init = h.initializeDeviceModel!.bind(h);
    h.initializeDeviceModel = async (cb) => { order.push(`init:${h.index}`); await init(cb); ready.add(h); };
    h.generateContent = async (r) => {
      order.push(`gen:${h.index}`);
      if (isOn && !ready.has(h)) throw new Error("device model not initialised");
      return gen(r);
    };
    return h;
  };
  return { fake, order, ready };
}
const pcases = (task: ParityCase["task"], n: number): ParityCase[] =>
  Array.from({ length: n }, (_, i) => ({ task, prompt: `p${i}` }));

describe("R6-2 B20: parity initialises forced ONLY_ON_DEVICE handles before generating", () => {
  it("init-enforcing factory: on-device row is clean (rejects 0, t4 false), not a masked setup failure", async () => {
    const { fake } = initEnforcing();
    const rows = await runParity(pcases("summary", 4), fake);
    const on = rows.find((r) => r.source === "ON_DEVICE")!;
    expect(on).toMatchObject({ n: 4, rejects: 0, rate: 0, t4: false });
    expect(rows.every((r) => !r.t4)).toBe(true);
  });
  it("every forced on-device handle is initialised, and before its first generateContent", async () => {
    const { fake, order } = initEnforcing();
    await runParity([...pcases("summary", 2), ...pcases("screenshot", 1).map((c) => ({ ...c, image: { mimeType: "image/png", data: "AAAA" } }))], fake);
    const onHandles = fake.handles.filter((h) => modeNameOf(h.params) === "ONLY_ON_DEVICE");
    expect(onHandles.length).toBeGreaterThanOrEqual(2);
    for (const h of onHandles) {
      expect(h.inits).toBeGreaterThanOrEqual(1);
      expect(order.indexOf(`init:${h.index}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`init:${h.index}`)).toBeLessThan(order.indexOf(`gen:${h.index}`));
    }
  });
});

describe("R6-3 B20: initialisation failure is a setup error, not output rejects / T4", () => {
  it("failing initializeDeviceModel: runParity rejects with a setup error and never generates on that handle", async () => {
    const { fake } = initEnforcing(true);
    let out: unknown;
    let err: unknown;
    try { out = await runParity(pcases("summary", 4), fake); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(out).toBeUndefined();
    const onHandles = fake.handles.filter((h) => modeNameOf(h.params) === "ONLY_ON_DEVICE");
    for (const h of onHandles) expect(h.calls).toHaveLength(0);
  });
  it("failing init never yields a row with rejects/t4 attributed to the schema", async () => {
    const { fake } = initEnforcing(true);
    const rows = await runParity(pcases("summary", 4), fake).catch(() => [] as Awaited<ReturnType<typeof runParity>>);
    expect(rows.some((r) => r.source === "ON_DEVICE" && (r.rejects > 0 || r.t4))).toBe(false);
  });
});
