import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../../src/providers/registry";
import { renderNarrator } from "../../../src/views/narrator";
import { FakeHybrid } from "../u47/fixtures";
import { boot, CATEGORY_ITEMS, allCategories, CLOUD, DEVICE, MODES, item, response,
  input, vm, agent, run, flush, rules, params, registryTrace, mounted } from "./fixtures";

describe("A1 runtime SDK and attribution", () => {
  it("A1 submits gemini-4-hydrogen, PREFER_ON_DEVICE and the same closed schema to both channels", async () => {
    const r = boot(); await run(r);
    expect(r.generate).toHaveBeenCalledTimes(1);
    expect(r.factory.modeConst).toHaveBeenCalledWith("PREFER_ON_DEVICE");
    const p = params(r);
    expect(p.mode).toBe(MODES.PREFER_ON_DEVICE);
    expect(p.inCloudParams.model).toBe("gemini-4-hydrogen");
    expect(p.inCloudParams.generationConfig).toMatchObject({ maxOutputTokens: 200, responseMimeType: "application/json" });
    const schema = p.inCloudParams.generationConfig.responseSchema;
    expect(schema).toEqual(p.onDeviceParams.promptOptions.responseConstraint);
    expect(schema).toMatchObject({ additionalProperties: false, properties: { items: {
      items: { additionalProperties: false, properties: {
        kind: expect.any(Object), agent: expect.any(Object), task: expect.any(Object),
        blocked_on: expect.any(Object), owner: expect.any(Object),
      } },
    } } });
    expect(registryTrace.deps.length).toBeGreaterThan(0);
    expect(registryTrace.deps.every(d => d.transport === undefined)).toBe(true);
    expect(registryTrace.requests).toHaveLength(1);
    expect(registryTrace.requests[0]).toMatchObject({ task: "liaison", tier: "standard", room: "work",
      prompt: r.prompts[0], schema });
    expect(registryTrace.requests[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["device", DEVICE, "ON_DEVICE", "ON_DEVICE · Gemini Nano"],
    ["device-unavailable cloud-success", CLOUD, "IN_CLOUD", "IN_CLOUD · gemini-4-hydrogen · fallback"],
  ] as const)("A1 attributes %s solely from the SDK response", async (_case, sdkSource, source, label) => {
    const r = boot(() => response({ items: [item()] }, sdkSource));
    const snapshot = await run(r);
    expect(snapshot).toMatchObject({ kind: "generated", source });
    const { root } = mounted(snapshot, renderNarrator);
    expect(root.textContent).toContain(label);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.generate).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "unrecognised", "ON_DEVICE", "IN_CLOUD", null])(
    "A1 rejects unknown SDK inferenceSource %s rather than guessing from binding", async source => {
      const r = boot(() => ({ response: { text: () => JSON.stringify({ items: [item()] }), inferenceSource: source } }));
      rules(await run(r), "FIREBASE_FAILED");
    },
  );

  it("M2 keeps an unrelated registry selection unchanged", async () => {
    const r = boot();
    const hybrid = new FakeHybrid("shared", [], undefined, "ON_DEVICE");
    const shared = createProviderRegistry({ hybrid, makeHybrid: () => hybrid, clock: r.clock });
    shared.select({ all: "firebase-ondevice", groups: { capsule: "firebase-ondevice" } });
    const before = shared.getSelection();
    await run(r); r.controller.update(input({ binding: { providerId: "firebase-ondevice", generation: 2 } }));
    await flush(r);
    expect(shared.getSelection()).toEqual(before);
  });
});

describe("A3 deterministic rules and M1 contract", () => {
  it.each([null, "rules"])("A3 binding %s is rules-only and identical VM stays deterministic", async providerId => {
    const r = boot();
    const context = input({ binding: { providerId, generation: 1 } });
    const first = await run(r, context);
    r.controller.update(context); await flush(r);
    expect(r.controller.snapshot().text).toBe(first.text);
    rules(r.controller.snapshot()); expect(r.generate).not.toHaveBeenCalled();
  });

  it.each(["NEEDS_SETUP", "OFFLINE"] as const)("A3 exposes readable %s provider failure", async code => {
    const r = boot();
    registryTrace.failure = { ok: false, code, providerId: "firebase-hybrid", fallback: false };
    const snapshot = await run(r); rules(snapshot, code);
    const { root } = mounted(snapshot, renderNarrator);
    expect(root.textContent).toMatch(/Rules summary/i);
    expect(root.textContent).toMatch(code === "OFFLINE" ? /offline/i : /setup|set up/i);
    expect(root.textContent).not.toMatch(/ON_DEVICE ·|IN_CLOUD ·/);
  });

  it("A3 empty membership says No agents deployed", async () => {
    const r = boot(() => response({ items: [] }));
    const snapshot = await run(r, input({ vm: vm([]) }));
    expect(snapshot.text).toContain("No agents deployed");
    const { root } = mounted(snapshot, renderNarrator);
    expect(root.textContent).toContain("No agents deployed");
  });

  it("M1 publishes changed snapshots to subscribers", async () => {
    const r = boot(); const seen: string[] = [];
    r.controller.subscribe(() => seen.push(r.controller.snapshot().text));
    await run(r);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toContain(r.controller.snapshot().text);
  });

  it("M8 rules cover working, upstream task and owner, unknown liveness, failure and operator needs", async () => {
    const r = boot();
    const snapshot = await run(r, input({ vm: allCategories(), binding: { providerId: null, generation: 1 } }));
    rules(snapshot);
    for (const id of ["executor-a", "executor-b", "executor-c", "executor-d", "executor-e", "T01", "T02"])
      expect(snapshot.text).toContain(id);
    expect(snapshot.text).toMatch(/working/i);
    expect(snapshot.text).toMatch(/Liveness unknown/i);
    expect(snapshot.text).toMatch(/failed/i);
    expect(snapshot.text).toMatch(/needs? (you|operator)|unanswered/i);
  });

  it("M5 accepts all five grounded categories with no unrestricted prose", async () => {
    const r = boot(() => response({ items: CATEGORY_ITEMS }));
    const snapshot = await run(r, input({ vm: allCategories() }));
    expect(snapshot.kind).toBe("generated");
    for (const id of allCategories().agents.map(a => a.agent)) expect(snapshot.text).toContain(id);
    expect(snapshot.text).toMatch(/Liveness unknown/i); expect(snapshot.text).toMatch(/failed/i);
  });

  it.each(["waiting", "finished"] as const)("C.M5 accepted empty items narrate nonempty %s membership", async state => {
    const r = boot(() => response({ items: [] }));
    const a = agent("executor-w", "T01", { activity: state === "waiting" ? "waiting" : "done",
      lifecycle: state === "finished" ? "finished" : "deployed" });
    const snapshot = await run(r, input({ vm: vm([a]) }));
    expect(snapshot.text.trim()).not.toBe("");
    expect(snapshot.text).not.toContain("No agents deployed");
    expect(snapshot.text).toMatch(state === "waiting" ? /waiting/i : /finished/i);
    expect(snapshot.reason).not.toBe("SCHEMA_REJECT");
  });
});
