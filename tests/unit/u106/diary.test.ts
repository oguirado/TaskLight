import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlanDiary, PLAN_VIEW_LIMITS, renderPlanDiary } from "../../../src/views/plan";
import type { DiaryDayGroupVM } from "../../../src/views/plan";
import type { DiaryEntryVM } from "../../../src/views/types";

const kinds = ["microtask", "memory"] as const;
const fixture = (changes: Partial<DiaryEntryVM> = {}): DiaryEntryVM => ({
  kind: "microtask", day: "2026-11-16", at: "10:05", title: "T01.M01",
  outcome: "Verified the completed checklist.", took: "2m", author: "executor-a",
  evidence: ["evidence/check.md"], ...changes,
});
function render(entry: DiaryEntryVM): HTMLElement {
  return renderPlanDiary(document, [{ day: entry.day, entries: [entry] }]);
}
function required(root: ParentNode, selector: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector);
  expect(node, `Required Diary element: ${selector}`).not.toBeNull();
  return node!;
}
function assertEntryStructure(entry: HTMLElement): void {
  expect(Array.from(entry.children, child => child.tagName),
    "An entry has exactly the time cell followed by its body").toEqual(["TIME", "DIV"]);
  expect(entry.children[0]!.matches("time.entry-time")).toBe(true);
  expect(entry.children[1]!.matches("div.entry-body")).toBe(true);
}
const texts = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll(selector), node => node.textContent);
function assertPassive(root: HTMLElement): void {
  expect(root.querySelector("script, img, svg, b, iframe, object, embed, a, [href], [src]")).toBeNull();
  for (const node of [root, ...root.querySelectorAll("*")]) {
    expect(Array.from(node.attributes).filter(attr => /^on/i.test(attr.name))).toEqual([]);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T10:05:00Z"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this oracle"); }));
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {
    throw new Error("Network is forbidden in this oracle");
  });
});
afterEach(() => {
  document.body.replaceChildren();
  expect(fetch).not.toHaveBeenCalled();
  expect(XMLHttpRequest.prototype.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("U106 independent Diary oracle", () => {
  it.each(kinds)("A1 full %s entry has ordered time/body cells and exact body content", kind => {
    const e = fixture({ kind });
    const root = render(e);
    expect(root.matches("section.diary")).toBe(true);
    expect(texts(root, "h2.diary-heading")).toEqual([e.day]);
    const entry = required(root, "li.entry");
    assertEntryStructure(entry);
    expect(entry.dataset.kind).toBe(kind);
    expect(required(entry, ":scope > time.entry-time").textContent).toBe(e.at);
    const body = required(entry, ":scope > div.entry-body");
    const bodySelectors = ["p.entry-title", "p.entry-outcome", "p.entry-meta", "ul.entry-evidence"];
    expect(body.children).toHaveLength(bodySelectors.length);
    bodySelectors.forEach((selector, index) => expect(body.children[index]!.matches(selector)).toBe(true));
    expect(required(body, "p.entry-title").textContent).toBe(e.title);
    expect(required(body, "p.entry-outcome").textContent).toBe(e.outcome);
    const meta = required(body, "p.entry-meta");
    expect(meta.children).toHaveLength(2);
    expect(meta.children[0]!.matches("span.entry-took")).toBe(true);
    expect(meta.children[1]!.matches("span.entry-author")).toBe(true);
    expect(required(meta, "span.entry-took").textContent).toBe(e.took);
    expect(required(meta, "span.entry-author").textContent).toBe(e.author);
    expect(texts(body, "ul.entry-evidence > li")).toEqual(e.evidence);
  });

  it.each(kinds)("A2 %s entry retains an empty time cell and populated body", kind => {
    const e = fixture({ kind, at: "" });
    const entry = required(render(e), "li.entry");
    assertEntryStructure(entry);
    expect(required(entry, ":scope > time.entry-time").textContent).toBe("");
    expect(required(entry, ":scope > .entry-body > .entry-title").textContent).toBe(e.title);
    expect(required(entry, ":scope > .entry-body > .entry-outcome").textContent).toBe(e.outcome);
  });

  it.each(kinds)("A2 %s entry omits absent optional containers without inventing values", kind => {
    const e: DiaryEntryVM = { kind, day: "2026-11-16", at: "", title: "Title only" };
    const entry = required(render(e), "li.entry");
    assertEntryStructure(entry);
    expect(required(entry, "time.entry-time").textContent).toBe("");
    const body = required(entry, "div.entry-body");
    expect(Array.from(body.children, node => node.tagName)).toEqual(["P"]);
    expect(required(body, "p.entry-title").textContent).toBe(e.title);
    expect(body.querySelector(".entry-outcome, .entry-meta, .entry-took, .entry-author, .entry-evidence")).toBeNull();
    expect(entry.textContent).toBe(e.title);
  });

  it.each(kinds)("A2 %s entry omits empty optional containers", kind => {
    const entry = required(render(fixture({ kind, outcome: "", took: "", author: "", evidence: [] })), "li.entry");
    const body = required(entry, "div.entry-body");
    expect(texts(body, ":scope > p.entry-title")).toEqual(["T01.M01"]);
    expect(body.children).toHaveLength(1);
    expect(body.querySelector(".entry-outcome, .entry-meta, .entry-took, .entry-author, .entry-evidence")).toBeNull();
  });

  describe.each(kinds)("A2 optional metadata for %s", kind => {
    it.each([
      { label: "author only", took: "", author: "executor-a", classes: ["entry-author"] },
      { label: "duration only", took: "2m", author: "", classes: ["entry-took"] },
      { label: "no metadata", took: "", author: "", classes: [] },
    ])("$label preserves body order and omits absent spans", sample => {
      const body = required(render(fixture({ kind, took: sample.took, author: sample.author })), ".entry-body");
      const selectors = [
        "p.entry-title", "p.entry-outcome", ...(sample.classes.length ? ["p.entry-meta"] : []), "ul.entry-evidence",
      ];
      expect(body.children).toHaveLength(selectors.length);
      selectors.forEach((selector, index) => expect(body.children[index]!.matches(selector)).toBe(true));
      if (sample.classes.length) {
        const meta = required(body, "p.entry-meta");
        expect(meta.children).toHaveLength(sample.classes.length);
        sample.classes.forEach((cls, index) => expect(meta.children[index]!.matches(`span.${cls}`)).toBe(true));
        if (sample.took) expect(required(meta, "span.entry-took").textContent).toBe(sample.took);
        if (sample.author) expect(required(meta, "span.entry-author").textContent).toBe(sample.author);
      } else {
        expect(body.querySelector(".entry-meta")).toBeNull();
      }
      expect(body.querySelectorAll(".entry-author")).toHaveLength(sample.author ? 1 : 0);
      expect(body.querySelectorAll(".entry-took")).toHaveLength(sample.took ? 1 : 0);
    });
  });

  it.each(kinds)("A3 hostile %s fields are literal passive text in their designated elements", kind => {
    const e = fixture({
      kind, title: "<img src=x onerror=alert(1)>", outcome: "<script>alert(1)</script>",
      author: "<b>executor-a</b>", evidence: ["javascript:alert(1)"],
      at: "<time onclick=alert(1)>x</time>", day: "<svg onload=alert(1)>",
      took: "<img src=x onerror=alert(1)>",
    });
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const root = render(e);
    document.body.append(root);
    for (const [selector, value] of [
      [".diary-heading", e.day], [".entry-time", e.at], [".entry-title", e.title],
      [".entry-outcome", e.outcome], [".entry-author", e.author], [".entry-took", e.took],
      [".entry-evidence > li", e.evidence![0]],
    ] as const) {
      const node = required(root, selector);
      expect(node.textContent).toBe(value);
      expect(node.children).toHaveLength(0);
    }
    assertPassive(root);
    expect(alert).not.toHaveBeenCalled();
  });

  it.each(kinds)("A3 hostile %s content remains inside the body except day and time", kind => {
    const e = fixture({ kind, title: "<img src=x onerror=alert(1)>",
      outcome: "<script>alert(1)</script>", author: "<b>executor-a</b>",
      evidence: ["javascript:alert(1)"], took: "<b>2m</b>" });
    const body = required(render(e), "li.entry > div.entry-body");
    expect(required(body, "p.entry-title").textContent).toBe(e.title);
    expect(required(body, "p.entry-outcome").textContent).toBe(e.outcome);
    expect(required(body, "p.entry-meta > span.entry-author").textContent).toBe(e.author);
    expect(required(body, "p.entry-meta > span.entry-took").textContent).toBe(e.took);
    expect(texts(body, "ul.entry-evidence > li")).toEqual(e.evidence);
    expect(body.querySelector("time, .diary-heading")).toBeNull();
    assertPassive(body);
  });

  it.each(kinds)("A3 long unbroken %s title/outcome/evidence retain bounded literal content", kind => {
    const title = "T".repeat(1024);
    const outcome = "O".repeat(PLAN_VIEW_LIMITS.OUTCOME_MAX + 17);
    const path = `evidence/${"x".repeat(2048)}.md`;
    const root = render(fixture({ kind, title, outcome, evidence: [path] }));
    expect(required(root, ".entry-title").textContent).toBe(title);
    expect(required(root, ".entry-outcome").textContent).toBe(outcome.slice(0, PLAN_VIEW_LIMITS.OUTCOME_MAX));
    expect(texts(root, ".entry-evidence > li")).toEqual([path]);
    assertPassive(root);
  });

  it("A3 outcome text preserves supplied newlines and spaces", () => {
    const outcome = "First line.\n  Second line.\n\nLast line.";
    expect(required(render(fixture({ outcome })), ".entry-outcome").textContent).toBe(outcome);
  });

  it.each([
    { label: "empty groups", input: [] },
    { label: "null groups", input: null },
    { label: "undefined groups", input: undefined },
    { label: "object groups", input: {} },
    { label: "string groups", input: "not an array" },
    { label: "numeric groups", input: 7 },
    { label: "boolean groups", input: false },
    { label: "invalid group members", input: [null, undefined, false, 7, "not a group"] },
    { label: "empty entries", input: [{ day: "2026-11-16", entries: [] }] },
    { label: "null-only entries", input: [{ day: "2026-11-16", entries: [null, null] }] },
    { label: "missing entries", input: [{ day: "2026-11-16" }] },
    { label: "non-array entries", input: [{ day: "2026-11-16", entries: {} }] },
  ])("A4 $label yields only the empty-state message without throwing", ({ input }) => {
    const call = () => renderPlanDiary(document, input as unknown as readonly DiaryDayGroupVM[]);
    expect(call).not.toThrow();
    const root = call();
    expect(texts(root, "p.diary-empty")).toEqual(["No diary entries yet."]);
    expect(root.textContent).toBe("No diary entries yet.");
    expect(root.querySelector(".entry, .diary-day, .diary-heading, .timeline")).toBeNull();
  });

  it.each(kinds)("A4 mixed null/valid %s entries survive group and entry filtering", kind => {
    const e = fixture({ kind });
    const input = [null, { day: e.day, entries: [null, e] }];
    const root = renderPlanDiary(document, input as unknown as readonly DiaryDayGroupVM[]);
    expect(texts(root, ".entry-title")).toEqual([e.title]);
    expect(texts(root, ".diary-heading")).toEqual([e.day]);
    expect(root.querySelectorAll("li.entry")).toHaveLength(1);
    expect(required(root, "li.entry").dataset.kind).toBe(kind);
    expect(root.querySelector(".diary-empty")).toBeNull();
  });

  it.each([
    { label: "below limits", extra: -1 },
    { label: "at limits", extra: 0 },
    { label: "over limits", extra: 1 },
  ])("A4 $label preserves exact outcome/duration slices and evidence prefix", ({ extra }) => {
    const outcome = "o".repeat(PLAN_VIEW_LIMITS.OUTCOME_MAX + extra);
    const took = "t".repeat(PLAN_VIEW_LIMITS.TOOK_MAX + extra);
    const evidence = Array.from({ length: PLAN_VIEW_LIMITS.EVIDENCE_MAX + extra }, (_, i) => `evidence/${i}.md`);
    const root = render(fixture({ outcome, took, evidence }));
    expect(required(root, ".entry-outcome").textContent).toBe(outcome.slice(0, PLAN_VIEW_LIMITS.OUTCOME_MAX));
    expect(required(root, ".entry-took").textContent).toBe(took.slice(0, PLAN_VIEW_LIMITS.TOOK_MAX));
    expect(texts(root, ".entry-evidence > li")).toEqual(evidence.slice(0, PLAN_VIEW_LIMITS.EVIDENCE_MAX));
  });

  it("A4 repeated days preserve first-seen group order and entry/evidence order", () => {
    const entries = [
      fixture({ day: "2026-11-16", title: "first", at: "23:00", evidence: ["evidence/z.md", "evidence/a.md"] }),
      fixture({ day: "2026-11-17", kind: "memory", title: "second day", at: "12:00" }),
      fixture({ day: "2026-11-16", kind: "memory", title: "third", at: "01:00" }),
      fixture({ day: "2026-11-15", title: "third day" }),
    ];
    const groups = buildPlanDiary(entries);
    expect(groups.map(group => group.day)).toEqual(["2026-11-16", "2026-11-17", "2026-11-15"]);
    expect(groups.map(group => group.entries.map(entry => entry.title))).toEqual([
      ["first", "third"], ["second day"], ["third day"],
    ]);
    const root = renderPlanDiary(document, groups);
    expect(texts(root, ".diary-heading")).toEqual(groups.map(group => group.day));
    expect(texts(root, ".entry-title")).toEqual(["first", "third", "second day", "third day"]);
    expect(texts(required(root, "li.entry"), ".entry-evidence > li")).toEqual(["evidence/z.md", "evidence/a.md"]);
    expect(Array.from(root.querySelectorAll("li.entry"), node => node.getAttribute("data-kind")))
      .toEqual(["microtask", "memory", "memory", "microtask"]);
  });

  it.each([null, undefined, {}, "not an array"])("A4 malformed builder input %j is contained", input => {
    expect(buildPlanDiary(input as unknown as readonly DiaryEntryVM[])).toEqual([]);
  });

  it("A4 the render boundary contains throwing group/entry accessors", () => {
    const badGroup = { get day(): string { throw new Error("untrusted day"); }, entries: [] };
    const badEntry = { get kind(): string { throw new Error("untrusted kind"); } };
    for (const input of [[badGroup], [{ day: "2026-11-16", entries: [badEntry] }]]) {
      const call = () => renderPlanDiary(document, input as unknown as readonly DiaryDayGroupVM[]);
      expect(call).not.toThrow();
      expect(call().matches("section.diary")).toBe(true);
    }
  });

  it("A4 amendments preserve microtask/memory entries without synthesizing lifecycle entries", () => {
    const entries = [fixture(), fixture({ kind: "memory", title: "Decision", author: "reviewer-b" })];
    const groups = buildPlanDiary(entries);
    expect(groups.flatMap(group => group.entries)).toEqual(entries);
    const root = renderPlanDiary(document, groups);
    expect(texts(root, ".entry-title")).toEqual(entries.map(entry => entry.title));
    expect(Array.from(root.querySelectorAll("li.entry"), node => node.getAttribute("data-kind")))
      .toEqual(["microtask", "memory"]);
    expect(root.querySelectorAll('[data-kind="deployed"], [data-kind="finished"], [data-kind="failed"]')).toHaveLength(0);
    expect(root.querySelectorAll("li.entry")).toHaveLength(entries.length);
  });

  it.each(["10:05", ""])("A5 structure oracle accepts a control and rejects its unwrapped mutation (at=%j)", at => {
    // A disposable DOM control: production source is never patched by the oracle.
    const entry = document.createElement("li");
    entry.className = "entry";
    const time = document.createElement("time");
    time.className = "entry-time";
    time.textContent = at;
    const body = document.createElement("div");
    body.className = "entry-body";
    const title = document.createElement("p");
    title.className = "entry-title";
    title.textContent = "T01.M01";
    body.append(title);
    entry.append(time, body);
    expect(() => assertEntryStructure(entry)).not.toThrow();
    body.replaceWith(...body.childNodes);
    expect(title.parentElement).toBe(entry);
    expect(() => assertEntryStructure(entry)).toThrow();
  });
});
