import { describe, it, expect, vi, afterEach } from "vitest";
import { createWallUi } from "../../../src/ui/shell";
import { BANNER_TEXT } from "../../../src/ui/state";
import { getLens } from "../../../src/lens";
import type { WallMode } from "../../../src/ui/types";
import { D, card, ids, makeHarness, click, key, slot, isHidden, type Harness } from "./helpers";

afterEach(() => { vi.restoreAllMocks(); });
const boot = (init?: Parameters<typeof makeHarness>[0]) => { const h = makeHarness(init); const ui = createWallUi(h.opts); return { h, ui }; };
const txt = (e: Element | null) => e?.textContent ?? "";
const visibleCards = (h: Harness) => [...h.nodes.entries()].filter(([, n]) => !isHidden(n)).map(([id]) => id);

describe("U20 states: banner + badge per mode (B8, B11, section 4)", () => {
  const CASES: [WallMode, Parameters<typeof D>[0]][] = [
    ["booting", { host: { kind: "booting" } }],
    ["offline", { online: false }],
    ["kill_switch", { killSwitchCloud: true }],
    ["no_model", { device: { state: "not_initialised" }, availability: "unavailable" }],
    ["needs_gesture", { device: { state: "needs_gesture" }, availability: "downloadable" }],
    ["downloading", { device: { state: "downloading", progress: 0.4 }, availability: "downloading" }],
    ["cloud_fallback", { lastRun: { source: "IN_CLOUD", fallback: true } }],
    ["on_device", { lastRun: { source: "ON_DEVICE", fallback: false } }],
  ];
  it.each(CASES)("%s", (mode, over) => {
    const { h, ui } = boot();
    expect(ui.update(D(over)).mode).toBe(mode);
    expect(h.banner()!.getAttribute("data-mode")).toBe(mode);
    expect(txt(h.banner())).toContain(BANNER_TEXT[mode]);
    expect(BANNER_TEXT[mode].length).toBeGreaterThan(0);
    expect(h.badge()!.getAttribute("data-mode")).toBe(mode);
    expect(txt(h.badge()).trim().length).toBeGreaterThan(0);
  });
  it("global badge texts for on_device and cloud_fallback (B11)", () => {
    const { h, ui } = boot();
    ui.update(D()); expect(txt(h.badge())).toContain("On device");
    ui.update(D({ lastRun: { source: "IN_CLOUD", fallback: true } })); expect(txt(h.badge())).toContain("Cloud fallback");
  });
  it("kill_switch banner says cloud disabled; CTA still shown if model not ready", () => {
    const { h, ui } = boot();
    ui.update(D({ killSwitchCloud: true, device: { state: "needs_gesture" }, availability: "downloadable" }));
    expect(txt(h.banner())).toMatch(/cloud disabled/i);
    expect(isHidden(h.cta())).toBe(false);
  });
  it("no_model + unavailable banner/panel explains the hardware minimum; CTA hidden", () => {
    const { h, ui } = boot();
    ui.update(D({ device: { state: "not_initialised" }, availability: "unavailable" }));
    expect(h.root.textContent).toMatch(/16\s*GB/); expect(h.root.textContent).toMatch(/22\s*GB/);
    expect(isHidden(h.cta())).toBe(true);
  });
  it("blocked: reason verbatim in banner, CTA hidden", () => {
    const { h, ui } = boot();
    ui.update(D({ host: { kind: "blocked", reason: "APPCHECK_FAILED" }, device: { state: "needs_gesture" } }));
    expect(txt(h.banner())).toContain("APPCHECK_FAILED"); expect(isHidden(h.cta())).toBe(true);
  });
  it("device failed: detail not shown verbatim", () => {
    const { h, ui } = boot();
    ui.update(D({ device: { state: "failed", detail: "SECRET_DETAIL_XYZ" } }));
    expect(h.root.textContent).not.toContain("SECRET_DETAIL_XYZ");
    expect(h.banner()!.getAttribute("data-mode")).toBe("no_model");
  });
  it("U11 template_invalid -> static alert panel with the code", () => {
    const { h, ui } = boot(); ui.reportRenderError("template_invalid");
    const p = h.root.querySelector('[role="alert"][data-role="template-error"]');
    expect(p).not.toBeNull(); expect(txt(p)).toContain("template_invalid");
  });
});

