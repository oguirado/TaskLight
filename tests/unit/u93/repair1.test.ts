import { describe, expect, it, vi } from "vitest";
import { mountLiaisonPanel } from "../../../src/agentsui/liaison_panel";
import type { LiaisonPanelDeps } from "../../../src/agentsui/liaison_panel";
import type { LiaisonInput } from "../../../src/app/liaison";
import { answer, boot, control, deferred, fakeDeps, flush, input, keepPanel, LOCAL, OUTPUT, providerWorld, REMOTE, text } from "./helpers";

function panelFixture(overrides: Partial<LiaisonPanelDeps> = {}) {
  const f = fakeDeps();
  const controller = boot(f);
  let context = input({ room: "private-a", tier: "private" });
  const handle = { setDraft: vi.fn(), getDraft: vi.fn(() => "Direct human draft") };
  const onEscalate = vi.fn();
  const root = document.createElement("section");
  const trigger = document.createElement("button");
  document.body.append(trigger, root);
  const deps: LiaisonPanelDeps = { controller, getContext: () => context, getChatHandle: () => handle,
    onSend: vi.fn(), onEscalate, onPlan: vi.fn(), onMemory: vi.fn(), trigger, ...overrides };
  const panel = keepPanel(mountLiaisonPanel(root, deps));
  return { ...f, controller, root, panel, handle, onEscalate, deps,
    context: () => context, switchTo: (next: LiaisonInput) => { context = next; } };
}

