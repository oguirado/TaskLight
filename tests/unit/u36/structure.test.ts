import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE, vm } from "./fixture";
import { ALL_VIEWS, attr, cleanup, click, htmlAttrs, mount, mountSpied, nth, q, qa, txt, txts } from "./helpers";
import type { ViewId } from "../../../src/views/types";

afterEach(cleanup);

const tags = (e: Element): string[] => Array.from(e.children).map((c) => c.tagName.toLowerCase());

describe("B1 structure", () => {
  it("host receives exactly one .app element", () => {
    const { host } = mount();
    expect(host.children.length).toBe(1);
    expect(nth(Array.from(host.children), 0).classList.contains("app")).toBe(true);
  });

  it("app = aside.rail + main.main; main = header.topbar + section.focus + div.view (in this order)", () => {
    const { host } = mount();
    const app = q(host, ".app");
    expect(tags(app)).toEqual(["aside", "main"]);
    expect(nth(Array.from(app.children), 0).classList.contains("rail")).toBe(true);
    const main = nth(Array.from(app.children), 1);
    expect(main.classList.contains("main")).toBe(true);
    expect(tags(main)).toEqual(["header", "section", "div"]);
    const [top, focus, view] = Array.from(main.children);
    expect(top?.classList.contains("topbar")).toBe(true);
    expect(focus?.classList.contains("focus")).toBe(true);
    expect(view?.classList.contains("view")).toBe(true);
  });

  it.each(ALL_VIEWS)("root attributes on .app for view %s", (view) => {
    const { host } = mount(vm({ view, workspace: "w3", archiveScope: "all" }));
    const app = q(host, ".app");
    expect(attr(app, "data-view")).toBe(view);
    expect(attr(app, "data-workspace")).toBe("w3");
    expect(attr(app, "data-lens")).toBe("study");
    expect(attr(app, "data-archive-scope")).toBe("all");
  });

  it("data-lens follows the workspace lens (dev workspace)", () => {
    const { host } = mount(vm({ workspace: "w2" }));
    expect(attr(q(host, ".app"), "data-lens")).toBe("dev");
    expect(attr(q(host, ".app"), "data-archive-scope")).toBe("workspace");
  });

  it("document.documentElement is never touched (mount, update, interactions, destroy)", () => {
    const before = htmlAttrs();
    const cls = document.documentElement.className;
    const { host, handle, spies } = mountSpied(vm({ view: "wall" }));
    expect(htmlAttrs()).toEqual(before);
    handle.update(vm({ view: "archive", workspace: "w3", archiveScope: "all" }));
    click(q(host, "button.theme-toggle"));
    click(q(host, "button.nav-item"));
    expect(spies.onThemeToggle).toHaveBeenCalledTimes(1);
    expect(htmlAttrs()).toEqual(before);
    handle.destroy();
    expect(htmlAttrs()).toEqual(before);
    expect(document.documentElement.className).toBe(cls);
  });

  it("rail: brand, nav, heading, workspaces list, new-workspace button, status lines, theme toggle", () => {
    const { host } = mount();
    const rail = q(host, "aside.rail");
    expect(txt(q(rail, ".brand .brand-name"))).toBe("TaskLight");
    q(rail, ".brand > .brand-mark");
    q(rail, "nav.nav");
    expect(txt(q(rail, ".rail-heading > span"))).toBe("Workspaces");
    q(rail, ".rail-heading > .rail-heading-meta");
    q(rail, "ul.workspaces");
    q(rail, "button.ws-new > .ws-new-icon");
    expect(txt(q(rail, "button.ws-new"))).toBe("New workspace");
    q(rail, ".rail-status");
    expect(txt(q(rail, "button.theme-toggle"))).not.toBe("");
  });

  it("status lines: data-model and data-network with text", () => {
    const { host } = mount(vm({ model: { state: "downloading", label: "Downloading Gemini Nano 41 %" }, network: "offline" }));
    const model = q(host, '.status-line[data-model="downloading"]');
    expect(txt(q(model, ".status-text"))).toBe("Downloading Gemini Nano 41 %");
    q(model, ".status-dot");
    const net = q(host, '.status-line[data-network="offline"]');
    expect(txt(q(net, ".status-text"))).toMatch(/offline/i);
  });

  it("network online shows an online text", () => {
    const { host } = mount();
    expect(txt(q(host, '.status-line[data-network="online"] .status-text'))).toMatch(/online/i);
    expect(qa(host, '.status-line[data-network="offline"]').length).toBe(0);
  });

  it("topbar: view-eyebrow = workspace name, h1.view-title = view title, view-sub carries vm.now", () => {
    const titles: Record<ViewId, string> = { wall: "Wall", agenda: "Agenda", diary: "Diary", archive: "Archive" };
    for (const view of ALL_VIEWS) {
      const { host, handle } = mount(vm({ view }));
      const top = q(host, "header.topbar");
      expect(txt(q(top, ".topbar-titles > p.view-eyebrow"))).toBe("Backend & API");
      expect(txt(q(top, ".topbar-titles > h1.view-title"))).toBe(titles[view]);
      expect(txt(q(top, ".topbar-titles > p.view-sub"))).toContain(FIXTURE.now);
      handle.destroy();
    }
  });

  it("view-sub counts open (non-archived) tasks of the workspace and names the lens", () => {
    const { host } = mount(vm({ workspace: "w1" }));
    expect(txt(q(host, "p.view-sub"))).toMatch(/2 open/);
    expect(txt(q(host, "p.view-sub"))).toMatch(/Development/);
    const { host: h3 } = mount(vm({ workspace: "w3" }));
    expect(txt(q(h3, "p.view-sub"))).toMatch(/Study/);
  });
});

