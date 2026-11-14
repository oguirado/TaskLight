import { describe, it, expect, afterEach, vi } from "vitest";
import { createAnnouncer } from "../../../src/ui/announcer";
import { createOnboarding } from "../../../src/ui/onboarding";
import { createWallUi } from "../../../src/ui/shell";
import { resolveWallMode } from "../../../src/ui/state";
import { withReducedMotion } from "../../../src/ui/caps";
import { capsuleTemplate } from "../../../src/ui/badges";
import { createRenderer } from "../../../src/render";
import type { FrameCaps } from "../../../src/render/types";
import { D, card, FakeClock, FakeMotion, makeHarness, click, slot, trustPredicate } from "./helpers";

// Repair loop 1 regression tests (REVIEW_1 BLOCKING findings per DISP_03; see ORACLE.md "Repair loop 1").
afterEach(() => { vi.restoreAllMocks(); document.documentElement.classList.remove("ui-reduced-motion"); });
const txt = (e: Element | null) => e?.textContent ?? "";
const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

/** Collects unhandled rejections and window errors during `fn`, shielding the vitest runner from them. */
async function captureFailures(fn: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const onRej = (r: unknown) => { seen.push(r); };
  const onErr = (e: ErrorEvent) => { seen.push(e.error ?? e.message); e.preventDefault(); };
  process.on("unhandledRejection", onRej);
  window.addEventListener("error", onErr);
  try { fn(); await tick(); await tick(); } finally {
    window.removeEventListener("error", onErr);
    process.removeAllListeners("unhandledRejection");
    saved.forEach((l) => process.on("unhandledRejection", l as (...a: unknown[]) => void));
  }
  return seen;
}

/** Plain (non-vi.fn) port: vitest mocks attach handlers to returned promises and would mask unhandled rejections. */
const plain = (fn: () => Promise<void>) => { const d = { calls: 0, activate: (_t: boolean): Promise<void> => { d.calls++; return fn(); } }; return d; };

