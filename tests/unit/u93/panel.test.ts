import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mountLiaisonPanel } from "../../../src/agentsui/liaison_panel";
import type { LiaisonComposer, LiaisonPanelDeps } from "../../../src/agentsui/liaison_panel";
import type { LiaisonAttribution, LiaisonController, LiaisonInput, LiaisonResult, LiaisonSnapshot } from "../../../src/app/liaison";
import { HOSTILE, OUTPUT, answer, boot, control, deferred, fakeDeps, flush, input, keepPanel, text } from "./helpers";

const successful = (attribution: Partial<LiaisonAttribution> = {}, generated = OUTPUT.text): LiaisonResult => ({ ok: true,
  output: { ...OUTPUT, text: generated }, attribution: { providerId: "answering-provider", modelLabel: "Reported model",
    source: "REMOTE_PROVIDER", fallback: false, admission: "Admitted by standard room policy", ...attribution } });

function panelFixture(options: { snapshot?: Partial<LiaisonSnapshot>; result?: LiaisonResult; context?: LiaisonInput;
  absentHandle?: boolean; absentEscalate?: boolean } = {}) {
  let context = options.context ?? input();
  let snapshot: LiaisonSnapshot = { state: "ready", reason: "Liaison ready", input: context,
    result: options.result ?? successful(), ...options.snapshot };
  const listeners = new Set<() => void>();
  const emit = (next: Partial<LiaisonSnapshot>): void => { snapshot = { ...snapshot, ...next }; for (const cb of listeners) cb(); };
  const controller: LiaisonController = {
    generate: vi.fn(async () => snapshot.result!), setBinding: vi.fn(), setContext: vi.fn(), snapshot: () => snapshot,
    subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    pause: vi.fn(() => emit({ state: "paused", reason: "Liaison locally suspended; executor status unchanged" })),
    resume: vi.fn(() => emit({ state: "ready", reason: "Liaison ready" })), destroy: vi.fn(),
  };
  let draft = "Existing executor composer";
  let dead = false;
  const handle: LiaisonComposer = { setDraft: vi.fn(value => { if (!dead) draft = value; }), getDraft: vi.fn(() => dead ? "" : draft) };
  const root = document.createElement("section");
  const conversation = document.createElement("section"); conversation.setAttribute("aria-label", "Executor conversation");
  conversation.textContent = "Existing executor conversation and delivery receipt";
  const trigger = document.createElement("button"); trigger.textContent = "Open liaison";
  document.body.append(trigger, conversation, root);
  const post = vi.fn(); const escalate = vi.fn(); const onPlan = vi.fn(); const onMemory = vi.fn();
  const getChatHandle = vi.fn((_context: { room: string; task_id: string }) => options.absentHandle ? undefined : handle);
  const deps: LiaisonPanelDeps = { controller, getContext: () => context, getChatHandle,
    onSend: value => post(value), trigger, onPlan, onMemory };
  if (!options.absentEscalate) deps.onEscalate = escalate;
  const panel = keepPanel(mountLiaisonPanel(root, deps));
  return { root, trigger, conversation, controller, panel, post, escalate, onPlan, onMemory, getChatHandle, handle, emit,
    setContext: (value: LiaisonInput) => { context = value; panel.refresh(); },
    destroyHandle: () => { dead = true; }, draft: () => draft };
}