describe("U20 onboarding through the shell (O2, O3, B7)", () => {
  it("A3 without opts.isTrusted the default ev.isTrusted applies: synthetic click -> 0 activations", () => {
    const h = makeHarness(); const { isTrusted: _omit, ...opts } = h.opts; const ui = createWallUi(opts);
    ui.update(D({ device: { state: "needs_gesture" }, availability: "downloadable" }));
    click(h.cta()!, true); h.cta()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(h.device.activate).not.toHaveBeenCalled();
  });
  const NG = D({ device: { state: "needs_gesture" }, availability: "downloadable" });
  it("initializeDeviceModel path: activate only after explicit trusted click, once", () => {
    const { h, ui } = boot(); ui.update(NG); ui.update(NG); h.clock.advance(60000);
    expect(h.device.activate).not.toHaveBeenCalled();
    click(h.cta()!, false); expect(h.device.activate).not.toHaveBeenCalled();
    click(h.cta()!, true); click(h.cta()!, true); expect(h.device.activate).toHaveBeenCalledTimes(1);
    expect(h.device.activate).toHaveBeenCalledWith(true);
  });
  it("O3 aria-valuenow 12 / 100 / 0; progressbar gone after ready", () => {
    const { h, ui } = boot();
    const dl = (p: number) => D({ device: { state: "downloading", progress: p }, availability: "downloading" });
    const now = () => h.root.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow");
    expect(ui.update(dl(0.1234)).progressPct).toBe(12); expect(now()).toBe("12");
    ui.update(dl(1.5)); expect(now()).toBe("100");
    ui.update(dl(Number.NaN)); expect(now()).toBe("0");
    expect(ui.update(D()).progressPct).toBeNull();
    expect(isHidden(h.root.querySelector('[role="progressbar"]'))).toBe(true);
  });
  it("B7 progress announced politely only on crossing each 25% boundary", () => {
    const { h, ui } = boot();
    const dl = (p: number) => D({ device: { state: "downloading", progress: p }, availability: "downloading" });
    ui.update(dl(0.1)); h.clock.advance(6000);
    const base = txt(h.live());
    for (const p of [0.15, 0.2, 0.24]) { ui.update(dl(p)); h.clock.advance(6000); expect(txt(h.live())).toBe(base); }
    ui.update(dl(0.26)); h.clock.advance(6000);
    expect(txt(h.live())).toContain("25"); expect(h.live()!.getAttribute("aria-live")).toBe("polite");
    ui.update(dl(0.3)); h.clock.advance(6000); expect(txt(h.live())).toContain("25");
    ui.update(dl(0.5)); h.clock.advance(6000); expect(txt(h.live())).toContain("50");
  });
});