describe("U93 repair 1: immutable result scope and supersession", () => {
  it.each(["room", "task_id", "tier"] as const)("invalidates a completed result when %s changes", async field => {
    const f = fakeDeps(); const c = boot(f);
    await c.generate(input());
    const changed = field === "tier" ? input({ tier: "private" }) : input({ [field]: "other" });
    c.setContext(changed);
    expect(c.snapshot().result).toBeUndefined();
  });

  it("invalidates completed results on binding generation changes without losing input", async () => {
    const f = fakeDeps(); const c = boot(f);
    c.setBinding("demo", { providerId: REMOTE.id, generation: 1 });
    await c.generate(input());
    c.setBinding("demo", { providerId: REMOTE.id, generation: 2 });
    expect(c.snapshot().result).toBeUndefined();
    expect(c.snapshot().input).toEqual(input());
  });

  it("panel refresh hides old output and actions cannot send it to the next room", async () => {
    const f = panelFixture();
    await f.controller.generate(f.context());
    expect(text(f.root)).toContain(OUTPUT.text);
    f.switchTo(input({ room: "shared-b", tier: "shared" })); f.panel.refresh();
    expect(f.controller.snapshot().input?.room).toBe("shared-b");
    expect(text(f.root)).not.toContain(OUTPUT.text);
    expect(control(f.root, /^Use draft$/).disabled).toBe(true);
    control(f.root, /^Use draft$/).click(); control(f.root, /^Escalate$/).click();
    expect(f.handle.setDraft).not.toHaveBeenCalled();
    expect(f.onEscalate).toHaveBeenCalledExactlyOnceWith({ room: "shared-b", task_id: "T01", text: "Direct human draft" });
  });

  it("actions recheck context even without a refresh", async () => {
    const f = panelFixture(); await f.controller.generate(f.context());
    f.switchTo(input({ room: "shared-b", tier: "shared" }));
    control(f.root, /^Use draft$/).click(); control(f.root, /^Escalate$/).click();
    expect(f.handle.setDraft).not.toHaveBeenCalled();
    expect(f.onEscalate.mock.calls[0]?.[0].text).not.toBe(OUTPUT.text);
  });

  it("an invalid new floor supersedes an earlier pending request before returning BLOCKED", async () => {
    const f = fakeDeps(); const late = deferred<ReturnType<typeof answer>>();
    f.generate.mockReturnValue(late.promise); const c = boot(f);
    const old = c.generate(input()); await flush();
    await expect(c.generate({ ...input(), tier: undefined } as unknown as LiaisonInput)).resolves.toMatchObject({ code: "BLOCKED" });
    expect(f.generate.mock.calls[0]![0].signal.aborted).toBe(true);
    late.resolve(answer()); await expect(old).resolves.toMatchObject({ code: "ABORTED" });
    expect(c.snapshot().result).toMatchObject({ code: "BLOCKED" });
  });

  it("binding identity is immutable and a late failure cannot publish Rules in another context", async () => {
    const f = fakeDeps(); const late = deferred<ReturnType<typeof answer>>(); f.generate.mockReturnValue(late.promise);
    const c = boot(f); c.setBinding("demo", { providerId: REMOTE.id, generation: 4 });
    let settled = false;
    const pending = c.generate(input()).then(result => { settled = true; return result; }); await flush();
    const scope = c.snapshot().identity;
    expect(scope).toMatchObject({ room: "demo", task_id: "T01", tier: "standard", generation: 4 });
    expect(Object.isFrozen(scope)).toBe(true);
    c.setContext(input({ room: "private-b", tier: "private" })); await flush();
    expect(settled).toBe(true);
    late.reject(new Error("late remote failure")); await flush();
    await expect(pending).resolves.toMatchObject({ code: "ABORTED" });
    expect(c.snapshot().result).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("captures host context instead of reading a mutated input after persistence", async () => {
    const f = fakeDeps(); const saved = deferred<void>();
    vi.mocked(f.storage.setItem).mockReturnValue(saved.promise); const c = boot(f);
    const context = input({ room: "private-a", tier: "private" }); const pending = c.generate(context);
    context.room = "shared-b"; context.tier = "shared"; context.human.text = "changed";
    saved.resolve(); await pending;
    expect(f.generate.mock.calls[0]![0]).toMatchObject({ room: "private-a", tier: "private" });
    expect(c.snapshot().input?.human.text).toBe(input().human.text);
  });
});

describe("U93 repair 1: bounded ports and serialized pending writes", () => {
  it.each(["storage", "generation"] as const)("destroy settles a hanging %s operation", async port => {
    const f = fakeDeps(); const never = new Promise<never>(() => {});
    if (port === "storage") vi.mocked(f.storage.setItem).mockReturnValue(never);
    else f.generate.mockReturnValue(never);
    const c = boot(f); let settled = false;
    const pending = c.generate(input()).then(result => { settled = true; return result; }); await flush();
    c.destroy(); await flush(); expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "ABORTED" });
    if (port === "storage") expect(f.generate).not.toHaveBeenCalled();
  });

  it.each(["storage", "generation"] as const)("a hanging %s operation has a finite deadline", async port => {
    const f = fakeDeps(); const never = new Promise<never>(() => {});
    if (port === "storage") vi.mocked(f.storage.setItem).mockReturnValue(never);
    else f.generate.mockReturnValue(never);
    const c = boot(f); let settled = false;
    const pending = c.generate(input()).then(result => { settled = true; return result; }); await flush();
    await vi.advanceTimersByTimeAsync(120000); expect(settled).toBe(true);
    const result = await pending;
    if (port === "storage") { expect(result).toMatchObject({ code: "PERSIST_FAILED" }); expect(f.generate).not.toHaveBeenCalled(); }
    else expect(result).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a late storage rejection after cancellation without starting inference", async () => {
    const f = fakeDeps(); const late = deferred<void>(); vi.mocked(f.storage.setItem).mockReturnValue(late.promise);
    const c = boot(f); let settled = false;
    const pending = c.generate(input()).then(result => { settled = true; return result; }); await flush();
    c.destroy(); await flush(); expect(settled).toBe(true);
    late.reject(new Error("late storage failure")); await flush();
    await expect(pending).resolves.toMatchObject({ code: "ABORTED" }); expect(f.generate).not.toHaveBeenCalled();
  });

  it("serializes actual writes so an older deferred write cannot overwrite a newer draft", async () => {
    const f = fakeDeps(); const release = deferred<void>(); let stored = ""; let count = 0;
    vi.mocked(f.storage.setItem).mockImplementation(async (_key, value) => {
      count += 1; if (count === 1) await release.promise; stored = value;
    });
    const c = boot(f); const older = c.generate(input({ human: { id: "old", text: "old" } })); await flush();
    const newer = c.generate(input({ human: { id: "new", text: "new" }, cursor: 8 })); await flush();
    expect(count).toBe(1);
    release.resolve(); await Promise.all([older, newer]);
    expect(JSON.parse(stored)).toEqual({ human: { id: "new", text: "new" }, cursor: 8 });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("a timed-out write keeps its queue slot until the actual write settles", async () => {
    const f = fakeDeps(); const release = deferred<void>(); let count = 0; let stored = "";
    vi.mocked(f.storage.setItem).mockImplementation(async (_key, value) => {
      count += 1; if (count === 1) await release.promise; stored = value;
    });
    const c = boot(f); const old = c.generate(input()); await flush();
    await vi.advanceTimersByTimeAsync(120000); // The old request expires, but its storage write is still running.
    const next = c.generate(input({ human: { id: "new", text: "new" } })); await flush();
    expect(count).toBe(1); release.resolve(); await Promise.all([old, next]);
    expect(JSON.parse(stored).human.text).toBe("new");
  });
});

describe("U93 repair 1: selection isolation and trusted metadata", () => {
  it("binding and removing liaison preserves independent groups and all selection", async () => {
    const w = await providerWorld({ selection: { all: "firebase-cloud", groups: { drift: LOCAL.id } } }); const c = w.make();
    c.setBinding("demo", { providerId: REMOTE.id, generation: 1 }); await c.generate(input());
    expect(w.registry.resolve("drift" as "liaison", "standard").primary).toBe(LOCAL.id);
    c.setBinding("demo", undefined); await c.generate(input());
    expect(w.registry.resolve("drift" as "liaison", "standard").primary).toBe(LOCAL.id);
    expect(w.registry.resolve("liaison", "standard").primary).toBe("firebase-cloud");
  });

  it("selection exceptions fail closed before inference", async () => {
    const f = fakeDeps(); vi.mocked(f.registry.select).mockImplementation(() => { throw new Error("selection failed"); });
    const c = boot(f); c.setBinding("demo", { providerId: REMOTE.id, generation: 1 });
    await expect(c.generate(input())).resolves.toMatchObject({ ok: false, code: "BLOCKED", reason: "selection failed" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("provider labels never become an unreported model identity", async () => {
    const w = await providerWorld({ endpoints: [{ ...REMOTE, model: "", label: "Friendly provider" }], selection: { groups: { liaison: REMOTE.id } } });
    const c = w.make(); const result = await c.generate(input());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.attribution.modelLabel).toBeFalsy();
    const root = document.createElement("section"); document.body.append(root);
    keepPanel(mountLiaisonPanel(root, { controller: c, getContext: () => input(), getChatHandle: () => undefined,
      onSend: vi.fn(), onPlan: vi.fn(), onMemory: vi.fn(), trigger: document.createElement("button") }));
    expect(text(root)).toContain("AUSENTE"); expect(text(root)).not.toContain("Friendly provider");
  });

  it("external reported model metadata takes precedence over provider labels", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    w.external.mockResolvedValue({ ok: true, text: JSON.stringify(OUTPUT), modelLabel: "Actual answer model" } as Awaited<ReturnType<typeof w.external>>);
    const result = await w.make().generate(input());
    expect(result).toMatchObject({ ok: true, attribution: { modelLabel: "Actual answer model" } });
  });

  it("Firebase unreported identity stays unavailable and reported metadata is propagated", async () => {
    const w = await providerWorld(); const c = w.make();
    const missing = await c.generate(input());
    if (missing.ok) expect(missing.attribution.modelLabel).toBeFalsy(); else expect.fail("Expected Firebase answer");
    w.firebaseText.mockResolvedValue({ text: JSON.stringify(OUTPUT), source: "IN_CLOUD", modelLabel: "Actual Firebase model" } as Awaited<ReturnType<typeof w.firebaseText>>);
    expect(await c.generate(input())).toMatchObject({ ok: true, attribution: { modelLabel: "Actual Firebase model" } });
  });
});

describe("U93 repair 1: callback containment and unified teardown", () => {
  it.each(["onSend", "onEscalate", "onPlan", "onMemory"] as const)("contains rejected %s and never retries", async name => {
    const failure = vi.fn(async () => { throw new Error("delivery failed"); });
    const f = panelFixture({ [name]: failure });
    const label = { onSend: "Send", onEscalate: "Escalate", onPlan: "Plan", onMemory: "Memory" }[name];
    control(f.root, new RegExp(`^${label}$`)).click(); await flush();
    expect(failure).toHaveBeenCalledTimes(1); expect(text(f.root)).toContain("delivery failed");
  });

  it.each(["setDraft", "pause", "resume"] as const)("observes a rejected %s port", async port => {
    const failure = vi.fn(async () => { throw new Error("port failed"); }); const f = panelFixture();
    await f.controller.generate(f.context());
    if (port === "setDraft") f.handle.setDraft.mockImplementation(failure);
    else vi.spyOn(f.controller, port).mockImplementation(failure);
    const label = { setDraft: "Use draft", pause: "Pause", resume: "Resume" }[port];
    // Hidden controls remain callable by programmatic events and must still be contained.
    control(f.root, new RegExp(`^${label}$`)).click(); await flush();
    expect(failure).toHaveBeenCalledTimes(1); expect(text(f.root)).toContain("port failed");
  });

  it("contains synchronous injected composer errors", () => {
    const f = panelFixture({ getChatHandle: () => ({ getDraft: () => { throw new Error("composer unavailable"); }, setDraft: vi.fn() }) });
    control(f.root, /^Send$/).click();
    expect(text(f.root)).toContain("composer unavailable");
  });

  it("contains a rejected generation port", async () => {
    const f = panelFixture(); vi.spyOn(f.controller, "generate").mockRejectedValue(new Error("generation failed"));
    control(f.root, /^Draft$/).click(); await flush();
    expect(text(f.root)).toContain("generation failed");
  });

  it("pagehide and destroy share idempotent cleanup including unsubscribe and listeners", () => {
    const f = fakeDeps(); const c = boot(f); const unsubscribe = vi.fn();
    vi.spyOn(c, "subscribe").mockReturnValue(unsubscribe); const destroy = vi.spyOn(c, "destroy");
    const removeWindow = vi.spyOn(globalThis, "removeEventListener");
    const root = document.createElement("section"); const removeContainer = vi.spyOn(root, "removeEventListener");
    document.body.append(root);
    const panel = keepPanel(mountLiaisonPanel(root, { controller: c, getContext: () => input(), getChatHandle: () => undefined,
      onSend: vi.fn(), onPlan: vi.fn(), onMemory: vi.fn(), trigger: document.createElement("button") }));
    globalThis.dispatchEvent(new Event("pagehide")); panel.destroy(); panel.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalledTimes(1);
    expect(removeWindow).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(removeContainer).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
