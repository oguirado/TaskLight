// Repair loop 1 regressions from the cross-family review of U36 (strategy/flights/U36/review_sol). See ORACLE.md "Repair loop 1".
import { afterEach, describe, expect, it } from "vitest";
import type { TaskVM, WallVM } from "../../../src/views/types";
import { mkDone, mkTask, ms, vm, withTasks, WORKSPACES } from "./fixture";
import { cleanup, key, mount, mountSpied } from "./helpers";

afterEach(cleanup);

const detailTask = (): TaskVM => mkTask("t1", {
  steps: [mkDone("Port handlers", "Today 09:20", ms(13, 9, 20), "Today", {
    took: "12 min", detail: { outcome: "done", evidence: ["e1"], source: { kind: "device", ms: 100 } },
  })],
});

describe("R1 inherited lookup keys never crash (B15)", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("status %s with attention now renders without throwing", (s) => {
    const t = mkTask("t1", { status: s as TaskVM["status"], attention: "now", steps: [] });
    expect(() => mount(withTasks([t], { view: "wall" }))).not.toThrow();
  });
  it("step state and attention inherited keys do not throw either", () => {
    const t = mkTask("t1", { attention: "constructor" as TaskVM["attention"],
      steps: [{ label: "x", state: "toString" as never }] });
    expect(() => mount(withTasks([t], { view: "wall" }))).not.toThrow();
  });
});

describe("R2 JSON-produced objects in string fields never throw (B15)", () => {
  it("title {toString:null} from JSON.parse renders without throwing", () => {
    const t = { ...mkTask("t1"), title: JSON.parse('{"toString": null}') } as unknown as TaskVM;
    expect(() => mount(withTasks([t], { view: "wall" }))).not.toThrow();
  });
  it("summary {valueOf:null,toString:null} does not throw on update either", () => {
    const { handle } = mount(withTasks([mkTask("t1")]));
    const t = { ...mkTask("t1"), summary: JSON.parse('{"valueOf": null, "toString": null}') } as unknown as TaskVM;
    expect(() => handle.update(withTasks([t]))).not.toThrow();
  });
});

describe("R3 two mounted walls are independent (B6)", () => {
  it("expanding a step in the second host opens its own panel only", () => {
    const v: WallVM = withTasks([detailTask()], { view: "wall" });
    const a = mount(v); const b = mount(v);
    const btnB = b.host.querySelector<HTMLButtonElement>("button.step-row")!;
    btnB.click();
    const panelB = btnB.closest("li.step")!.querySelector<HTMLElement>(".step-detail")!;
    const panelA = a.host.querySelector<HTMLElement>(".step-detail")!;
    expect(btnB.getAttribute("aria-expanded")).toBe("true");
    expect(panelB.hidden).toBe(false);
    expect(panelA.hidden).toBe(true);
    const ctl = btnB.getAttribute("aria-controls")!;
    expect(panelB.id).toBe(ctl);
    expect(a.host.querySelector<HTMLButtonElement>("button.step-row")!.getAttribute("aria-controls")).not.toBe(ctl);
  });
});

describe("R4 keys typed inside contenteditable descendants are ignored (B12)", () => {
  it("span inside contenteditable=true", () => {
    const { spies } = mountSpied();
    const ed = document.createElement("div"); ed.setAttribute("contenteditable", "true");
    const span = document.createElement("span"); ed.appendChild(span); document.body.appendChild(ed);
    key(span, "2");
    expect(spies.onView).not.toHaveBeenCalled();
    ed.remove();
  });
  it("a contenteditable=false island inside an editor is not editing: keys work there", () => {
    const { spies } = mountSpied();
    const ed = document.createElement("div"); ed.setAttribute("contenteditable", "true");
    const island = document.createElement("div"); island.setAttribute("contenteditable", "false");
    const span = document.createElement("span"); island.appendChild(span); ed.appendChild(island); document.body.appendChild(ed);
    key(span, "3");
    expect(spies.onView.mock.calls).toEqual([["diary"]]);
    ed.remove();
  });
});

describe("R5 unknown workspace renders an empty wall (B15)", () => {
  it("tasks whose workspace equals the unknown id are not shown", () => {
    const ghost = mkTask("g1", { workspace: "ghost" });
    const { host } = mount(vm({ workspaces: [WORKSPACES[0]!], workspace: "ghost", tasks: [ghost], view: "wall" }));
    expect(host.querySelectorAll("article.task").length).toBe(0);
    expect(host.querySelector("button.workspace")!.getAttribute("aria-current")).toBe("true");
  });
});
