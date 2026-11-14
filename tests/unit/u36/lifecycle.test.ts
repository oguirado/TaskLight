import { afterEach, describe, expect, it, vi } from "vitest";
import { frozenFixture, mkTask, vm, withTasks } from "./fixture";
import { attr, cardIds, cleanup, click, htmlAttrs, key, mount, mountSpied, q, qa, txt } from "./helpers";

afterEach(cleanup);

/* Records every listener registration on any EventTarget (prototype level) and returns what is still live. */
interface Reg { target: EventTarget; type: string; fn: unknown; capture: boolean }
function recorder() {
  const regs: Reg[] = [];
  const cap = (o: unknown): boolean => (typeof o === "boolean" ? o : typeof o === "object" && o !== null && "capture" in o ? Boolean((o as { capture?: boolean }).capture) : false);
  const proto = EventTarget.prototype;
  const add = proto.addEventListener, rem = proto.removeEventListener;
  const sa = vi.spyOn(proto, "addEventListener").mockImplementation(function (this: EventTarget, t: string, f: unknown, o?: unknown) {
    if (f) regs.push({ target: this, type: t, fn: f, capture: cap(o) });
    return add.call(this, t, f as EventListenerOrEventListenerObject, o as AddEventListenerOptions);
  });
  const sr = vi.spyOn(proto, "removeEventListener").mockImplementation(function (this: EventTarget, t: string, f: unknown, o?: unknown) {
    const i = regs.findIndex((r) => r.target === this && r.type === t && r.fn === f && r.capture === cap(o));
    if (i >= 0) regs.splice(i, 1);
    return rem.call(this, t, f as EventListenerOrEventListenerObject, o as EventListenerOptions);
  });
  return { regs, sa, sr, outside: (host: Node) => regs.filter((r) => !(r.target instanceof Node) || r.target === host || !host.contains(r.target as Node)) };
}

describe("B14 update re-renders", () => {
  it("update(vm) shows the new view, workspace, tasks and root attributes", () => {
    const { host, handle } = mount();
    expect(cardIds(host)).toEqual(["t1", "t3"]);
    handle.update(vm({ workspace: "w3", view: "wall" }));
    expect(cardIds(host)).toEqual(["t5", "t6"]);
    expect(attr(q(host, ".app"), "data-workspace")).toBe("w3");
    expect(attr(q(host, ".app"), "data-lens")).toBe("study");
    handle.update(vm({ view: "archive", archiveScope: "all" }));
    expect(attr(q(host, ".app"), "data-view")).toBe("archive");
    expect(qa(host, "li.archived").length).toBe(4);
    expect(host.querySelector("section.board")).toBeNull();
  });

  it("host keeps exactly one .app after repeated updates (no duplicated trees)", () => {
    const { host, handle } = mount();
    for (let i = 0; i < 5; i++) handle.update(vm({ view: i % 2 ? "wall" : "agenda" }));
    expect(host.children.length).toBe(1);
    expect(qa(host, ".app").length).toBe(1);
    expect(qa(host, "aside.rail").length).toBe(1);
    expect(qa(host, "button.nav-item").length).toBe(4);
  });

  it("update reflects changed task fields, status and removed tasks", () => {
    const { host, handle } = mount(withTasks([mkTask("a", { title: "Old" }), mkTask("b")]));
    handle.update(withTasks([mkTask("a", { title: "New", status: "failed" })]));
    expect(cardIds(host)).toEqual(["a"]);
    expect(txt(q(host, "h2.task-title"))).toBe("New");
    expect(txt(q(host, "span.status-label"))).toBe("Failed");
  });

  it("update changes the rail counts and status lines", () => {
    const { host, handle } = mount();
    handle.update(vm({ tasks: [], network: "offline", model: { state: "unavailable", label: "No model" } }));
    expect(txt(q(host, ".rail-heading-meta"))).toBe("0 running");
    expect(host.querySelector('[data-network="offline"]')).not.toBeNull();
    expect(txt(q(host, '[data-model="unavailable"] .status-text'))).toBe("No model");
    expect(host.querySelector(".ws-running")).toBeNull();
  });

  it("does not mutate the VM: a deeply frozen VM mounts and updates without error", () => {
    const f = frozenFixture();
    expect(() => {
      const { handle } = mount(f);
      handle.update(f);
      handle.update({ ...f, view: "diary" });
    }).not.toThrow();
  });

  it("after update(), handlers still fire exactly once per interaction (no listener accumulation)", () => {
    const { host, handle, spies } = mountSpied();
    for (let i = 0; i < 4; i++) handle.update(vm());
    click(q(host, 'button.nav-item[data-nav="agenda"]'));
    click(q(host, "button.theme-toggle"));
    click(q(host, "button.ws-new"));
    click(q(host, "button.workspace"));
    key(document.body, "3");
    expect(spies.onView.mock.calls).toEqual([["agenda"], ["diary"]]);
    expect(spies.onThemeToggle).toHaveBeenCalledTimes(1);
    expect(spies.onNewWorkspace).toHaveBeenCalledTimes(1);
    expect(spies.onWorkspace).toHaveBeenCalledTimes(1);
  });

  it("step toggling toggles once after several updates", () => {
    const { host, handle } = mount();
    for (let i = 0; i < 3; i++) handle.update(vm());
    const row = q(host, "button.step-row");
    click(row);
    expect(attr(row, "aria-expanded")).toBe("true");
  });

  it("the document keydown listener is registered once and stays at one across updates", () => {
    const r = recorder();
    const { host, handle } = mount();
    const count = () => r.outside(host).filter((x) => x.type === "keydown").length;
    expect(count()).toBe(1);
    for (let i = 0; i < 5; i++) handle.update(vm({ view: i % 2 ? "wall" : "diary" }));
    expect(count()).toBe(1);
  });

  it("listeners outside the app subtree do not grow with update()", () => {
    const r = recorder();
    const { host, handle } = mount();
    const base = r.outside(host).length;
    for (let i = 0; i < 6; i++) handle.update(vm({ view: (["wall", "agenda", "diary", "archive"] as const)[i % 4] ?? "wall" }));
    expect(r.outside(host).length).toBe(base);
  });
});

