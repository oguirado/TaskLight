import { describe, it, expect, beforeEach, vi } from "vitest";
import { createKeyboardNav } from "../../../src/ui/keyboard";
import { ids, makeCard } from "./helpers";

let nodes: Map<string, HTMLElement>; let onOpen: ReturnType<typeof vi.fn<(id: string) => void>>;
const setup = (n: number) => {
  document.body.replaceChildren();
  nodes = new Map();
  for (const id of ids(n)) { const c = makeCard(id); document.body.appendChild(c); nodes.set(id, c); }
  onOpen = vi.fn<(id: string) => void>();
  const nav = createKeyboardNav({ nodeOf: (id) => nodes.get(id) ?? null }, onOpen);
  return nav;
};
const zeros = () => [...nodes.values()].filter((n) => n.getAttribute("tabindex") === "0").length;
const all = () => [...nodes.values()].every((n) => n.getAttribute("tabindex") === "0" || n.getAttribute("tabindex") === "-1");

describe("U20 keyboard nav (B12, B13)", () => {
  it("roving tabindex: exactly one 0 right after setOrder (first card)", () => {
    const nav = setup(12); nav.setOrder(ids(12), 4);
    expect(zeros()).toBe(1); expect(all()).toBe(true);
    expect(nodes.get("p1")!.getAttribute("tabindex")).toBe("0");
  });
  it("O8 walkthrough: ArrowRight x11 visits all 12 in order, one tabindex=0 each step; Down clamps; Home/End; Enter opens last", () => {
    const nav = setup(12); nav.setOrder(ids(12), 4);
    nodes.get("p1")!.focus(); // Tab lands on the tabindex=0 card
    expect(document.activeElement).toBe(nodes.get("p1"));
    expect(nav.focused()).toBe("p1"); // cursor starts on the tabindex=0 card
    nav.handleKey("ArrowRight");
    const visited = ["p2"];
    expect(nav.focused()).toBe("p2");
    for (let i = 0; i < 10; i++) { nav.handleKey("ArrowRight"); visited.push(nav.focused()!); expect(zeros()).toBe(1); }
    expect(visited).toEqual(ids(12).slice(1));
    expect(document.activeElement).toBe(nodes.get("p12"));
    nav.handleKey("ArrowRight"); expect(nav.focused()).toBe("p12"); // clamp, no wrap
    nav.handleKey("ArrowDown"); expect(nav.focused()).toBe("p12");
    nav.handleKey("Home"); expect(nav.focused()).toBe("p1"); expect(zeros()).toBe(1);
    nav.handleKey("End"); expect(nav.focused()).toBe("p12");
    nav.handleKey("Enter");
    expect(onOpen).toHaveBeenCalledTimes(1); expect(onOpen).toHaveBeenCalledWith("p12");
  });
  it("Up/Down move by columns; Left clamps at start; no wrap", () => {
    const nav = setup(12); nav.setOrder(ids(12), 4);
    nav.handleKey("Home");
    nav.handleKey("ArrowDown"); expect(nav.focused()).toBe("p5");
    nav.handleKey("ArrowDown"); expect(nav.focused()).toBe("p9");
    nav.handleKey("ArrowDown"); expect(nav.focused()).toBe("p9"); // would be 13: clamp (no partial row jump)
    nav.handleKey("ArrowUp"); expect(nav.focused()).toBe("p5");
    nav.handleKey("Home"); nav.handleKey("ArrowLeft"); expect(nav.focused()).toBe("p1");
    nav.handleKey("ArrowUp"); expect(nav.focused()).toBe("p1");
  });
  it("columns above GRID_COLUMNS_MAX (4) are clamped to 4", () => {
    const nav = setup(12); nav.setOrder(ids(12), 9);
    nav.handleKey("Home"); nav.handleKey("ArrowDown"); expect(nav.focused()).toBe("p5");
  });
  it("unknown keys do nothing", () => {
    const nav = setup(3); nav.setOrder(ids(3), 3);
    nav.handleKey("x"); nav.handleKey("Tab"); expect(onOpen).not.toHaveBeenCalled();
    expect(nav.focused()).toBe("p1"); expect(zeros()).toBe(1);
  });
  it("empty order: no throw, focused() null", () => {
    const nav = setup(0); nav.setOrder([], 4);
    expect(() => { nav.handleKey("ArrowRight"); nav.handleKey("Enter"); }).not.toThrow();
    expect(nav.focused()).toBeNull();
  });
  it("B13: focused card removed from the order -> focus moves to the next, else previous", () => {
    const nav = setup(12); nav.setOrder(ids(12), 4);
    nav.handleKey("Home"); for (let i = 0; i < 4; i++) nav.handleKey("ArrowRight");
    expect(nav.focused()).toBe("p5");
    nodes.get("p5")!.remove(); nodes.delete("p5");
    nav.setOrder(ids(12).filter((x) => x !== "p5"), 4);
    expect(nav.focused()).toBe("p6"); expect(document.activeElement).toBe(nodes.get("p6")); expect(zeros()).toBe(1);
    nav.handleKey("End"); nodes.get("p12")!.remove(); nodes.delete("p12");
    nav.setOrder(ids(12).filter((x) => x !== "p5" && x !== "p12"), 4);
    expect(nav.focused()).toBe("p11"); expect(document.activeElement).not.toBe(document.body);
  });
});
