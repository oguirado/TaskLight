import { afterEach, describe, expect, it } from "vitest";
import { vm, mkTask } from "./fixture";
import { attr, cleanup, click, mount, mountSpied, nth, q, qa, txt } from "./helpers";

afterEach(cleanup);

const wsBtns = (host: ParentNode) => qa<HTMLButtonElement>(host, "ul.workspaces > li > button.workspace");

describe("B4 workspaces", () => {
  it("one button.workspace per workspace inside ul.workspaces > li, in VM order", () => {
    const { host } = mount();
    const b = wsBtns(host);
    expect(b.length).toBe(3);
    expect(b.map((x) => txt(q(x, ".ws-name")))).toEqual(["Backend & API", "Notes mobile app", "Master's thesis"]);
    for (const x of b) {
      expect(attr(x, "type")).toBe("button");
      q(x, ".ws-dot");
      q(x, ".ws-text > .ws-name");
      q(x, ".ws-text > .ws-lens");
      q(x, ".ws-badges");
    }
  });

  it("aria-current=true only on vm.workspace; data-accent and data-lens on every button", () => {
    const { host } = mount(vm({ workspace: "w2" }));
    const b = wsBtns(host);
    expect(b.map((x) => attr(x, "aria-current"))).toEqual([null, "true", null]);
    expect(b.map((x) => attr(x, "data-accent"))).toEqual(["rose", "iris", "lagoon"]);
    expect(b.map((x) => attr(x, "data-lens"))).toEqual(["dev", "dev", "study"]);
  });

  it("ws-lens text is '<Development|Study> · <n> open' counting non-archived tasks only", () => {
    const { host } = mount();
    expect(qa(host, ".workspace .ws-lens").map(txt)).toEqual(["Development · 2 open", "Development · 1 open", "Study · 2 open"]);
  });

  it("archived tasks never count as open, and tasks of other workspaces do not leak", () => {
    const tasks = [mkTask("a", { archived: true }), mkTask("b", { archived: true }), mkTask("c"), mkTask("d", { workspace: "w2" })];
    const { host } = mount(vm({ tasks }));
    expect(qa(host, ".workspace .ws-lens").map(txt)).toEqual(["Development · 1 open", "Development · 1 open", "Study · 0 open"]);
  });

  it(".ws-running counts running tasks and is absent when 0", () => {
    const { host } = mount();
    const b = wsBtns(host);
    expect(txt(q(nth(b, 0), ".ws-running"))).toBe("1"); // t3
    expect(nth(b, 1).querySelector(".ws-running")).toBeNull(); // t2 waiting
    expect(txt(q(nth(b, 2), ".ws-running"))).toBe("1"); // t5
  });

  it(".ws-needs counts attention=now or status waiting|blocked and is absent when 0", () => {
    const { host } = mount();
    const b = wsBtns(host);
    expect(txt(q(nth(b, 0), ".ws-needs"))).toBe("1"); // t1 blocked/now
    expect(txt(q(nth(b, 1), ".ws-needs"))).toBe("1"); // t2 waiting
    expect(nth(b, 2).querySelector(".ws-needs")).toBeNull(); // t5 high running, t6 idle low
  });

  it("needs and running counts: mixed cases, archived excluded, each task counted once in needs", () => {
    const tasks = [
      mkTask("a", { attention: "now", status: "waiting" }),   // needs (once)
      mkTask("b", { attention: "now", status: "running" }),   // needs + running
      mkTask("c", { attention: "low", status: "blocked" }),   // needs
      mkTask("d", { attention: "high", status: "running" }),  // running only
      mkTask("e", { attention: "now", status: "blocked", archived: true }), // excluded
      mkTask("f", { status: "running", archived: true }),     // excluded
    ];
    const { host } = mount(vm({ tasks }));
    const w1 = nth(wsBtns(host), 0);
    expect(txt(q(w1, ".ws-needs"))).toBe("3");
    expect(txt(q(w1, ".ws-running"))).toBe("2");
  });

  it("badges carry an aria-label that includes the count", () => {
    const tasks = [mkTask("a", { status: "running" }), mkTask("b", { status: "running" }), mkTask("c", { status: "waiting" })];
    const { host } = mount(vm({ tasks }));
    const w1 = nth(wsBtns(host), 0);
    expect(attr(q(w1, ".ws-running"), "aria-label")).toMatch(/2/);
    expect(attr(q(w1, ".ws-needs"), "aria-label")).toMatch(/1/);
    expect(attr(q(w1, ".ws-running"), "aria-label")).toMatch(/running/i);
  });

  it(".rail-heading-meta shows '<n> running' across all workspaces (archived excluded)", () => {
    const { host } = mount();
    expect(txt(q(host, ".rail-heading-meta"))).toBe("2 running");
    const tasks = [mkTask("a", { status: "running" }), mkTask("b", { status: "running", workspace: "w3" }), mkTask("c", { status: "running", workspace: "w2" }), mkTask("d", { status: "running", archived: true })];
    const { host: h2 } = mount(vm({ tasks }));
    expect(txt(q(h2, ".rail-heading-meta"))).toBe("3 running");
  });

  it(".rail-heading-meta shows '0 running' when nothing runs", () => {
    const { host } = mount(vm({ tasks: [mkTask("a", { status: "idle" })] }));
    expect(txt(q(host, ".rail-heading-meta"))).toBe("0 running");
  });

  it("clicking a workspace calls onWorkspace(id) once and does not switch by itself", () => {
    const { host, spies } = mountSpied();
    click(nth(wsBtns(host), 2));
    expect(spies.onWorkspace.mock.calls).toEqual([["w3"]]);
    expect(attr(nth(wsBtns(host), 0), "aria-current")).toBe("true");
    expect(attr(q(host, ".app"), "data-workspace")).toBe("w1");
  });

  it("clicking inside the button (name span) still yields a single onWorkspace call", () => {
    const { host, spies } = mountSpied();
    click(q(nth(wsBtns(host), 1), ".ws-name"));
    expect(spies.onWorkspace.mock.calls).toEqual([["w2"]]);
  });

  it("button.ws-new calls onNewWorkspace() once and nothing else", () => {
    const { host, spies } = mountSpied();
    const b = q<HTMLButtonElement>(host, "button.ws-new");
    expect(attr(b, "type")).toBe("button");
    click(b);
    expect(spies.onNewWorkspace).toHaveBeenCalledTimes(1);
    expect(spies.onWorkspace).not.toHaveBeenCalled();
  });

  it("empty workspace list renders no workspace buttons but still the new-workspace button", () => {
    const { host } = mount(vm({ workspaces: [], workspace: "w1" }));
    expect(wsBtns(host).length).toBe(0);
    q(host, "button.ws-new");
  });

  it("ws-needs is independent of the wall filter: counts for non-selected workspaces too (view agenda)", () => {
    const { host } = mount(vm({ view: "agenda", workspace: "w3" }));
    expect(txt(q(nth(wsBtns(host), 0), ".ws-needs"))).toBe("1");
  });
});
