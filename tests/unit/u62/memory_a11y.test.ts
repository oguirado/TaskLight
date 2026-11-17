import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mountWall } from "../../../src/views/index";
import { renderPlanBand, renderPhaseTaskCards, groupTasksByPhase } from "../../../src/views/plan";
import { renderMemoryView, MEMORY_VIEW_LIMITS } from "../../../src/views/memory";
import { all, hostile, key, memory, mount, phases, plan, q, safeDOM, setup, task, text, wall } from "./helpers";

setup();
const repo = resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const tab = (host: ParentNode, view: string) => {
  const t = all(host, '[role="tablist"] [role="tab"]').find(n => new RegExp(view, "i").test(text(n)));
  expect(t, `Missing ${view} tab`).toBeDefined(); return t!;
};

describe("O6 read-only memory", () => {
  it("O6 published memory limits are frozen and match the spec", () => {
    expect(MEMORY_VIEW_LIMITS).toEqual({ SECTIONS_MAX: 12, SECTION_TEXT_MAX: 2000, LABEL_MAX: 64 });
    expect(Object.isFrozen(MEMORY_VIEW_LIMITS)).toBe(true);
  });
  it("O6 populated author/time and required-empty flag, no editing controls", () => {
    const root = renderMemoryView(document, memory());
    for (const s of ["Decisions", "Use the stable API.", "builder", "2026-11-15 09:00", "Risks"]) expect(text(root)).toContain(s);
    const flagged = all(root, '[data-required-empty="true"]'); expect(flagged).toHaveLength(1);
    expect(text(flagged[0]!)).toContain("Required — empty");
    expect(root.querySelector('input, textarea, select, button, [contenteditable]:not([contenteditable="false"])')).toBeNull();
  });
  it.each([undefined, { sections: [] }])("O6 missing/empty memory %j has English empty copy", value => {
    const root = renderMemoryView(document, value);
    expect(text(root).trim().length).toBeGreaterThan(0); expect(text(root)).toMatch(/no|empty|yet/i);
    expect(root.querySelector("input, textarea, select")).toBeNull();
  });
  it("O6 optional empty memory is not marked required", () => {
    const m = memory(); const root = renderMemoryView(document, { sections: m.sections.map(s => ({ ...s, required: false })) });
    expect(root.querySelector('[data-required-empty="true"]')).toBeNull();
  });
  it("O6 memory is available without an active plan (W0-R)", () => {
    const reference = renderMemoryView(document, memory());
    const { host } = mount(wall({ view: "memory", plan: undefined }));
    for (const section of memory().sections) expect(text(host)).toContain(section.label);
    expect(text(reference)).toContain("Use the stable API.");
    expect(host.querySelector("input, textarea, select")).toBeNull();
  });
});
describe("O7 navigation and lifecycle", () => {
  it("O7 archive ArrowRight activates/focuses memory and announces, then Home/End/ArrowLeft", () => {
    const reference = renderMemoryView(document, memory());
    const onView = vi.fn(); const { host, handle } = mount(wall({ view: "archive" }), { onView });
    expect(all(host, '[role="tablist"] [role="tab"]')).toHaveLength(5);
    for (const view of ["wall", "agenda", "diary", "archive", "memory"]) {
      expect(tab(host, view).getAttribute("aria-selected")).toBe(String(view === "archive"));
    }
    const archive = tab(host, "archive"); archive.focus(); key(archive, "ArrowRight");
    expect(onView).toHaveBeenLastCalledWith("memory");
    // mountWall remains controlled, as required by the legacy contract: simulate owner update.
    handle.update(wall({ view: "memory" }));
    const mem = tab(host, "memory"); expect(mem.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(mem);
    expect(text(q(host, '[aria-live="polite"]'))).toMatch(/memory.*view/i);
    expect(text(reference)).toContain("Use the stable API.");
    expect(text(host)).toContain("Use the stable API.");
    key(mem, "Home"); expect(onView).toHaveBeenLastCalledWith("wall");
    handle.update(wall({ view: "wall" }));
    const first = tab(host, "wall"); expect(document.activeElement).toBe(first);
    expect(text(q(host, '[aria-live="polite"]'))).toMatch(/wall.*view/i);
    key(first, "End"); expect(onView).toHaveBeenLastCalledWith("memory");
    handle.update(wall({ view: "memory" }));
    key(tab(host, "memory"), "ArrowLeft"); expect(onView).toHaveBeenLastCalledWith("archive");
  });
  it("O7 phase selection invokes callback and announces the selection", () => {
    const onSelectPhase = vi.fn(); const announce = vi.fn();
    const root = renderPlanBand(document, plan(), { onSelectPhase, announce });
    const chip = all(root, "button, [role=button]").find(n => text(n).includes("Discover"));
    expect(chip).toBeDefined(); chip!.click();
    expect(onSelectPhase).toHaveBeenCalledExactlyOnceWith("discover");
    expect(announce).toHaveBeenCalled();
    expect(announce.mock.calls.flat().join(" ")).toMatch(/discover/i);
  });
  it("O7 destroy removes listeners on retained tabs/cards/model trigger and clears host", () => {
    const expected = renderPlanBand(document, plan());
    const onView = vi.fn(); const onOpenTask = vi.fn(); const onOpenModels = vi.fn();
    const { host, handle } = mount(wall(), { onView, onOpenTask, onOpenModels });
    expect(text(host)).toContain(plan().title); expect(text(expected)).toContain(plan().title);
    const retained = all(host, "button, .task"); const archive = tab(host, "archive");
    handle.destroy(); expect(host.childNodes).toHaveLength(0);
    const calls = [onView.mock.calls.length, onOpenTask.mock.calls.length, onOpenModels.mock.calls.length];
    for (const n of retained) n.click(); key(archive, "ArrowRight"); key(document, "2");
    expect([onView.mock.calls.length, onOpenTask.mock.calls.length, onOpenModels.mock.calls.length]).toEqual(calls);
    expect(() => handle.destroy()).not.toThrow();
  });
  it("O7 valid host renders the plan and invalid hosts throw the exact TypeError", () => {
    const root = renderPlanBand(document, plan());
    const { host: valid } = mount();
    expect(text(root)).toContain(plan().title); expect(text(valid)).toContain(plan().title);
    for (const host of [null, {}, document.createTextNode("invalid")]) {
      expect(() => mountWall(host as unknown as HTMLElement, wall())).toThrow(new TypeError("mountWall: host element required"));
    }
  });
  it("O7 legacy no-plan cards/workspaces/model trigger and task click stay compatible", () => {
    const onOpenTask = vi.fn(); const onOpenModels = vi.fn(); const onWorkspace = vi.fn();
    const { host } = mount(wall({ plan: undefined }), { onOpenTask, onOpenModels, onWorkspace });
    const card = q(host, ".task"); expect(text(card)).toContain("Build release");
    expect(card.querySelector(".steps .step-row")).not.toBeNull(); expect(card.querySelector(".source")).not.toBeNull();
    // A-R41: legacy card clicks are read-only; Messages retains keyboard chat access.
    card.click(); expect(onOpenTask).not.toHaveBeenCalled();
    q(host, ".messages-toggle").click(); q(host, ".messages-open").click();
    expect(onOpenTask).toHaveBeenCalledTimes(1); expect(onOpenTask.mock.calls[0]![0]).toBe("T01");
    const model = q(host, 'button[aria-controls="model-sheet"]'); model.click();
    expect(onOpenModels).toHaveBeenCalledExactlyOnceWith(model);
    q(host, '.workspace[data-wsid="w1"]').click(); expect(onWorkspace).toHaveBeenCalledExactlyOnceWith("w1");
    expect(text(host)).not.toContain("Release plan");
  });
});
describe("O8 memory and update containment", () => {
  it("O8 memory text/label/author/time remain literal and cannot execute", () => {
    const root = renderMemoryView(document, { sections: [{ ...memory().sections[0]!, label: hostile,
      text: hostile, by: hostile, changedAt: hostile }] });
    expect(text(root).split(hostile).length - 1).toBeGreaterThanOrEqual(4); safeDOM(root);
  });
  it("O8 twenty memory sections truncate to the first twelve deterministically", () => {
    const sections = Array.from({ length: 20 }, (_, i) => ({ ...memory().sections[0]!, id: `m${i}`, label: `Section [${i}]`, text: `Text [${i}]` }));
    const root = renderMemoryView(document, { sections });
    for (let i = 0; i < MEMORY_VIEW_LIMITS.SECTIONS_MAX; i++) expect(text(root)).toContain(`Section [${i}]`);
    for (let i = MEMORY_VIEW_LIMITS.SECTIONS_MAX; i < 20; i++) expect(text(root)).not.toContain(`Section [${i}]`);
    expect(text(renderMemoryView(document, { sections }))).toBe(text(root));
  });
  it("O8 memory text and labels respect display limits", () => {
    const root = renderMemoryView(document, { sections: [{ ...memory().sections[0]!, label: "L".repeat(100), text: "z".repeat(2500) }] });
    expect(text(root)).toContain("z".repeat(2000)); expect(text(root)).not.toContain("z".repeat(2001));
    expect(text(root)).not.toContain("L".repeat(65));
  });
  it.each([null, {}, { sections: null }, { sections: [null, {}, { text: {}, by: [] }] }])("O8 malformed memory %j does not throw", value => {
    expect(() => renderMemoryView(document, value as unknown as Parameters<typeof renderMemoryView>[1])).not.toThrow();
  });
  it("O8 update tolerates missing/empty plan, diary and memory in every view", () => {
    const reference = renderMemoryView(document, undefined); expect(text(reference).length).toBeGreaterThan(0);
    const { host, handle } = mount(wall({ view: "memory", memory: undefined }));
    expect(text(host)).toContain(text(reference).trim());
    for (const view of ["wall", "agenda", "diary", "archive", "memory"]) {
      for (const fields of [{ plan: undefined, diary: undefined, memory: undefined }, { plan: {}, diary: [], memory: {} }]) {
        expect(() => handle.update(wall({ view, ...fields }))).not.toThrow();
      }
    }
    for (const value of [undefined, null, {}, { tasks: [null], workspaces: [null] }]) {
      expect(() => handle.update(value as unknown as Parameters<typeof handle.update>[0])).not.toThrow();
    }
  });
});
describe("O9 static and token gates", () => {
  it("O9 view modules exclude unsafe HTML sinks, executable string evaluation and network calls", () => {
    for (const path of ["src/views/plan.ts", "src/views/memory.ts"]) {
      const code = strip(read(path));
      expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function\b/);
      expect(code).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/);
      expect(code).not.toMatch(/setAttribute\s*\(\s*["']on/i);
    }
  });
  it("O9 plan stylesheet has no external assets and consumes only existing tokens", () => {
    const root = renderPlanBand(document, plan()); expect(root.querySelector(".progress")).not.toBeNull();
    const css = strip(read("styles/plan.css"));
    expect(css).not.toMatch(/https?:\/\/|data:image/i);
    const tokenPath = existsSync(resolve(repo, "design/tokens.css")) ? "design/tokens.css" : "styles/tokens.css";
    const defined = new Set([...read(tokenPath).matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) expect(defined.has(m[1]), m[1]).toBe(true);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
  });
  // A-U78a: superseded by U78 M6 (memory text uses the full content width; persona study R28).
  it.skip("O9 memory panels enforce reading width through the existing token", () => {
    // A-U62a: jsdom does not resolve var() in getComputedStyle; assert the stylesheet rule and the class chain instead.
    const root = renderMemoryView(document, memory()); document.body.append(root);
    const css = read("styles/plan.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /max-width\s*:\s*var\(--reading-max\)/.test(m[2] ?? ""));
    expect(rules.length, "a rule sets max-width: var(--reading-max)").toBeGreaterThan(0);
    const selectors = rules.flatMap(m => (m[1] ?? "").split(",").map(x => x.trim()));
    for (const section of memory().sections) {
      let panel = all(root, "*").find(n => n.childElementCount === 0 && text(n) === section.label);
      expect(panel).toBeDefined(); let reading = false;
      while (panel && root.contains(panel)) {
        if (selectors.some(sel => { try { return panel!.matches(sel); } catch { return false; } })) reading = true;
        panel = panel.parentElement ?? undefined;
      }
      expect(reading, section.label).toBe(true);
    }
  });
  it("O9 plan renders dependency text without SVG/Canvas graphs", () => {
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task({ waitsFor: ["T02"] })], phases));
    expect(text(root)).toContain("Waits for T02"); expect(root.querySelector("svg, canvas")).toBeNull();
  });
});