describe("B3 views and navigation", () => {
  it("renders four nav buttons with data-nav, aria-keyshortcuts 1-4 and kbd.nav-key", () => {
    const { host } = mount();
    const items = qa<HTMLButtonElement>(host, "nav.nav button.nav-item");
    expect(items.map((b) => attr(b, "data-nav"))).toEqual(["wall", "agenda", "diary", "archive"]);
    expect(items.map((b) => attr(b, "aria-keyshortcuts"))).toEqual(["1", "2", "3", "4"]);
    expect(items.map((b) => txt(q(b, "kbd.nav-key")))).toEqual(["1", "2", "3", "4"]);
    for (const b of items) {
      expect(b.tagName).toBe("BUTTON");
      expect(attr(b, "type")).toBe("button");
      q(b, ".nav-icon");
      expect(txt(q(b, ".nav-label"))).not.toBe("");
    }
  });

  it.each(ALL_VIEWS)("aria-current=page only on the active view (%s)", (view) => {
    const { host } = mount(vm({ view }));
    const cur = qa(host, "button.nav-item[aria-current]");
    expect(cur.length).toBe(1);
    expect(attr(nth(cur, 0), "data-nav")).toBe(view);
    expect(attr(nth(cur, 0), "aria-current")).toBe("page");
  });

  it.each([
    ["wall", "section.board"], ["agenda", "section.agenda"], ["diary", "section.diary"], ["archive", "section.archive"],
  ] as const)("view %s renders only %s inside div.view", (view, sel) => {
    const { host } = mount(vm({ view }));
    const v = q(host, "div.view");
    const present = ["section.board", "section.agenda", "section.diary", "section.archive"].filter((s) => v.querySelector(s));
    expect(present).toEqual([sel]);
    expect(Array.from(v.children).length).toBe(1);
  });

  it.each(ALL_VIEWS)("clicking nav %s calls onView with that id and does not change the view itself", (target) => {
    const { host, spies } = mountSpied(vm({ view: "wall" }));
    click(q(host, `button.nav-item[data-nav="${target}"]`));
    expect(spies.onView).toHaveBeenCalledTimes(1);
    expect(spies.onView).toHaveBeenCalledWith(target);
    expect(attr(q(host, ".app"), "data-view")).toBe("wall");
    expect(attr(q(host, "button.nav-item[aria-current]"), "data-nav")).toBe("wall");
    expect(qa(host, "section.board").length).toBe(1);
  });

  it("works without handlers (click does not throw)", () => {
    const { host } = mount();
    expect(() => click(q(host, 'button.nav-item[data-nav="agenda"]'))).not.toThrow();
  });

  it("clicking on the nav icon or label bubbles to a single onView call", () => {
    const { host, spies } = mountSpied();
    click(q(host, 'button.nav-item[data-nav="diary"] .nav-label'));
    expect(spies.onView.mock.calls).toEqual([["diary"]]);
  });

  it("nav labels are the view names", () => {
    const { host } = mount();
    expect(txts(host, "nav.nav .nav-label")).toEqual(["Wall", "Agenda", "Diary", "Archive"]);
  });
});

describe("B13 theme", () => {
  it("button.theme-toggle calls onThemeToggle() once, with no argument, and nothing else", () => {
    const { host, spies } = mountSpied();
    const b = q<HTMLButtonElement>(host, "button.theme-toggle");
    expect(attr(b, "type")).toBe("button");
    click(b);
    expect(spies.onThemeToggle).toHaveBeenCalledTimes(1);
    expect(spies.onThemeToggle.mock.calls[0]).toEqual([]);
    expect(spies.onView).not.toHaveBeenCalled();
    expect(spies.onWorkspace).not.toHaveBeenCalled();
    expect(spies.onArchiveScope).not.toHaveBeenCalled();
    expect(spies.onRestore).not.toHaveBeenCalled();
    expect(spies.onNewWorkspace).not.toHaveBeenCalled();
  });

  it("does not set data-theme itself (host owns the theme)", () => {
    const { host } = mountSpied();
    click(q(host, "button.theme-toggle"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(q(host, ".app").hasAttribute("data-theme")).toBe(false);
  });

  it("works without handlers", () => {
    const { host } = mount();
    expect(() => click(q(host, "button.theme-toggle"))).not.toThrow();
  });
});
