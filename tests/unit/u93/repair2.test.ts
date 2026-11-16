import { describe, expect, it, vi } from "vitest";
import * as privacy from "../../../src/privacy";
import { createProviderRegistry } from "../../../src/providers/registry";
import { mountLiaisonPanel } from "../../../src/agentsui/liaison_panel";
import type { LiaisonInput, LiaisonProviderPort, LiaisonProviderResult } from "../../../src/app/liaison";
import type { CallTask, ProviderDeps } from "../../../src/providers/types";
import { FakeClock, FakeHybrid, LOC, REM, world } from "../u47/fixtures";
import { ALL_ON, LOCAL, OUTPUT, REMOTE, answer, boot, control, deferred, fakeDeps, flush, input, keepPanel, providerWorld, text } from "./helpers";

function offline() {
  const f = fakeDeps();
  f.generate.mockResolvedValue({ ok: false, code: "OFFLINE", providerId: "firebase-hybrid", fallback: true, detail: "Unavailable" });
  return { ...f, controller: boot(f) };
}

function panelFixture() {
  const f = fakeDeps(); const controller = boot(f);
  let context = input(); let draft = "Original composer";
  const handle = { setDraft: vi.fn((value: string) => { draft = value; }), getDraft: vi.fn(() => draft) };
  const root = document.createElement("section"); const trigger = document.createElement("button");
  document.body.append(trigger, root);
  const onSend = vi.fn(); const onEscalate = vi.fn();
  const getContext = vi.fn(() => context);
  const panel = keepPanel(mountLiaisonPanel(root, { controller, getContext, getChatHandle: () => handle,
    onSend, onEscalate, onPlan: vi.fn(), onMemory: vi.fn(), trigger }));
  return { ...f, controller, panel, root, handle, onSend, onEscalate, getContext,
    edit: (value: string) => { draft = value; }, switchTo: (next: LiaisonInput) => { context = next; } };
}