describe("R1-1 injected DevicePort failure on CTA click (DISP_03 #3/#4)", () => {
  const mk = () => { document.body.replaceChildren(); const panel = document.createElement("div"); document.body.appendChild(panel); return panel; };
  it("rejected activate() promise is consumed (no unhandled rejection)", async () => {
    const panel = mk();
    const device = plain(() => Promise.reject(new Error("download failed")));
    createOnboarding(panel, device, { isTrusted: trustPredicate });
    const cta = panel.querySelector('[data-role="enable-cta"]')!;
    const seen = await captureFailures(() => click(cta, true));
    expect(device.calls).toBe(1);
    expect(seen).toEqual([]);
  });
  it("synchronously throwing activate() does not escape the event handler", async () => {
    const panel = mk();
    const device = { activate: vi.fn((): Promise<void> => { throw new Error("sync boom"); }) };
    createOnboarding(panel, device, { isTrusted: trustPredicate });
    const cta = panel.querySelector('[data-role="enable-cta"]')!;
    const seen = await captureFailures(() => click(cta, true));
    expect(device.activate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });
  it("same through the shell CTA", async () => {
    const h = makeHarness(); createWallUi(h.opts);
    // vi.fn records returned promises (observing the rejection), so install a plain function.
    let calls = 0;
    (h.opts.device as { activate: (t: boolean) => Promise<void> }).activate = () => { calls++; return Promise.reject(new Error("download failed")); };
    const seen = await captureFailures(() => click(h.cta()!, true));
    expect(calls).toBe(1);
    expect(seen).toEqual([]);
  });
  it("double trusted click still activates once", async () => {
    const panel = mk();
    const device = plain(() => Promise.reject(new Error("x")));
    createOnboarding(panel, device, { isTrusted: trustPredicate });
    const cta = panel.querySelector('[data-role="enable-cta"]')!;
    await captureFailures(() => { click(cta, true); click(cta, true); });
    expect(device.calls).toBe(1);
  });
});

describe("R1-2 announcer: latest text wins per key (B14)", () => {
  it("A flushed, then B, then A on the same key: obsolete B is never announced", () => {
    const clock = new FakeClock(); const region = document.createElement("div");
    const a = createAnnouncer(region, clock);
    a.say("p", "A", "polite"); expect(region.textContent).toBe("A");
    clock.advance(1000);
    a.say("p", "B", "polite");
    a.say("p", "A", "polite");
    clock.advance(20000);
    expect(region.textContent).toBe("A");
    expect(a.flushedCount()).toBe(1);
  });
  it("A, then B (queued), then C on the same key: C wins", () => {
    const clock = new FakeClock(); const region = document.createElement("div");
    const a = createAnnouncer(region, clock);
    a.say("p", "A", "polite"); clock.advance(1000);
    a.say("p", "B", "polite"); a.say("p", "C", "polite");
    clock.advance(20000);
    expect(region.textContent).toBe("C"); expect(a.flushedCount()).toBe(2);
  });
});

describe("R1-3 announcer: identical consecutive text suppressed across keys (B14)", () => {
  it("B queued under two keys is announced once", () => {
    const clock = new FakeClock(); const region = document.createElement("div");
    const a = createAnnouncer(region, clock);
    a.say("p0", "A", "polite"); clock.advance(1000);
    a.say("p1", "B", "polite"); a.say("p2", "B", "polite");
    clock.advance(30000);
    expect(region.textContent).toBe("B");
    expect(a.flushedCount()).toBe(2);
  });
  it("a suppressed duplicate does not delay the next distinct text", () => {
    const clock = new FakeClock(); const region = document.createElement("div");
    const a = createAnnouncer(region, clock);
    a.say("p0", "A", "polite"); clock.advance(1000);
    a.say("p1", "B", "polite"); a.say("p2", "B", "polite"); a.say("p3", "C", "polite");
    clock.advance(5000 - 1000); // B flushes at t=5000
    expect(region.textContent).toBe("B");
    clock.advance(5000); // dup B must be skipped without eating the slot: C at t=10000
    expect(region.textContent).toBe("C");
    expect(a.flushedCount()).toBe(3);
  });
});

describe("R1-4 progressPct only in downloading mode (B2)", () => {
  const dl = { state: "downloading", progress: 0.5 } as const;
  it.each([
    ["offline", { online: false }],
    ["booting", { host: { kind: "booting" } }],
    ["blocked", { host: { kind: "blocked", reason: "APPCHECK_FAILED" } }],
    ["kill_switch", { killSwitchCloud: true }],
  ] as const)("%s with device downloading -> progressPct null", (mode, over) => {
    const v = resolveWallMode(D({ device: dl, ...(over as object) }));
    expect(v.mode).toBe(mode);
    expect(v.progressPct).toBeNull();
  });
  it("control: downloading mode reports the percentage", () => {
    const v = resolveWallMode(D({ device: dl }));
    expect(v.mode).toBe("downloading"); expect(v.progressPct).toBe(50);
  });
  it("shell: offline while downloading shows no progress bar", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.update(D({ online: false, device: dl }));
    const bar = h.root.querySelector('[role="progressbar"]');
    expect(bar === null || bar.closest("[hidden], .is-hidden") !== null).toBe(true);
  });
});