describe("U20 O5/O11 live announcements (B14, B15)", () => {
  it("one live region only", () => { const { h } = boot(); expect(h.root.querySelectorAll("[aria-live]")).toHaveLength(1); });
  it("O5 kill_switch then offline: banner changes, assertive each", () => {
    const { h, ui } = boot(); ui.update(D()); h.clock.advance(6000);
    ui.update(D({ killSwitchCloud: true }));
    const b1 = txt(h.banner()); expect(b1).toContain(BANNER_TEXT.kill_switch);
    expect(h.live()!.getAttribute("aria-live")).toBe("assertive"); expect(txt(h.live()).length).toBeGreaterThan(0);
    const l1 = txt(h.live()); h.clock.advance(6000);
    ui.update(D({ killSwitchCloud: true, online: false }));
    expect(txt(h.banner())).not.toBe(b1); expect(txt(h.banner())).toContain(BANNER_TEXT.offline);
    expect(h.live()!.getAttribute("aria-live")).toBe("assertive"); expect(txt(h.live())).not.toBe(l1);
  });
  it("entering blocked is assertive", () => {
    const { h, ui } = boot(); ui.update(D()); h.clock.advance(6000);
    ui.update(D({ host: { kind: "blocked", reason: "X1" } }));
    expect(h.live()!.getAttribute("aria-live")).toBe("assertive");
  });
  it("O11 attention low -> polite; attention now -> assertive; status blocked -> assertive", () => {
    const { h, ui } = boot(); ui.update(D()); ui.setCapsules([card("p1")]); h.clock.advance(6000);
    ui.setCapsules([card("p1", { attention: "low" })]); h.clock.advance(6000);
    expect(h.live()!.getAttribute("aria-live")).toBe("polite"); expect(txt(h.live()).length).toBeGreaterThan(0);
    ui.setCapsules([card("p1", { attention: "now" })]); h.clock.advance(6000);
    expect(h.live()!.getAttribute("aria-live")).toBe("assertive");
    ui.setCapsules([card("p1", { attention: "now", status: "idle" })]); h.clock.advance(6000);
    ui.setCapsules([card("p1", { attention: "low", status: "blocked" })]); h.clock.advance(6000);
    expect(h.live()!.getAttribute("aria-live")).toBe("assertive");
  });
  it("many capsule changes inside 1 s produce <=1 announcement", () => {
    const { h, ui } = boot(); ui.update(D()); h.clock.advance(6000);
    const before = txt(h.live()); const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ui.setCapsules(ids(3).map((id) => card(id, { attention: i % 2 ? "low" : "high" })));
      h.clock.advance(100); seen.add(txt(h.live()));
    }
    seen.delete(before); expect(seen.size).toBeLessThanOrEqual(1);
  });
});

describe("U20 capsule badges (O6, O7, B4, B11)", () => {
  it("O6 fallback: mode cloud_fallback; IN_CLOUD card -> data-source via renderer + visible badge text", () => {
    const { h, ui } = boot();
    expect(ui.update(D({ lastRun: { source: "IN_CLOUD", fallback: true } })).mode).toBe("cloud_fallback");
    ui.setCapsules([card("p1", { source: "IN_CLOUD" }), card("p2", { source: "ON_DEVICE" })]);
    expect(h.patches.some((p) => p.projectId === "p1" && p.field === "inference_source" && p.value === "IN_CLOUD")).toBe(true);
    expect(h.patches.some((p) => p.projectId === "p2" && p.field === "inference_source" && p.value === "ON_DEVICE")).toBe(true);
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toMatch(/Cloud/);
    expect(txt(slot(h.nodes.get("p2")!, "badge"))).toContain("On device");
  });
  it("O7 private capsule while device downloading: 'Private: unavailable', never a Cloud badge", () => {
    const { h, ui } = boot();
    ui.update(D({ device: { state: "downloading", progress: 0.3 }, availability: "downloading" }));
    ui.setCapsules([card("p1", { tier: "private", source: "IN_CLOUD" })]);
    const t = txt(h.nodes.get("p1")!); expect(t).toContain("Private: unavailable"); expect(t).not.toMatch(/Cloud/);
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toContain("Private: unavailable");
  });
  it("private capsule becomes normal once device is ready", () => {
    const { h, ui } = boot();
    ui.update(D({ device: { state: "downloading", progress: 0.3 } }));
    ui.setCapsules([card("p1", { tier: "private", source: "ON_DEVICE" })]);
    ui.update(D()); ui.setCapsules([card("p1", { tier: "private", source: "ON_DEVICE" })]);
    expect(txt(h.nodes.get("p1")!)).not.toContain("Private: unavailable");
    expect(txt(slot(h.nodes.get("p1")!, "badge"))).toContain("On device");
  });
  it("stale card shows visible 'Stale' text and patches stale=true", () => {
    const { h, ui } = boot(); ui.update(D());
    ui.setCapsules([card("p1", { stale: true })]);
    expect(txt(slot(h.nodes.get("p1")!, "stale_badge"))).toContain("Stale");
    expect(h.patches.some((p) => p.projectId === "p1" && p.field === "stale" && p.value === true)).toBe(true);
  });
  it("status/attention reach the renderer, not the DOM directly", () => {
    const { h, ui } = boot(); ui.update(D());
    ui.setCapsules([card("p1", { status: "blocked", attention: "now" })]);
    expect(h.patches.some((p) => p.field === "status" && p.value === "blocked")).toBe(true);
    expect(h.patches.some((p) => p.field === "attention" && p.value === "now")).toBe(true);
    const revs = h.patches.filter((p) => p.projectId === "p1").map((p) => p.rev);
    expect(revs.every((r) => Number.isInteger(r) && r >= 0)).toBe(true);
  });
});

