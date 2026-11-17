import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMemoryView } from "../../../src/views/memory";
import { mountWall } from "../../../src/views/index";
import { renderPlanDiary } from "../../../src/views/plan";
import { activate, assertCommand, COMMAND, commandText, EXPECTED, fixture, HOSTILE, MALFORMED_ROOM,
  makeStore, memory, memoryOp, noNetwork, NOW, op, phaseWall, projection, python, text, wall } from "./oracle";
import type { History, Memory } from "./oracle";

let denied: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); denied = noNetwork(); });
afterEach(() => {
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const render = (value: Memory = memory({ goal: EXPECTED })): HTMLElement => {
  const root = renderMemoryView(document, value); document.body.append(root); return root;
};
function disclosure(root: HTMLElement): HTMLDetailsElement {
  const details = [...root.querySelectorAll("details")].find(d => text(d.querySelector("summary")!) === "History");
  expect(details, "native details/summary labelled History for the section").toBeDefined();
  return details!;
}

describe("U126 Memory history disclosure", () => {
  it("A1 A3 M3 renders native History with newest-first revision, author, timestamp and full text", () => {
    const root = render(); const details = disclosure(root); details.open = true;
    expect(text(details)).toContain("Retained history — newest first");
    expect(text(details)).toMatch(/(?:revision|rev)\s*[:#]?\s*9\b/i);
    expect(text(details)).toMatch(/(?:revision|rev)\s*[:#]?\s*5\b/i);
    for (const value of ["bob", "alice", "new", "old"]) expect(text(details)).toContain(value);
    expect(text(details).lastIndexOf("new")).toBeLessThan(text(details).lastIndexOf("old"));
    for (const version of EXPECTED) {
      const iso = new Date(version.ts).toISOString();
      expect(text(details).includes(String(version.ts)) || text(details).includes(iso) ||
        text(details).includes(iso.replace(".000Z", "Z")) || text(details).includes(iso.replace("Z", "+00:00"))).toBe(true);
    }
    expect(root.querySelector(".memory-text")?.textContent).toBe("new");
  });
  it("A3 M3 missing history metadata says History unavailable", () => {
    expect(text(render(memory()))).toContain("History unavailable");
  });
  it("A3 M3 missing section history differs from an explicitly empty retained array", () => {
    const unknown = render(memory({}));
    expect(text(unknown)).toContain("History unavailable");
    const empty = render(memory({ goal: [] }));
    expect(text(empty)).toContain("No retained versions");
    expect(text(empty)).not.toContain("History unavailable");
    expect(text(empty)).not.toMatch(/complete (?:server )?history|all (?:server )?versions/i);
  });
  it("M3 each rendered section has its own History disclosure", () => {
    const m = memory({ goal: EXPECTED, notes: [] });
    m.sections = [...m.sections, { id: "notes", label: "Notes", text: "", required: true, empty: true, rev: 0, maxChars: 2000 }];
    const root = render(m);
    expect([...root.querySelectorAll("details > summary")].map(text)).toEqual(["History", "History"]);
    expect(root.querySelector('[data-section-id="goal"] details')?.textContent).toContain("old");
    expect(root.querySelector('[data-section-id="notes"] details')?.textContent).toContain("No retained versions");
    expect(root.querySelector('[data-section-id="notes"] details')?.textContent).not.toContain("old");
  });
  it("M3 History summary is natively focusable and can be activated by the keyboard model", () => {
    const root = render(); const details = disclosure(root); const summary = details.querySelector("summary")!;
    expect(details.open).toBe(false);
    activate(summary, true); expect(details.open).toBe(true);
    activate(summary, true); expect(details.open).toBe(false);
    expect(denied).not.toHaveBeenCalled();
  });
  it("M3 historical text preserves full lines and selectable contents", () => {
    const full = "full retained line\n".repeat(100);
    const root = render(memory({ goal: [{ rev: 1, by: "alice", ts: 5000, text: full }] }));
    const details = disclosure(root); details.open = true;
    expect(details.textContent).toContain(full);
    const range = document.createRange(); range.selectNodeContents(details);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    expect(selection.toString()).toContain(full); selection.removeAllRanges();
  });
  it("M3 M6 preserves current text, revision explanation, author/time and required-empty flags", () => {
    const m = memory(); m.sections = [
      ...m.sections, { id: "required", label: "Required section", text: "", required: true, empty: true, rev: 0, maxChars: 2000 },
    ];
    const root = render(m);
    expect(root.querySelector(".memory-text")?.textContent).toBe("new");
    expect(text(root)).toContain("Revision 9"); expect(text(root)).toContain("bob");
    expect(text(root)).toContain("1970-01-01T00:00:01.000Z");
    expect(text(root)).toContain("Room log position of this section's last accepted update");
    expect(root.querySelector('[data-required-empty="true"]')?.textContent).toContain("Required — empty");
  });
  it("A4 accepted hostile memory text is literal in both current and historical content", () => {
    const events = [memoryOp(5, 0, HOSTILE, { ts: 5000 })]; const store = makeStore(events);
    expect(python(events)["versions"]).toEqual([{ rev: 5, by: "alice", ts: 5000, text: HOSTILE }]);
    const root = render(wall(store).memory as Memory);
    expect(root.querySelector(".memory-text")?.textContent).toBe(HOSTILE);
    const history = disclosure(root); history.open = true;
    expect(history.textContent).toContain(HOSTILE);
    expect(root.querySelector("img, script, iframe, svg")).toBeNull(); expect(denied).not.toHaveBeenCalled();
  });
  it("A4 Amendment B hostile history author and section label use text nodes", () => {
    const m = memory({ goal: [{ rev: 9, by: HOSTILE, ts: 1000, text: "new" }] });
    m.sections = [{ ...m.sections[0]!, label: HOSTILE, by: HOSTILE }];
    const root = render(m); const details = disclosure(root); details.open = true;
    expect(details.textContent).toContain(HOSTILE); expect(root.querySelector(".memory-label")?.textContent).toBe(HOSTILE);
    expect(root.querySelector("img, script, svg, iframe")).toBeNull();
    for (const node of root.querySelectorAll("*")) expect([...node.attributes].some(a => /^on/i.test(a.name))).toBe(false);
    expect(denied).not.toHaveBeenCalled();
  });
  it.each([null, 7, "forged", {}, { goal: null }, { goal: {} }, { goal: [null, 7, {}] },
    { goal: [{ rev: "999", by: "fake-author", ts: "yesterday", text: "fabricated-version" }] },
    { goal: [{ rev: NaN, by: "fake-author", ts: Infinity, text: "fabricated-version" }] },
  ])("A4 malformed history %j never throws or fabricates versions", history => {
    const m = { ...memory(), history } as unknown as Memory;
    let root: HTMLElement | undefined;
    expect(() => { root = render(m); }).not.toThrow();
    expect(root).toBeDefined();
    expect(text(root!)).not.toContain("fabricated-version");
    expect(text(root!)).not.toMatch(/Revision (?:undefined|null|NaN|999)/);
    expect(root!.querySelector(".memory-text")?.textContent).toBe("new");
  });
  it("A4 Amendment B __proto__ section key is rejected without polluting history", () => {
    const events = [...fixture(), op(12, { kind: "memory.set", section: "__proto__", text: "fabricated-version", base_rev: 0 })];
    const store = makeStore(fixture());
    expect(store.ingestChecked(events.at(-1))).toBe("invalid");
    expect(python(events)["versions"]).toEqual(EXPECTED);
    expect(Object.hasOwn(projection(store).projection.memory, "__proto__")).toBe(false);
    expect(Object.prototype).not.toHaveProperty("text");
    const histories = JSON.parse('{"__proto__":[{"rev":999,"by":"fake-author","ts":1,"text":"fabricated-version"}]}') as History;
    const m = memory(histories); m.sections = [...m.sections, { id: "__proto__", label: "__proto__", text: "", required: false, empty: true, rev: 0, maxChars: 2000 }];
    expect(() => render(m)).not.toThrow();
    expect(Object.prototype).not.toHaveProperty("text");
    // The unrelated goal must not inherit a version from another key.
    const root = render(memory(histories));
    expect(root.textContent).not.toContain("fabricated-version");
    expect(text(root)).toContain("History unavailable");
  });
  it("A4 malformed inherited history never turns an absent own section into a version", () => {
    const histories = Object.create({ goal: [{ rev: 999, by: "fake-author", ts: 1, text: "fabricated-version" }] }) as History;
    const root = render(memory(histories));
    expect(text(root)).not.toContain("fabricated-version");
    expect(text(root)).toContain("History unavailable");
  });
});

describe("U126 read-only export guidance", () => {
  it("A6 M4 demo produces exactly the documented command with only the documented JSON keys", () => {
    const root = render(); assertCommand(root, COMMAND);
    const command = commandText(root)!;
    expect(JSON.parse(command.slice(command.indexOf("--json '") + 8, -1))).toEqual({ room: "demo", agent: "worker-a", what: "memory" });
    expect(text(root)).toContain("CW_HOME"); expect(text(root)).toMatch(/configured checkout/i);
    expect(text(root)).toMatch(/Markdown/);
    expect(text(root)).toMatch(/(?:does not|will not|won't|not|no).*sav|sav.*not.*automatic/i);
    expect(text(root)).not.toMatch(/download (?:complete|successful)|downloaded|file saved/i);
    expect(root.querySelector("a[download]")).toBeNull();
  });
  it.each([undefined, "", MALFORMED_ROOM, "Demo", "demo_room", "-demo", "a".repeat(49)])(
    "A4 A6 M4 invalid or missing room %j has Command unavailable and no command", room => {
      const m = memory(); if (room === undefined) delete m.room; else m.room = room;
      const root = render(m); assertCommand(root, undefined); expect(denied).not.toHaveBeenCalled();
    });
  it.each(["d", "demo-2", "a".repeat(48)])("M4 validated boundary slug %s is the only substituted command value", room => {
    const root = render(memory({ goal: EXPECTED }, room));
    assertCommand(root, COMMAND.replace('"demo"', JSON.stringify(room)));
  });
  it("M4 absent memory renders Command unavailable without an executable string", () => {
    const root = renderMemoryView(document, undefined); assertCommand(root, undefined);
  });
  it("M4 a selected room can export memory even when it has no sections or active plan", () => {
    const root = render({ room: "demo", sections: [] }); assertCommand(root, COMMAND);
    expect(root.querySelector("img, iframe")).toBeNull();
  });
  it("A6 command is selectable and any textbox is read-only", () => {
    const root = render(); assertCommand(root, COMMAND);
    const field = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].find(n => n.value === COMMAND);
    if (field) {
      expect(field.readOnly).toBe(true); expect(field.disabled).toBe(false);
      field.focus(); field.select(); expect(field.value.slice(field.selectionStart!, field.selectionEnd!)).toBe(COMMAND);
    } else {
      const node = [...root.querySelectorAll<HTMLElement>("*")].reverse().find(n => n.textContent?.trim() === COMMAND);
      expect(node).toBeDefined();
      expect(node!.isContentEditable).not.toBe(true);
      const range = document.createRange(); range.selectNodeContents(node!);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      expect(selection.toString().trim()).toBe(COMMAND); selection.removeAllRanges();
    }
    root.dispatchEvent(new Event("copy", { bubbles: true })); expect(denied).not.toHaveBeenCalled();
  });
  it("A6 documented CLI returns the existing untrusted Markdown envelope without appending", () => {
    const output = python(fixture(), { cli: true, args: { room: "demo", agent: "worker-a", what: "memory" } });
    expect(Object.keys(output)).toEqual(["untrusted"]);
    expect(output["untrusted"]).toMatchObject({ format: "markdown", rev: 9 });
    expect(Object.keys(output["untrusted"] as object).sort()).toEqual(["format", "rev", "text"]);
    const result = output["untrusted"] as { text: string };
    expect(result.text).toContain("new"); expect(result.text).toContain("goal");
  });
  it("A6 switching rooms replaces the command and removes previous room versions in the mounted Memory view", () => {
    const store = makeStore([...fixture(), memoryOp(30, 0, "secret", { room: "other" })]);
    const host = document.createElement("div"); document.body.append(host);
    const handle = mountWall(host, wall(store));
    try {
      assertCommand(host, COMMAND);
      expect(host.textContent).toContain("old"); expect(host.textContent).not.toContain("secret");
      handle.update(wall(store, "other"));
      assertCommand(host, COMMAND.replace('"demo"', '"other"'));
      expect(host.textContent).toContain("secret"); expect(host.textContent).not.toContain("old");
      expect(commandText(host)).not.toContain('"demo"');
    } finally { handle.destroy(); }
  });
  it("M6 keeps the U106 Diary body and read-only task detail delegation intact", () => {
    const diary = renderPlanDiary(document, [{ day: "2026-11-17", entries: [{ kind: "microtask", day: "2026-11-17",
      at: "09:00", title: "T01.M01", outcome: "Verified", author: "alice", evidence: ["proof.txt"], took: "1m" }] }]);
    expect(diary.querySelector(".entry-outcome")?.textContent).toContain("Verified");
    expect(text(diary)).toContain("alice"); expect(text(diary)).toContain("proof.txt");
    const vm = phaseWall(); vm.tasks = [{ ...vm.tasks[0]!, steps: [{ label: "Inspect", state: "done", microId: "T01.M01",
      detail: { outcome: "Verified", evidence: ["proof.txt"], source: { kind: "rules", ms: 0 } } }] }];
    const host = document.createElement("div"); document.body.append(host);
    const handle = mountWall(host, vm);
    try {
      const detail = host.querySelector<HTMLButtonElement>('button[data-micro-id="T01.M01"]');
      expect(detail).not.toBeNull(); detail!.click();
      expect(detail!.getAttribute("aria-expanded")).toBe("true"); expect(host.textContent).toContain("Verified");
    } finally { handle.destroy(); }
  });
});