describe("R1-5 private capsules never show cloud badges (B4)", () => {
  it("device ready + private card with source IN_CLOUD: no Cloud badge", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.update(D());
    ui.setCapsules([card("p1", { tier: "private", source: "IN_CLOUD" })]);
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).not.toMatch(/Cloud/);
    expect(txt(h.nodes.get("p1")!)).not.toMatch(/Cloud/);
  });
  it("ready -> downloading without setCapsules: existing private card flips to 'Private: unavailable'", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.update(D());
    ui.setCapsules([card("p1", { tier: "private", source: "ON_DEVICE" })]);
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toContain("On device");
    ui.update(D({ device: { state: "downloading", progress: 0.2 }, availability: "downloading" }));
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toContain("Private: unavailable");
    expect(txt(h.nodes.get("p1")!)).not.toMatch(/Cloud/);
  });
  it("downloading -> ready without setCapsules: badge recovers to 'On device'", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.update(D({ device: { state: "downloading", progress: 0.2 } }));
    ui.setCapsules([card("p1", { tier: "private", source: "ON_DEVICE" })]);
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toContain("Private: unavailable");
    ui.update(D());
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toContain("On device");
  });
  it("non-private cards keep their cloud badge (control)", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.update(D());
    ui.setCapsules([card("p1", { source: "IN_CLOUD" })]);
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toMatch(/Cloud/);
  });
});

describe("R1-6 stale patch yields is-stale and data-stale via capsuleTemplate (B10)", () => {
  function setup() {
    const container = document.createElement("div"); document.body.appendChild(container);
    const queue: Array<() => void> = [];
    const caps: FrameCaps = { maxPatchesThisFrame: () => 8, frameJsBudgetMs: () => 4, effectsEnabled: () => true, beginFrame() {}, endFrame() {} };
    const { template, allowlist } = capsuleTemplate();
    const r = createRenderer({ container, template, allowlist, poolCapacity: 4, caps,
      scheduler: { request: (cb: () => void) => { queue.push(cb); } }, clock: { nowUs: () => 0 } });
    const flush = () => { const q = queue.splice(0); q.forEach((c) => c()); };
    return { container, r, flush };
  }
  it("stale=true sets class is-stale and attribute data-stale=true; stale=false clears both", () => {
    const { container, r, flush } = setup();
    expect(r.mount("p1").ok).toBe(true);
    r.enqueue({ projectId: "p1", rev: 1, field: "stale", value: true }); flush();
    expect(container.querySelector(".is-stale")).not.toBeNull();
    expect(container.querySelector('[data-stale="true"]')).not.toBeNull();
    r.enqueue({ projectId: "p1", rev: 2, field: "stale", value: false }); flush();
    expect(container.querySelector(".is-stale")).toBeNull();
    expect(container.querySelector("[data-stale]")).toBeNull();
  });
});

describe("R1-7 reduced-motion subscription cleanup (DISP_03 #4)", () => {
  const inner = (): FrameCaps => ({ maxPatchesThisFrame: () => 1, frameJsBudgetMs: () => 1, effectsEnabled: () => true, beginFrame() {}, endFrame() {} });
  const cleanupOf = (c: object): (() => void) | undefined => {
    const o = c as Record<string, unknown>;
    for (const k of ["dispose", "destroy", "close", "unsubscribe", "cleanup", "off", "detach"]) if (typeof o[k] === "function") return (o[k] as () => void).bind(c);
    return undefined;
  };
  it("withReducedMotion exposes a cleanup that removes its MotionPort listener", () => {
    const m = new FakeMotion(false);
    const c = withReducedMotion(inner(), m);
    expect(m.listeners).toBe(1);
    const cleanup = cleanupOf(c);
    expect(cleanup).toBeDefined();
    cleanup!();
    expect(m.listeners).toBe(0);
  });
  it("repeated wrap + cleanup on a persistent MotionPort does not accumulate listeners", () => {
    const m = new FakeMotion(false);
    for (let i = 0; i < 5; i++) { const c = withReducedMotion(inner(), m); cleanupOf(c)?.(); }
    expect(m.listeners).toBe(0);
  });
  it("after cleanup, motion changes no longer touch the document root class", () => {
    const m = new FakeMotion(false);
    const c = withReducedMotion(inner(), m);
    cleanupOf(c)?.();
    m.set(true);
    expect(document.documentElement.classList.contains("ui-reduced-motion")).toBe(false);
  });
  it("shell dispose releases motion and theme listeners", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.dispose();
    expect((h.motion as FakeMotion).listeners).toBe(0);
    expect(h.theme.listeners).toBe(0);
  });
});