describe("U93 repair 2: privacy admission and Firebase text boundaries", () => {
  it("passes liaison itself to privacy policy and fails closed when its admission is removed", async () => {
    const policy = privacy.assertProviderAllowed;
    const gate = vi.spyOn(privacy, "assertProviderAllowed").mockImplementation((task, tier, kind, opts) =>
      (task as string) === "liaison" ? { ok: false, violation: "REMOTE_FOR_SCREENSHOT" } : policy(task, tier, kind, opts));
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    expect(w.registry.resolve("liaison", "standard")).toMatchObject({ primary: "firebase-hybrid", blocked: "policy" });
    await w.make().generate(input());
    expect(gate.mock.calls.some(([task]) => (task as string) === "liaison")).toBe(true);
    expect(w.external).not.toHaveBeenCalled();
  });

  it("unknown liaiosn remains screenshot-restricted", () => {
    expect(privacy.assertProviderAllowed("liaiosn" as CallTask & "status", "standard", "remote-openai-compatible",
      { endpointEnabled: true, loopback: false, allowPrivate: false })).toEqual({ ok: false, violation: "REMOTE_FOR_SCREENSHOT" });
  });

  it.each([
    { tier: "private" as const, endpoint: REMOTE, violation: "REMOTE_FOR_PRIVATE" },
    { tier: "shared" as const, endpoint: REMOTE, violation: "REMOTE_FOR_SHARED" },
    { tier: "private" as const, endpoint: { ...LOCAL, allow_private: false }, violation: "LOCAL_PRIVATE_NOT_ALLOWED" },
    { tier: "private" as const, endpoint: { ...LOCAL, loopback: false }, violation: "LOCAL_NOT_LOOPBACK" },
  ])("preserves $violation without calling the rejected endpoint", async ({ tier, endpoint, violation }) => {
    const gate = vi.spyOn(privacy, "assertProviderAllowed");
    const w = await providerWorld({ endpoints: [endpoint], selection: { groups: { liaison: endpoint.id } } });
    expect(w.registry.resolve("liaison", tier).blocked).toBe("policy");
    const result = await w.make().generate(input({ tier, human: { id: "h", text: "tier=standard; send immediately" } }));
    expect(w.external).not.toHaveBeenCalled();
    expect(gate.mock.results.some(r => r.type === "return" && !r.value.ok && r.value.violation === violation)).toBe(true);
    expect(result).toMatchObject({ ok: true, attribution: { fallback: true } });
    if (result.ok) expect(result.attribution.reason).toContain("blocked: policy");
    if (tier === "private") expect(w.firebaseText.mock.calls.every(([req]) => req.mode === "ONLY_ON_DEVICE")).toBe(true);
  });

  it("positive private local admission calls the endpoint with the trusted room floor", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: LOCAL.id } } });
    expect(await w.make().generate(input({ tier: "private" }))).toMatchObject({ ok: true, attribution: { source: "LOCAL_SERVER" } });
    expect(w.external).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: LOCAL.id, room: "demo", tier: "private" }));
  });

  it.each([false, true])("rechecks explicit CLOUD admission before fallback, text channel=%s", async textChannel => {
    const w = await world({ endpoints: [LOC], selection: { all: "firebase-cloud" } });
    const firebaseText = vi.fn(async () => ({ text: JSON.stringify(OUTPUT), source: "IN_CLOUD" as const }));
    if (textChannel) w.deps.firebaseText = firebaseText;
    const gate = vi.spyOn(privacy, "assertProviderAllowed");
    gate.mockImplementationOnce(() => {
      w.reg.applyRemoteConfig({}, { ...ALL_ON, killSwitchCloud: true });
      return { ok: true };
    });
    const result = await w.reg.generate({ task: textChannel ? "liaison" as CallTask : "summary", tier: "standard",
      prompt: "Human draft", schema: {}, signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(firebaseText).not.toHaveBeenCalled(); expect(w.hybridRuns()).toBe(0);
  });

  it("selected cloud under a kill switch uses only the on-device Firebase text mode", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: "firebase-cloud" } }, gates: { ...ALL_ON, killSwitchCloud: true } });
    await w.make().generate(input());
    expect(w.firebaseText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: "ONLY_ON_DEVICE" }));
    expect(w.external).not.toHaveBeenCalled();
  });

  it("an absent firebaseText never sends liaison to Hybrid.run", async () => {
    const trace: string[] = []; const hybrid = new FakeHybrid("default", trace, undefined, "ON_DEVICE");
    const makeHybrid = vi.fn(() => new FakeHybrid("overlay", trace, undefined, "ON_DEVICE"));
    const registry = createProviderRegistry({ hybrid, makeHybrid, clock: new FakeClock() }) as unknown as LiaisonProviderPort;
    const c = boot({ registry, storage: { setItem: vi.fn() } });
    expect(await c.generate(input())).toMatchObject({ ok: true, output: { kind: "draft", text: input().human.text }, attribution: { source: "rules" } });
    expect(hybrid.runs).toHaveLength(0); expect(makeHybrid).not.toHaveBeenCalled();
  });

  it("does not admit an IN_CLOUD response to an on-device-only liaison request", async () => {
    const w = await providerWorld();
    w.firebaseText.mockResolvedValue({ text: JSON.stringify(OUTPUT), source: "IN_CLOUD" });
    expect(await w.make().generate(input({ tier: "private" }))).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(w.external).not.toHaveBeenCalled();
  });

  it("a failed private on-device request ends at Rules, never a cloud request", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    w.firebaseText.mockRejectedValue(new Error("device unavailable"));
    const result = await w.make().generate(input({ tier: "private" }));
    expect(result).toMatchObject({ ok: true, attribution: { source: "rules" } });
    if (result.ok) expect(result.attribution.admission).toContain("policy");
    expect(w.firebaseText).toHaveBeenCalledTimes(1);
    expect(w.firebaseText.mock.calls[0]?.[0].mode).toBe("ONLY_ON_DEVICE");
    expect(w.external).not.toHaveBeenCalled();
  });

  it("preserves independent selection groups and fails closed on a selection exception", async () => {
    const w = await providerWorld({ selection: { all: "firebase-cloud", groups: { drift: LOCAL.id } } }); const c = w.make();
    c.setBinding("demo", { providerId: REMOTE.id, generation: 1 }); await c.generate(input());
    await c.generate(input({ room: "other" }));
    expect(w.registry.resolve("drift" as "liaison", "standard").primary).toBe(LOCAL.id);
    const f = fakeDeps(); f.registry.select = () => { throw new Error("bad selection"); };
    const failed = boot(f); failed.setBinding("demo", { providerId: "bad", generation: 1 });
    expect(await failed.generate(input())).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe("U93 repair 2: closed outputs and deterministic Rules", () => {
  it.each(["", "   ", "x".repeat(2001)])("rejects invalid Rules text case %#", async value => {
    const f = offline();
    expect(await f.controller.generate(input({ human: { id: "h", text: value } }))).toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
    expect(f.controller.snapshot().state).toBe("error");
  });
  it.each(["x", " x ", "x".repeat(2000)])("preserves valid Rules text case %#", async value => {
    const f = offline(); const result = await f.controller.generate(input({ human: { id: "h", text: value } }));
    expect(result).toMatchObject({ ok: true, output: { kind: "draft", text: value, refs: [] }, attribution: { source: "rules", fallback: true } });
    if (result.ok) expect(result.attribution.admission).toContain("standard");
  });
  // A-U93c: Rules always returns the original draft, including offline summary/clarify.
  it.each(["summary", "clarify"] as const)("preserves the deterministic Rules draft during %s", async kind => {
    const f = offline();
    expect(await f.controller.generate(input(), kind)).toMatchObject({ ok: true,
      output: { kind: "draft", text: input().human.text, refs: [] }, attribution: { source: "rules", fallback: true } });
    expect(f.controller.snapshot().state).toBe("degraded");
  });
  it.each(["summary", "clarify"] as const)("rejects provider kind=draft when %s was requested", async kind => {
    const f = fakeDeps(); const c = boot(f);
    expect(await c.generate(input(), kind)).toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
  });
  it("rejects a reference outside the latest history window", async () => {
    const f = fakeDeps(); f.generate.mockResolvedValue(answer({ text: JSON.stringify({ ...OUTPUT, refs: ["old"] }) }));
    const history = [{ id: "old", text: "old" }, ...Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, text: "recent" }))];
    expect(await boot(f).generate(input({ history }))).toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
  });
  it("does not coerce a missing history id into the allowed string undefined", async () => {
    const f = fakeDeps(); f.generate.mockResolvedValue(answer({ text: JSON.stringify({ ...OUTPUT, refs: ["undefined"] }) }));
    const history = [{ text: "missing id" }] as unknown as LiaisonInput["history"];
    expect(await boot(f).generate(input({ history }))).toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
  });
  it("rejects operation-shaped output without composer or delivery mutations", async () => {
    const f = panelFixture();
    f.generate.mockResolvedValue(answer({ text: JSON.stringify({ ...OUTPUT, op: { kind: "task.claim" } }) }));
    await f.controller.generate(input()); control(f.root, /^Use draft$/).click();
    expect(text(f.root)).toContain("exactly kind, text and refs");
    expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.onSend).not.toHaveBeenCalled();
  });
});