describe("U93 panel: context binding and explicit human authority", () => {
  it("A8 injected selected context resolves exactly its S1 handle and keeps all conversations distinct", () => {
    const f = panelFixture();
    expect(f.getChatHandle).toHaveBeenCalledWith(expect.objectContaining({ room: "demo", task_id: "T01" }));
    expect(text(f.root)).toContain(input().human.text); expect(text(f.root)).toContain(OUTPUT.text);
    expect(f.conversation.textContent).toBe("Existing executor conversation and delivery receipt");
    expect(f.root.contains(f.conversation)).toBe(false);
    expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
    expect(text(document.body)).not.toMatch(/\bRead\b/);
  });

  it("A8 absent handle visibly reports HOLD and cannot use a draft", () => {
    const f = panelFixture({ absentHandle: true });
    expect(text(f.root)).toMatch(/HOLD/);
    expect(control(f.root, /^Use draft$/i).disabled).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([[/^Draft$/i, "draft"], [/^Summary$/i, "summary"], [/^Clarify$/i, "clarify"]] as const)
    ("A7 %s invokes only local liaison generation", async (label, kind) => {
      const f = panelFixture(); control(f.root, label).click(); await flush();
      expect(f.controller.generate).toHaveBeenCalledTimes(1);
      expect(f.controller.generate).toHaveBeenCalledWith(expect.objectContaining(input()), kind);
      expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
    });

  it("A7 Use draft alone replaces the existing composer and never posts", () => {
    const f = panelFixture(); control(f.root, /^Use draft$/i).click();
    expect(f.handle.setDraft).toHaveBeenCalledExactlyOnceWith(OUTPUT.text);
    expect(f.draft()).toBe(OUTPUT.text); expect(f.post).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
  });

  it("A7 explicit Send delegates once to the selected task without inventing a receipt", () => {
    const f = panelFixture(); control(f.root, /^Send$/i).click();
    expect(f.handle.getDraft).toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", task_id: "T01", text: "Existing executor composer" });
    expect(f.escalate).not.toHaveBeenCalled(); expect(text(f.root)).not.toMatch(/\bRead\b/);
    expect(f.conversation.textContent).toContain("delivery receipt");
  });

  it("A7 explicit Escalate calls only the injected scoped callback", () => {
    const f = panelFixture(); expect(f.escalate).not.toHaveBeenCalled();
    control(f.root, /^Escalate$/i).click();
    expect(f.escalate).toHaveBeenCalledExactlyOnceWith({ room: "demo", task_id: "T01", text: expect.any(String) });
    expect(f.post).not.toHaveBeenCalled();
  });

  it("A7 Escalate without a host callback stays disabled", () => {
    const f = panelFixture({ absentEscalate: true }); const button = control(f.root, /^Escalate$/i);
    expect(button.disabled).toBe(true); button.click(); expect(f.post).not.toHaveBeenCalled();
  });

  it("A7 provider swaps, fallback rendering, timers and teardown never post or mutate the composer", async () => {
    const f = panelFixture();
    f.controller.setBinding("demo", { providerId: "replacement-provider", generation: 2 });
    f.emit({ state: "degraded", reason: "Deterministic Rules fallback", result: successful({ source: "rules", fallback: true, reason: "Providers offline" }, input().human.text) });
    await vi.advanceTimersByTimeAsync(120000); f.panel.destroy();
    expect(f.post).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled(); expect(f.handle.setDraft).not.toHaveBeenCalled();
    expect(f.controller.destroy).toHaveBeenCalled();
  });

  it.each(["empty", "degraded", "error"] as const)("A5 %s liaison retains direct Send, Plan and Memory access", state => {
    const f = panelFixture({ snapshot: { state, reason: "Liaison unavailable" },
      result: { ok: false, code: "BLOCKED", reason: "Host policy blocked liaison" } });
    for (const label of [/^Send$/i, /^Plan$/i, /^Memory$/i]) {
      const button = control(f.root, label); expect(button.disabled).toBe(false); button.click();
    }
    expect(f.post).toHaveBeenCalledTimes(1); expect(f.onPlan).toHaveBeenCalledTimes(1); expect(f.onMemory).toHaveBeenCalledTimes(1);
  });

  it("A7 changing selection rebinds the handle and explicit Send to the newly selected task", () => {
    const f = panelFixture(); f.setContext(input({ room: "other", task_id: "T02", tier: "private" }));
    control(f.root, /^Send$/i).click();
    expect(f.getChatHandle).toHaveBeenLastCalledWith(expect.objectContaining({ room: "other", task_id: "T02" }));
    expect(f.post).toHaveBeenCalledExactlyOnceWith({ room: "other", task_id: "T02", text: "Existing executor composer" });
  });

  it("A7 consuming an already-destroyed S1 handle remains inert", () => {
    const f = panelFixture(); f.destroyHandle();
    control(f.root, /^Use draft$/i).click(); control(f.root, /^Send$/i).click();
    expect(f.handle.getDraft()).toBe(""); expect(f.post).not.toHaveBeenCalled();
  });
});

describe("U93 panel: attribution, closed-output errors and literal rendering", () => {
  it.each([
    ["ON_DEVICE", "On device"], ["IN_CLOUD", "Cloud"], ["LOCAL_SERVER", "Local model"],
    ["REMOTE_PROVIDER", "Network model"], ["rules", "Rules"],
  ] as const)("A4 trusted source %s displays %s", (source, chip) => {
    const f = panelFixture({ result: successful({ source, fallback: source === "rules", reason: "Fallback explanation" }) });
    expect(text(f.root)).toContain(chip); expect(text(f.root)).toContain("answering-provider");
    expect(text(f.root)).toContain("Reported model"); expect(text(f.root)).toContain("Admitted by standard room policy");
    if (source === "rules") expect(text(f.root)).toContain("Fallback explanation");
    if (source === "LOCAL_SERVER" || source === "REMOTE_PROVIDER") {
      expect(f.root.querySelector(`.source[data-source="${source === "LOCAL_SERVER" ? "local" : "remote"}"]`)).not.toBeNull();
    }
  });

  it("A4 remote-to-Firebase fallback displays Cloud and trusted Firebase metadata", () => {
    const f = panelFixture({ result: successful({ providerId: "firebase-hybrid", modelLabel: "Reported Firebase model", source: "IN_CLOUD",
      fallback: true, reason: "Remote unavailable; Firebase answered" }) });
    for (const value of ["Cloud", "firebase-hybrid", "Reported Firebase model", "Remote unavailable; Firebase answered"]) expect(text(f.root)).toContain(value);
    expect(text(f.root)).not.toContain("remote-test");
  });

  it("A4 absent actual model metadata is AUSENTE and never guessed from the selection", () => {
    const result = successful(); if (!result.ok) throw new Error("Fixture must succeed"); delete result.attribution.modelLabel;
    const f = panelFixture({ result });
    expect(text(f.root)).toContain("AUSENTE"); expect(text(f.root)).not.toContain("reported-remote-model");
    expect(text(f.root)).not.toContain("undefined");
  });

  it("A4 model-authored provider claims stay draft text, independent of the source chip", () => {
    const f = panelFixture({ result: successful({ source: "ON_DEVICE", providerId: "firebase-ondevice" }, "I claim I am a cloud provider") });
    expect(text(f.root)).toContain("On device"); expect(text(f.root)).toContain("firebase-ondevice");
    expect(text(f.root)).toContain("I claim I am a cloud provider");
  });

  it("A6 SCHEMA_REJECT shows its reason and cannot mutate or send the rejected draft", () => {
    const f = panelFixture({ snapshot: { state: "error", reason: "Extra operation key rejected" },
      result: { ok: false, code: "SCHEMA_REJECT", reason: "Extra operation key rejected" } });
    expect(text(f.root)).toContain("Extra operation key rejected");
    expect(control(f.root, /^Use draft$/i).disabled).toBe(true);
    expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });

  it("A5 PERSIST_FAILED is visible and leaves direct composer and delivery untouched", () => {
    const f = panelFixture({ snapshot: { state: "error", reason: "Storage unavailable" },
      result: { ok: false, code: "PERSIST_FAILED", reason: "Storage unavailable" } });
    expect(text(f.root)).toContain("Storage unavailable"); expect(f.draft()).toBe("Existing executor composer");
    expect(f.handle.setDraft).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });

  it("A6 hostile human, generated, rules, projection, history and metadata text stays literal", () => {
    const context = input({ human: { id: "human-1", text: HOSTILE }, rules: HOSTILE,
      projection: { title: HOSTILE }, history: [{ id: "event-1", text: HOSTILE }] });
    const f = panelFixture({ context, result: successful({ modelLabel: HOSTILE, reason: HOSTILE, admission: HOSTILE }, HOSTILE) });
    expect(text(f.root)).toContain(HOSTILE);
    expect(f.root.querySelector("img,script,iframe,svg,[onerror],[onclick]")).toBeNull();
    expect(f.post).not.toHaveBeenCalled(); expect(f.handle.setDraft).not.toHaveBeenCalled();
  });
});

describe("U93 panel: local lifecycle and accessibility", () => {
  it.each(["empty", "starting", "ready", "degraded", "paused", "error"] as const)
    ("A7 exposes textual %s with its reason without altering executor conversation", state => {
      const f = panelFixture({ snapshot: { state, reason: `Liaison reason: ${state}` } });
      expect(text(f.root).toLowerCase()).toContain(state); expect(text(f.root)).toContain(`Liaison reason: ${state}`);
      expect(f.conversation.textContent).toBe("Existing executor conversation and delivery receipt");
      expect(f.post).not.toHaveBeenCalled();
      if (state === "paused") expect(text(f.root)).not.toMatch(/executor (?:is )?(?:stopped|paused)/i);
    });

  it("A7 controls are keyboard-focusable buttons and Pause is local only", () => {
    const f = panelFixture();
    for (const label of [/^Draft$/i, /^Summary$/i, /^Clarify$/i, /^Use draft$/i, /^Send$/i, /^Pause$/i, /^Close$/i]) {
      const button = control(f.root, label); expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      if (!button.disabled) { button.focus(); expect(document.activeElement).toBe(button); }
    }
    control(f.root, /^Pause$/i).click(); expect(f.controller.pause).toHaveBeenCalledTimes(1);
    expect(f.post).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
  });

  it.each(["Escape", "Close"])("A7 %s restores focus to the panel trigger", action => {
    const f = panelFixture(); control(f.root, /^Draft$/i).focus();
    if (action === "Escape") f.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    else control(f.root, /^Close$/i).click();
    expect(document.activeElement).toBe(f.trigger); expect(f.post).not.toHaveBeenCalled();
  });

  it("A7 pagehide suspends the local controller without sending", () => {
    const f = panelFixture(); window.dispatchEvent(new Event("pagehide"));
    expect(f.controller.destroy).toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });

  it("A7 reduced-motion mode adds no animated inference UI or automatic send", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query,
      onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    const f = panelFixture({ snapshot: { state: "starting", reason: "Waiting for a liaison response" } });
    const stylesheet = document.createElement("style");
    stylesheet.textContent = readFileSync(`${process.cwd()}/styles/model_selector.css`, "utf8") /* A-U93a: jsdom import.meta.url is not file: */;
    document.head.append(stylesheet);
    const reduced = document.createElement("style");
    reduced.textContent = [...(stylesheet.sheet?.cssRules ?? [])].filter(rule => rule instanceof CSSMediaRule
      && rule.conditionText.includes("prefers-reduced-motion")).map(rule => [...(rule as CSSMediaRule).cssRules].map(r => r.cssText).join("\n")).join("\n");
    document.head.append(reduced);
    try {
      for (const element of [f.root, ...f.root.querySelectorAll<HTMLElement>("*")]) {
        const style = getComputedStyle(element);
        for (const duration of [style.animationDuration, style.transitionDuration, style.animation, style.transition]) {
          expect([...duration.matchAll(/([\d.]+)(m?s)\b/g)].every(match => Number(match[1]) === 0)).toBe(true);
        }
      }
      await vi.advanceTimersByTimeAsync(120000); expect(f.post).not.toHaveBeenCalled();
    } finally {
      stylesheet.remove(); reduced.remove();
    }
  });

  it("A7 integrated pagehide aborts the request and suppresses fallback and late render", async () => {
    const f = fakeDeps(); const reply = deferred<Awaited<ReturnType<typeof f.generate>>>(); f.generate.mockReturnValue(reply.promise);
    const controller = boot(f); const root = document.createElement("section"); const trigger = document.createElement("button");
    document.body.append(trigger, root); const post = vi.fn(); const setDraft = vi.fn();
    keepPanel(mountLiaisonPanel(root, { controller, getContext: () => input(), trigger,
      getChatHandle: () => ({ setDraft, getDraft: () => "Original composer" }), onSend: post, onPlan: vi.fn(), onMemory: vi.fn() }));
    control(root, /^Draft$/i).click(); await flush();
    expect(f.generate).toHaveBeenCalledTimes(1); const signal = f.generate.mock.calls[0]![0].signal;
    window.dispatchEvent(new Event("pagehide")); expect(signal.aborted).toBe(true);
    reply.resolve(answer({ text: JSON.stringify({ ...OUTPUT, text: "Late forbidden output" }) })); await flush();
    expect(text(root)).not.toContain("Late forbidden output"); expect(post).not.toHaveBeenCalled(); expect(setDraft).not.toHaveBeenCalled();
  });
});