describe("U20 lens switcher (AMEND_C B33, A13)", () => {
  const seed = (ui: ReturnType<typeof boot>["ui"]) => ui.setCapsules([
    ...ids(5, "d").map((id) => card(id)),
    ...ids(3, "s").map((id) => card(id, { lens_id: "study", status: "reading" as never })),
  ]);
  it("switcher buttons per lens + all, aria-pressed on the active one", () => {
    const { h } = boot();
    const sw = h.root.querySelector('[data-region="lens-switcher"]')!;
    const btns = [...sw.querySelectorAll("button[data-lens]")] as HTMLElement[];
    expect(btns.map((b) => b.getAttribute("data-lens")).sort()).toEqual(["all", "dev", "study"]);
    expect(txt(btns.find((b) => b.dataset.lens === "dev")!)).toContain(getLens("dev")!.label);
    expect(txt(btns.find((b) => b.dataset.lens === "study")!)).toContain(getLens("study")!.label);
    expect(btns.find((b) => b.dataset.lens === "all")!.getAttribute("aria-pressed")).toBe("true");
  });
  it("A13 filter study: 3 visible of 8; no remount; same wall container", () => {
    const { h, ui } = boot(); ui.update(D()); seed(ui);
    const wall = h.root.querySelector("[data-wall-container]"); const mounts = h.renderer.mount.mock.calls.length;
    expect(visibleCards(h)).toHaveLength(8);
    ui.setFilter("study");
    expect(visibleCards(h)).toEqual(["s1", "s2", "s3"]);
    expect(h.renderer.mount.mock.calls.length).toBe(mounts); expect(h.renderer.unmount).not.toHaveBeenCalled();
    expect(h.root.querySelector("[data-wall-container]")).toBe(wall); expect(ui.state().filter).toBe("study");
    ui.setFilter("all"); expect(visibleCards(h)).toHaveLength(8);
    ui.setFilter("dev"); expect(visibleCards(h)).toEqual(ids(5, "d"));
  });
  it("clicking a switcher button filters", () => {
    const { h, ui } = boot(); ui.update(D()); seed(ui);
    click(h.root.querySelector('button[data-lens="study"]')!, true);
    expect(visibleCards(h)).toHaveLength(3); expect(ui.state().filter).toBe("study");
    expect(h.root.querySelector('button[data-lens="study"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(h.root.querySelector('button[data-lens="all"]')!.getAttribute("aria-pressed")).toBe("false");
  });
  it("vocabulary swaps with the lens (status legend), wall not remounted", () => {
    const { h, ui } = boot(); ui.update(D());
    const legend = () => [...h.root.querySelectorAll('[data-role="status-legend"] [data-status]')].map((e) => e.getAttribute("data-status"));
    ui.setFilter("dev"); expect(legend()).toEqual([...getLens("dev")!.statuses]);
    ui.setFilter("study"); expect(legend()).toEqual([...getLens("study")!.statuses]);
    expect(legend()).toContain("reading"); expect(legend()).not.toContain("running");
    expect(h.renderer.mount).not.toHaveBeenCalled();
  });
  it("unknown lens_id is not rendered", () => {
    const { h, ui } = boot(); ui.update(D());
    ui.setCapsules([card("x1", { lens_id: "bogus" }), card("p1")]);
    expect(h.nodes.has("x1") ? isHidden(h.nodes.get("x1")!) : true).toBe(true);
    expect(visibleCards(h)).toEqual(["p1"]);
  });
  it("focus banner lists attention=now cards only; hidden when none", () => {
    const { h, ui } = boot(); ui.update(D());
    const fb = () => h.root.querySelector('[data-role="focus-banner"]');
    ui.setCapsules([card("p1", { attention: "now" }), card("p2", { attention: "now" }), card("p3", { attention: "low" })]);
    expect(isHidden(fb())).toBe(false); expect(txt(fb())).toContain("p1"); expect(txt(fb())).toContain("p2"); expect(txt(fb())).not.toContain("p3");
    ui.setCapsules([card("p1"), card("p2"), card("p3")]); expect(isHidden(fb())).toBe(true);
  });
});

describe("U20 plan/checklist rows (AMEND_C B34, A13)", () => {
  const steps = [{ text: "read", state: "done" }, { text: "write", state: "doing" }, { text: "test", state: "todo" }] as const;
  it("3 steps -> 3 rows shown, 2 hidden by class; createElement called 0 times", () => {
    const { h, ui } = boot(); ui.update(D()); ui.setCapsules([card("s1", { lens_id: "study" })]);
    const spy = vi.spyOn(document, "createElement"); const spyNs = vi.spyOn(document, "createElementNS");
    ui.setPlan("s1", steps); ui.setFilter("study");
    const n = h.nodes.get("s1")!;
    for (let i = 1; i <= 5; i++) {
      const r = slot(n, `step_${i}`);
      if (i <= 3) { expect(isHidden(r)).toBe(false); expect(r.textContent).toContain(steps[i - 1]!.text); expect(r.getAttribute("data-state")).toBe(steps[i - 1]!.state); }
      else { expect(r.classList.contains("is-hidden")).toBe(true); expect(r.textContent).toBe(""); }
    }
    expect(spy).not.toHaveBeenCalled(); expect(spyNs).not.toHaveBeenCalled();
  });
  it("shrinking the plan hides rows again; more than 5 steps are capped at 5", () => {
    const { h, ui } = boot(); ui.update(D()); ui.setCapsules([card("s1", { lens_id: "study" })]);
    ui.setPlan("s1", Array.from({ length: 9 }, (_, i) => ({ text: `s${i}`, state: "todo" as const })));
    const n = h.nodes.get("s1")!;
    expect([1, 2, 3, 4, 5].every((i) => !isHidden(slot(n, `step_${i}`)))).toBe(true);
    ui.setPlan("s1", [steps[0]]);
    expect(isHidden(slot(n, "step_1"))).toBe(false); expect([2, 3, 4, 5].every((i) => isHidden(slot(n, `step_${i}`)))).toBe(true);
  });
  it("hostile step text stays literal; unknown project is ignored without throwing", () => {
    const { h, ui } = boot(); ui.update(D()); ui.setCapsules([card("s1")]);
    ui.setPlan("s1", [{ text: "<img src=x onerror=alert(1)>", state: "todo" }]);
    expect(txt(slot(h.nodes.get("s1")!, "step_1"))).toBe("<img src=x onerror=alert(1)>");
    expect(h.root.querySelectorAll("img")).toHaveLength(0);
    expect(() => ui.setPlan("nope", [])).not.toThrow();
  });
  it("step state has visible text or label, not colour only", () => {
    const { h, ui } = boot(); ui.update(D()); ui.setCapsules([card("s1")]);
    ui.setPlan("s1", [{ text: "a", state: "done" }]);
    const r = slot(h.nodes.get("s1")!, "step_1"); expect(r.getAttribute("data-state")).toBe("done");
    expect(r.textContent!.length + (r.getAttribute("aria-label")?.length ?? 0)).toBeGreaterThan(1);
  });
});

describe("U20 template-editor entry (AMEND_C B35)", () => {
  const btn = (h: Harness) => h.root.querySelector('[data-action="open-template-editor"]') as HTMLElement | null;
  it("button opens U31 via callback only; enabled by default", () => {
    const { h, ui } = boot(); expect(ui.state().templateEditorEnabled).toBe(true);
    expect(btn(h)!.tagName).toBe("BUTTON");
    click(btn(h)!, true); expect(h.onOpenTemplateEditor).toHaveBeenCalledTimes(1);
    expect(h.renderer.enqueue).not.toHaveBeenCalled(); expect(h.renderer.mount).not.toHaveBeenCalled();
  });
  it("hidden and not tabbable when T17 fires", () => {
    const { h, ui } = boot(); ui.setTemplateEditorEnabled(false);
    expect(isHidden(btn(h))).toBe(true); expect(ui.state().templateEditorEnabled).toBe(false);
    ui.setTemplateEditorEnabled(true); expect(isHidden(btn(h))).toBe(false);
  });
});

describe("U20 accessibility (keyboard order, roving tabindex, focus)", () => {
  const seed12 = (ui: ReturnType<typeof boot>["ui"]) => ui.setCapsules(ids(12).map((id) => card(id)));
  it("wall container is role=list, cards role=listitem, exactly one tabindex=0", () => {
    const { h, ui } = boot(); ui.update(D()); seed12(ui);
    expect(h.container.getAttribute("role")).toBe("list");
    expect([...h.nodes.values()].every((n) => n.getAttribute("role") === "listitem")).toBe(true);
    expect([...h.nodes.values()].filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1);
  });
  it("Tab order across regions: onboarding, lens-switcher, tools, wall; no positive tabindex", () => {
    const { h, ui } = boot(); ui.update(D({ device: { state: "needs_gesture" }, availability: "downloadable" })); seed12(ui);
    const tabbable = [...h.root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter((e) => !isHidden(e) && e.getAttribute("tabindex") !== "-1" && !(e as HTMLButtonElement).disabled);
    expect(tabbable.every((e) => Number(e.getAttribute("tabindex") ?? 0) <= 0)).toBe(true);
    const regs = tabbable.map((e) => e.closest("[data-region]")?.getAttribute("data-region") ?? "none");
    expect(regs).not.toContain("none");
    expect([...new Set(regs)]).toEqual(["onboarding", "lens-switcher", "tools", "wall"]);
    expect(regs.filter((r) => r === "wall")).toHaveLength(1);
  });
  it("O8 via DOM events: ArrowRight x11 walks all cards, focus follows, Enter opens last", () => {
    const { h, ui } = boot(); ui.update(D()); seed12(ui);
    const first = h.nodes.get("p1")!; first.focus(); expect(document.activeElement).toBe(first);
    for (let i = 2; i <= 12; i++) { key(document.activeElement!, "ArrowRight"); expect(document.activeElement).toBe(h.nodes.get(`p${i}`)); expect([...h.nodes.values()].filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1); }
    key(document.activeElement!, "ArrowDown"); expect(document.activeElement).toBe(h.nodes.get("p12"));
    key(document.activeElement!, "Home"); expect(document.activeElement).toBe(first);
    key(document.activeElement!, "End"); key(document.activeElement!, "Enter");
    expect(h.onOpen).toHaveBeenCalledTimes(1); expect(h.onOpen).toHaveBeenCalledWith("p12");
  });
  it("Escape returns focus to the wall container", () => {
    const { h, ui } = boot(); ui.update(D()); seed12(ui);
    h.nodes.get("p3")!.focus(); key(h.nodes.get("p3")!, "Escape");
    expect(document.activeElement).toBe(h.container);
  });
  it("O9 focus_on_unmount: removing the focused card moves focus to the former next card, never body", () => {
    const { h, ui } = boot(); ui.update(D()); seed12(ui);
    h.nodes.get("p1")!.focus(); for (let i = 0; i < 4; i++) key(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(h.nodes.get("p5"));
    ui.setCapsules(ids(12).filter((x) => x !== "p5").map((id) => card(id)));
    expect(h.renderer.unmount).toHaveBeenCalledWith("p5");
    expect(document.activeElement).toBe(h.nodes.get("p6")); expect(document.activeElement).not.toBe(document.body);
  });
  it("unmounting the last focused card falls back to previous", () => {
    const { h, ui } = boot(); ui.update(D()); seed12(ui);
    h.nodes.get("p1")!.focus(); key(document.activeElement!, "End");
    ui.setCapsules(ids(11).map((id) => card(id)));
    expect(document.activeElement).toBe(h.nodes.get("p11"));
  });
  it("unmounting every card moves focus to the container", () => {
    const { h, ui } = boot(); ui.update(D()); ui.setCapsules([card("p1")]);
    h.nodes.get("p1")!.focus(); ui.setCapsules([]);
    expect(document.activeElement).toBe(h.container);
  });
});

describe("U20 motion + theme (B16, B17)", () => {
  it("root class ui-reduced-motion follows MotionPort live", () => {
    const { h } = boot({ reduced: true });
    expect(h.root.classList.contains("ui-reduced-motion")).toBe(true);
    h.motion.set(false); expect(h.root.classList.contains("ui-reduced-motion")).toBe(false);
    h.motion.set(true); expect(h.root.classList.contains("ui-reduced-motion")).toBe(true);
  });
  it("root data-theme follows ThemePort live (light/dark)", () => {
    const { h } = boot({ dark: true });
    expect(h.root.getAttribute("data-theme")).toBe("dark");
    h.theme.set(false); expect(h.root.getAttribute("data-theme")).toBe("light");
  });
  it("no inline style attribute anywhere after a full render", () => {
    const { h, ui } = boot({ dark: true, reduced: true });
    ui.update(D({ device: { state: "downloading", progress: 0.5 } })); ui.setCapsules(ids(4).map((id) => card(id, { stale: true })));
    ui.setPlan("p1", [{ text: "a", state: "doing" }]); ui.setFilter("study");
    expect(h.root.querySelectorAll("[style]")).toHaveLength(0);
  });
});

describe("U20 DOM safety (O13, B9, B18)", () => {
  const EVIL = "<img src=x onerror=alert(1)>";
  it("O13 hostile blocked reason and projectId are literal text; 0 img", () => {
    const { h, ui } = boot();
    ui.update(D({ host: { kind: "blocked", reason: EVIL } }));
    expect(txt(h.banner())).toContain(EVIL);
    ui.update(D()); ui.setCapsules([card(EVIL, { attention: "now" })]); h.clock.advance(6000);
    expect(h.root.querySelectorAll("img")).toHaveLength(0);
    expect(h.root.querySelectorAll("[onerror]")).toHaveLength(0);
  });
  it("no innerHTML/outerHTML/insertAdjacentHTML/document.write at runtime across a full flow", () => {
    const iSet = vi.spyOn(Element.prototype, "innerHTML", "set");
    const oSet = vi.spyOn(Element.prototype, "outerHTML", "set");
    const adj = vi.spyOn(Element.prototype, "insertAdjacentHTML");
    const dw = vi.spyOn(document, "write");
    const { h, ui } = boot();
    ui.update(D({ host: { kind: "blocked", reason: EVIL } })); ui.update(D({ device: { state: "needs_gesture" }, availability: "downloadable" }));
    ui.setCapsules(ids(3).map((id) => card(id))); ui.setPlan("p1", [{ text: EVIL, state: "todo" }]); ui.setFilter("study");
    ui.reportRenderError("allowlist_invalid"); ui.dispose();
    expect(iSet).not.toHaveBeenCalled(); expect(oSet).not.toHaveBeenCalled(); expect(adj).not.toHaveBeenCalled(); expect(dw).not.toHaveBeenCalled();
    expect(h.root.querySelectorAll("img")).toHaveLength(0);
  });
  it("logs no capsule text (B18)", () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    const { ui } = boot(); ui.update(D()); ui.setCapsules([card("SECRETPROJ")]); ui.setPlan("SECRETPROJ", [{ text: "SECRETSTEP", state: "todo" }]);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toMatch(/SECRET/);
  });
});

describe("U20 dispose", () => {
  it("unsubscribes motion/theme, cancels timers, ignores later input", () => {
    const { h, ui } = boot(); ui.update(D({ device: { state: "needs_gesture" }, availability: "downloadable" }));
    ui.setCapsules([card("p1")]); ui.update(D()); ui.setCapsules([card("p1", { attention: "now" })]);
    ui.dispose();
    expect(h.motion.listeners).toBe(0); expect(h.theme.listeners).toBe(0); expect(h.clock.pending).toBe(0);
  });
});