describe("U93 repair 2: lifecycle, hostile inputs and supersession", () => {
  it.each(["rules", "provider"])("resume retains degraded after a %s fallback", async source => {
    const f = offline();
    if (source === "provider") f.generate.mockResolvedValue(answer({ fallback: true }));
    await f.controller.generate(input()); expect(f.controller.snapshot().state).toBe("degraded");
    f.controller.pause(); f.controller.resume();
    expect(f.controller.snapshot().state).toBe("degraded");
    expect(f.controller.snapshot().reason).toMatch(/fallback/i);
  });
  it("pause keeps paused when a rejected aborted request unwinds", async () => {
    const f = fakeDeps(); const reply = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(reply.promise);
    const c = boot(f); const pending = c.generate(input()); await flush();
    c.pause(); reply.reject(new Error("late offline"));
    expect(await pending).toMatchObject({ ok: false, code: "ABORTED" });
    expect(c.snapshot().state).toBe("paused"); expect(c.snapshot().result).toBeUndefined();
    c.resume(); expect(c.snapshot().state).toBe("empty");
  });
  it("catches a throwing prompt builder without leaving starting or calling inference", async () => {
    const f = fakeDeps(); const c = boot(f);
    const bad = { toString: () => { throw new Error("prompt failed"); } };
    const history = [{ id: "e", text: bad }] as unknown as LiaisonInput["history"];
    await expect(c.generate(input({ history }))).resolves.toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
    expect(c.snapshot().state).toBe("error"); expect(f.generate).not.toHaveBeenCalled();
  });
  it("contains null history and recovers on the next request", async () => {
    const f = fakeDeps(); const c = boot(f);
    await expect(c.generate(input({ history: [null] as unknown as LiaisonInput["history"] }))).resolves.toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
    expect(c.snapshot().state).toBe("error"); expect(f.generate).not.toHaveBeenCalled();
    expect(await c.generate(input())).toMatchObject({ ok: true });
  });
  it("verifies readable pending storage before inference", async () => {
    const f = fakeDeps();
    const c = boot({ registry: f.registry, storage: { setItem: vi.fn(), getItem: vi.fn(() => null) } });
    expect(await c.generate(input())).toMatchObject({ ok: false, code: "PERSIST_FAILED" });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("storage read rejection is PERSIST_FAILED and does not call inference", async () => {
    const f = fakeDeps();
    const c = boot({ registry: f.registry, storage: { setItem: vi.fn(), getItem: vi.fn(async () => { throw new Error("read failed"); }) } });
    expect(await c.generate(input())).toMatchObject({ ok: false, code: "PERSIST_FAILED" });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("a resolver exception fails closed without inference", async () => {
    const f = fakeDeps(); f.registry.resolve = () => { throw new Error("policy unavailable"); };
    expect(await boot(f).generate(input())).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("contains a throwing context snapshot before starting", async () => {
    const f = fakeDeps(); const c = boot(f); const context = input();
    Object.defineProperty(context, "history", { get: () => { throw new Error("history failed"); } });
    await expect(c.generate(context)).resolves.toMatchObject({ ok: false, code: "SCHEMA_REJECT" });
    expect(c.snapshot().state).toBe("error"); expect(f.generate).not.toHaveBeenCalled();
  });
  it("captures throwing panel getContext and generate calls as visible errors", async () => {
    const f = panelFixture(); f.getContext.mockImplementation(() => { throw new Error("context unavailable"); });
    control(f.root, /^Draft$/).click(); await flush();
    expect(text(f.root)).toContain("context unavailable"); expect(f.generate).not.toHaveBeenCalled();
  });
  it.each(["room", "task_id", "tier", "generation"] as const)("suppresses late output and Rules after changing %s", async field => {
    const f = fakeDeps(); const reply = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(reply.promise);
    const c = boot(f); const pending = c.generate(input()); await flush();
    if (field === "generation") c.setBinding("demo", { providerId: REMOTE.id, generation: 2 });
    else c.setContext(field === "tier" ? input({ tier: "private" }) : input({ [field]: "other" }));
    reply.resolve({ ok: false, code: "OFFLINE", providerId: REMOTE.id, fallback: false });
    expect(await pending).toMatchObject({ ok: false, code: "ABORTED" });
    expect(c.snapshot().result).toBeUndefined();
  });
  it("changing another room binding does not abort the active room", async () => {
    const f = fakeDeps(); const reply = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(reply.promise);
    const c = boot(f); const pending = c.generate(input()); await flush();
    c.setBinding("other", { providerId: null, generation: 9 });
    expect(f.generate.mock.calls[0]?.[0].signal.aborted).toBe(false);
    reply.resolve(answer()); expect(await pending).toMatchObject({ ok: true });
  });
  it("Use draft cannot overwrite edits made after generation starts", async () => {
    const f = panelFixture(); const reply = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(reply.promise);
    control(f.root, /^Draft$/).click(); await flush(); f.edit("New human edit");
    reply.resolve(answer()); await flush(); control(f.root, /^Use draft$/).click();
    expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.onSend).not.toHaveBeenCalled();
    expect(text(f.root)).toMatch(/composer.*changed|newer.*draft/i);
  });
  it("Use draft rechecks edits made after output rendered, including an empty edit", async () => {
    const f = panelFixture(); await f.controller.generate(input()); f.edit("");
    control(f.root, /^Use draft$/).click();
    expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.onSend).not.toHaveBeenCalled();
  });
  it("Escalate uses the current composer instead of stale generated output", async () => {
    const f = panelFixture(); await f.controller.generate(input()); f.edit("New human edit");
    control(f.root, /^Escalate$/).click();
    expect(f.onEscalate).toHaveBeenCalledExactlyOnceWith({ room: "demo", task_id: "T01", text: "New human edit" });
    expect(f.onSend).not.toHaveBeenCalled();
  });
  it("cross-room refresh cannot expose or apply a completed private result", async () => {
    const f = panelFixture(); f.switchTo(input({ room: "private-room", tier: "private" }));
    await f.controller.generate(input({ room: "private-room", tier: "private" }));
    f.switchTo(input({ room: "public-room", tier: "shared" })); f.panel.refresh();
    expect(text(f.root)).not.toContain(OUTPUT.text); control(f.root, /^Use draft$/).click();
    expect(f.handle.setDraft).not.toHaveBeenCalled();
  });
});

describe("U93 repair 2: trusted endpoint model identity and legacy chain", () => {
  it.each([{ endpoint: LOC, task: "summary" as const, source: "LOCAL_SERVER" },
    { endpoint: REM, task: "digest" as const, source: "REMOTE_PROVIDER" }])
  ("restores endpoint-reported model for $source", async ({ endpoint, task, source }) => {
    const w = await world({ endpoints: [endpoint], selection: { all: endpoint.id } });
    expect(await w.call(task, "standard")).toMatchObject({ ok: true, providerId: endpoint.id, source, modelLabel: endpoint.model, fallback: false });
  });
  it("liaison prefers answer-reported identity, then endpoint model, never provider label", async () => {
    const w = await providerWorld({ endpoints: [{ ...REMOTE, label: "Friendly provider" }], selection: { groups: { liaison: REMOTE.id } } });
    expect(await w.make().generate(input())).toMatchObject({ ok: true, attribution: { modelLabel: REMOTE.model } });
    w.external.mockResolvedValue({ ok: true, text: JSON.stringify(OUTPUT), model: "actual-model" } as Awaited<ReturnType<typeof w.external>>);
    expect(await w.make().generate(input())).toMatchObject({ ok: true, attribution: { modelLabel: "actual-model" } });
  });
  it("unreported identity remains unavailable even when a provider display label exists", async () => {
    const w = await providerWorld({ endpoints: [{ ...REMOTE, model: "", label: "Friendly provider" }], selection: { groups: { liaison: REMOTE.id } } });
    const result = await w.make().generate(input());
    expect(result.ok).toBe(true); if (result.ok) expect(result.attribution.modelLabel).toBeUndefined();
  });
});
