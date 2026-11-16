import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMemoryView, MEMORY_VIEW_LIMITS } from "../../../src/views/memory";
import { renderPlanArchive, renderPlanDiary, PLAN_VIEW_LIMITS } from "../../../src/views/plan";
import { mountWall } from "../../../src/views/index";
import type { ArchivedVM, MemorySectionVM, MemoryVM, WallVM } from "../../../src/views/types";

const explanation = "Room log position of this section's last accepted update";
const hostile = '<img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n' + "x".repeat(1000);
const section = (changes: Partial<MemorySectionVM> = {}): MemorySectionVM => ({
  id: "goal", label: "Goal", text: hostile, required: true, empty: false, rev: 9,
  by: "carol", changedAt: "2026-11-15 09:00", maxChars: 2000, ...changes,
});
const render = (sections: readonly MemorySectionVM[]) => {
  const root = renderMemoryView(document, { sections });
  document.body.append(root);
  return root;
};
const archived = (changes: Partial<ArchivedVM> = {}): ArchivedVM => ({
  id: "archive-1", workspace: "w1", project: "Readable project", accent: "sky",
  title: "Finished plan", archived: "2026-11-15", took: "unavailable", steps: 4,
  taskCount: 3, outcome: "Verified", source: { kind: "device", ms: 0 }, ...changes,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T09:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(["light", "dark"])("U94 DOM contracts, %s theme", (theme) => {
  beforeEach(() => document.documentElement.setAttribute("data-theme", theme));

  it("A6 uses Revision N and a visible explanation, preserving author and time", () => {
    const root = render([section()]);
    expect(root.textContent).toContain("Revision 9");
    expect(root.textContent).not.toMatch(/\brev 9\b/);
    const explained = [...root.querySelectorAll<HTMLElement>("*")].filter(n =>
      n.textContent?.includes(explanation) && ![...n.children].some(c => c.textContent?.includes(explanation)));
    expect(explained.length).toBeGreaterThan(0);
    for (const node of explained) {
      for (let at: HTMLElement | null = node; at; at = at.parentElement) {
        expect(at.hidden).toBe(false);
        expect(at.getAttribute("aria-hidden")).not.toBe("true");
        expect(getComputedStyle(at).display).not.toBe("none");
        expect(getComputedStyle(at).visibility).not.toBe("hidden");
      }
    }
    expect(root.textContent).toContain("carol");
    expect(root.textContent).toContain("2026-11-15 09:00");
  });

  it("A6 preserves literal HTML, Markdown, line breaks, and a selectable long token", () => {
    const root = render([section({ label: '<b>Literal label</b>' })]);
    expect(root.querySelector(".memory-text")?.textContent).toBe(hostile);
    expect(root.querySelector(".memory-label")?.textContent).toBe('<b>Literal label</b>');
    expect(root.querySelector("img, script, svg, iframe, a, b")).toBeNull();
    for (const node of root.querySelectorAll("*")) {
      expect([...node.attributes].some(a => /^on/i.test(a.name))).toBe(false);
    }
    const paragraph = root.querySelector(".memory-text")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(hostile);
    selection.removeAllRanges();
  });

  it("A6 absent revision metadata stays absent and does not become Revision 0", () => {
    const raw: Record<string, unknown> = { ...section() };
    delete raw.rev;
    const root = renderMemoryView(document, { sections: [raw] } as unknown as MemoryVM);
    expect(root.textContent).not.toMatch(/\b(?:Revision|rev)\s+(?:0|undefined|null)\b/);
    expect(root.textContent).not.toContain("Revision");
    expect(root.textContent).toContain("carol");
    expect(root.textContent).toContain("2026-11-15 09:00");
  });

  it("M8 preserves explicit revision zero and required-empty status", () => {
    const root = render([section({ text: "", rev: 0, empty: true })]);
    expect(root.textContent).toContain("Revision 0");
    expect(root.querySelector('[data-required-empty="true"]')?.textContent).toContain("Required — empty");
    expect(root.querySelector('input, textarea, select, button, [contenteditable="true"]')).toBeNull();
  });

  it("M8 preserves existing section, label and text bounds", () => {
    expect(MEMORY_VIEW_LIMITS).toEqual({ SECTIONS_MAX: 12, SECTION_TEXT_MAX: 2000, LABEL_MAX: 64 });
    expect(Object.isFrozen(MEMORY_VIEW_LIMITS)).toBe(true);
    const root = render(Array.from({ length: 13 }, (_, i) => section({ id: `s${i}`, label: "L".repeat(80), text: "t".repeat(2100) })));
    expect(root.querySelectorAll(".memory-panel")).toHaveLength(12);
    for (const label of root.querySelectorAll(".memory-label")) expect(label.textContent).toHaveLength(64);
    for (const text of root.querySelectorAll(".memory-text")) expect(text.textContent).toHaveLength(2000);
  });

  it("A7 plan archive preserves Duration unknown, task count and reachable Restore", () => {
    const onRestore = vi.fn();
    const root = renderPlanArchive(document, [archived()], { onRestore });
    document.body.append(root);
    expect(root.textContent).toContain("Duration unknown");
    expect(root.textContent).toContain("3 tasks");
    expect(root.textContent).not.toContain("4 steps");
    const button = root.querySelector<HTMLButtonElement>(".archived-restore")!;
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click(); // jsdom cannot synthesize native keyboard activation.
    expect(onRestore).toHaveBeenCalledExactlyOnceWith("archive-1");
  });

  it("A7 archive retains singular task and legacy step labels", () => {
    const one = renderPlanArchive(document, [archived({ taskCount: 1 })]);
    expect(one.textContent).toContain("1 task");
    expect(one.textContent).not.toContain("1 tasks");
    const legacy: Record<string, unknown> = { ...archived() };
    delete legacy.taskCount;
    expect(renderPlanArchive(document, [legacy as unknown as ArchivedVM]).textContent).toContain("4 steps");
  });

  it("A7 legacy archive in mountWall preserves Duration unknown, steps and controls", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onRestore = vi.fn();
    const vm = { now: "09:00", model: { state: "ready", label: "Ready" }, network: "offline",
      workspaces: [{ id: "w1", name: "Workspace", lens: "dev", accent: "sky" }], workspace: "w1",
      view: "archive", archiveScope: "workspace", tasks: [], agenda: [], archive: [archived()],
    } as WallVM;
    const handle = mountWall(host, vm, { onRestore });
    try {
      expect(host.querySelector(".archived-steps")?.textContent).toBe("4 steps · Duration unknown");
      const button = host.querySelector<HTMLButtonElement>(".archived-restore")!;
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(button.disabled).toBe(false);
      button.click();
      expect(onRestore).toHaveBeenCalledExactlyOnceWith("archive-1");
    } finally { handle.destroy(); }
  });

  it("A7 Diary retains timestamp, literal body, author and long text", () => {
    const root = renderPlanDiary(document, [{ day: "2026-11-15", entries: [
      { kind: "memory", day: "2026-11-15", at: "09:00", title: "Goal", outcome: hostile, author: "carol" },
    ] }]);
    expect(root.querySelector(".entry-time")?.textContent).toBe("09:00");
    expect(root.querySelector(".entry-outcome")?.textContent).toBe(hostile.slice(0, PLAN_VIEW_LIMITS.OUTCOME_MAX));
    expect(root.textContent).toContain("carol");
    expect(root.querySelector("img, script, a")).toBeNull();
  });
});