describe("B14 / B12 listener cleanup on host.ownerDocument", () => {
  it("spy on ownerDocument: exactly the added keydown listener(s) are removed by destroy() with the same function and capture flag", () => {
    const add = vi.spyOn(document, "addEventListener");
    const rem = vi.spyOn(document, "removeEventListener");
    const { handle } = mount();
    const added = add.mock.calls.filter((c) => c[0] === "keydown");
    expect(added.length).toBe(1);
    expect(rem.mock.calls.filter((c) => c[0] === "keydown").length).toBe(0);
    handle.update(vm({ view: "diary" }));
    handle.update(vm({ view: "archive" }));
    expect(add.mock.calls.filter((c) => c[0] === "keydown").length).toBe(1);
    expect(rem.mock.calls.filter((c) => c[0] === "keydown").length).toBe(0);
    handle.destroy();
    const removed = rem.mock.calls.filter((c) => c[0] === "keydown");
    expect(removed.length).toBe(1);
    const cap = (o: unknown) => (typeof o === "boolean" ? o : typeof o === "object" && o !== null ? Boolean((o as { capture?: boolean }).capture) : false);
    expect(removed[0]?.[1]).toBe(added[0]?.[1]);
    expect(cap(removed[0]?.[2])).toBe(cap(added[0]?.[2]));
  });

  it("after destroy() nothing registered outside the app subtree is left on any target", () => {
    const r = recorder();
    const { host, handle } = mount();
    handle.update(vm({ view: "agenda" }));
    expect(r.outside(host).length).toBeGreaterThan(0);
    handle.destroy();
    expect(r.outside(host)).toEqual([]);
  });

  it("destroy() on a document other than the global one cleans that document", () => {
    const other = document.implementation.createHTMLDocument("o");
    const add = vi.spyOn(other, "addEventListener");
    const rem = vi.spyOn(other, "removeEventListener");
    const { handle } = mount(vm(), {}, other);
    expect(add.mock.calls.filter((c) => c[0] === "keydown").length).toBe(1);
    handle.destroy();
    expect(rem.mock.calls.filter((c) => c[0] === "keydown").length).toBe(1);
  });

  it("window-level listeners (resize, matchMedia...) are not leaked either", () => {
    const r = recorder();
    const { handle } = mount();
    handle.destroy();
    expect(r.regs.filter((x) => x.target === window)).toEqual([]);
  });

  it("mount/destroy cycles leave no listeners behind", () => {
    const r = recorder();
    for (let i = 0; i < 5; i++) {
      const { host, handle } = mount();
      handle.update(vm({ view: "archive" }));
      handle.destroy();
      expect(r.outside(host)).toEqual([]);
    }
  });
});

describe("B14 destroy", () => {
  it("empties host", () => {
    const { host, handle } = mount();
    expect(host.childNodes.length).toBeGreaterThan(0);
    handle.destroy();
    expect(host.childNodes.length).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("keyboard shortcuts stop after destroy()", () => {
    const { handle, spies } = mountSpied();
    key(document.body, "1");
    expect(spies.onView).toHaveBeenCalledTimes(1);
    handle.destroy();
    key(document.body, "1");
    key(document.body, "2");
    expect(spies.onView).toHaveBeenCalledTimes(1);
  });

  it("clicks on detached old nodes call no handler after destroy()", () => {
    const { host, handle, spies } = mountSpied();
    const nav = q(host, 'button.nav-item[data-nav="diary"]');
    const ws = q(host, "button.workspace");
    const theme = q(host, "button.theme-toggle");
    const wsNew = q(host, "button.ws-new");
    handle.destroy();
    for (const b of [nav, ws, theme, wsNew]) click(b);
    expect(spies.onView).not.toHaveBeenCalled();
    expect(spies.onWorkspace).not.toHaveBeenCalled();
    expect(spies.onThemeToggle).not.toHaveBeenCalled();
    expect(spies.onNewWorkspace).not.toHaveBeenCalled();
  });

  it("update() after destroy() is a no-op: host stays empty, no throw, no new listeners", () => {
    const r = recorder();
    const { host, handle } = mount();
    handle.destroy();
    const n = r.regs.length;
    expect(() => handle.update(vm({ view: "agenda" }))).not.toThrow();
    expect(host.childNodes.length).toBe(0);
    expect(r.regs.length).toBe(n);
  });

  it("destroy() twice does not throw", () => {
    const { handle } = mount();
    handle.destroy();
    expect(() => handle.destroy()).not.toThrow();
  });

  it("destroy() does not touch documentElement and leaves host itself in the document", () => {
    const before = htmlAttrs();
    const { host, handle } = mount();
    handle.destroy();
    expect(htmlAttrs()).toEqual(before);
    expect(document.body.contains(host)).toBe(true);
  });

  it("a new mountWall on the same (emptied) host works after destroy()", () => {
    const { host, handle } = mount();
    handle.destroy();
    const { handle: h2 } = mount(vm({ view: "agenda" }));
    expect(h2).toBeDefined();
    expect(host.childNodes.length).toBe(0);
  });
});
