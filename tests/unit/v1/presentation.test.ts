import { describe, expect, it } from "vitest";
import { agent, board, bubble, deterministic, integrated, lane, micro, microNode, name, render, task, text, tree } from "./helpers";
import { animation, declarations, dimmed, drawing, geometry, paintTokens, resolved, styles, swarmCSS } from "./css";

deterministic();

describe("V1 M3/M4/M7 reserved presentation declarations", () => {
  it.each([[390, 12], [768, 16], [1440, 24]] as const)("M3 at %ipx child nesting declares %ipx indentation", (width, indent) => {
    styles(width); const root = render(tree()), child = lane(root, "b-child");
    // Follow the child and its wrappers up to the parent: either a child margin or a parent children-container padding is valid.
    const parent = lane(root, "z-lead"); const values: string[] = [];
    for (let node: Element | null = child; node && node !== parent; node = node.parentElement) {
      const d = resolved(node); values.push(d["padding-inline-start"] ?? d["padding-left"] ?? "", d["margin-inline-start"] ?? d["margin-left"] ?? "");
    }
    expect(values.some(v => v === `${indent}px` || v === `${indent / 16}rem`), "M3 specified responsive child indentation").toBe(true);
  });

  it("M4 task and microtask bubbles reserve their distinct diameters", () => {
    styles(); const root = render(), button = bubble(root, "Task T09"); geometry(button, 24); button.click();
    for (const m of task().microtasks) {
      const node = microNode(root, m.text); geometry(node.parentElement!, 16);
    }
  });

  it("M4 partial task fill represents a fraction, with equal ratios sharing the same drawing", () => {
    styles();
    const sample = (done: number, total: number) => {
      const t = task("T09", { microtasks: Array.from({ length: total }, (_, i) => micro(`T09.M0${i + 1}`, i < done ? "done" : "pending")) });
      const root = render(board([agent("z-lead", { tasks: [t] })]));
      const indicator = geometry(bubble(root, t.title), 24), result = drawing(indicator); root.remove(); return result;
    };
    const empty = sample(0, 4), quarter = sample(1, 4), half = sample(2, 4), full = sample(4, 4);
    expect(new Set([empty, quarter, half, full]).size, "M4 distinct completion fractions change visible fill").toBe(4);
    expect(sample(1, 2), "M4 equal fractions draw equally").toBe(half);
    expect(sample(0, 0), "M4 no microtasks means zero fill").toBe(empty);
    expect(half, "M4 partial-fill drawing is not just text or a colour label").toMatch(/gradient|stroke|mask|clip-path|path/);
  });

  it("M4 pending active done blocked have distinct drawings plus independent text alternatives", () => {
    styles(); const root = render(), button = bubble(root, "Task T09"); button.click();
    const drawings = task().microtasks.map(m => {
      const n = microNode(root, m.text), indicator = geometry(n.parentElement!, 16);
      expect(name(n)).toContain(`${m.text}, ${m.state},`); return drawing(indicator).replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi, "ink");
    });
    expect(new Set(drawings).size, "Negative control: colour-only states must fail").toBe(4);
    const done = microNode(root, "Micro T09.M03").parentElement!, blocked = microNode(root, "Micro T09.M01").parentElement!;
    // Accept textual, CSS-content and vector icons; glyph choice and SVG path encoding are not prescribed.
    expect(text(done) + drawing(done)).toMatch(/✓|✔|check|stroke|path|border/);
    expect(text(blocked) + drawing(blocked)).toMatch(/Ⅱ|‖|⏸|pause|stroke|path|border/);
  });

  it.each([false, true])("M4 active arc obeys reduced-motion=%s with a static partial-fill alternative", reduced => {
    styles(768, reduced); const root = render(), button = bubble(root, "Task T09"); button.click();
    const active = geometry(microNode(root, "Micro T09.M02").parentElement!, 16);
    const pending = geometry(microNode(root, "Micro T09.M04").parentElement!, 16);
    if (reduced) {
      expect(animation(active)).toBe(""); expect(active.querySelector("animate,animateTransform")).toBeNull();
      expect(drawing(active)).not.toBe(drawing(pending));
    } else expect(animation(active) || active.querySelector("animate,animateTransform")?.outerHTML || "").not.toBe("");
  });

  it("M7 state changes preserve the declared task bubble footprint", () => {
    styles(); const footprints: unknown[] = [];
    for (const state of ["pending", "active", "done", "blocked"] as const) {
      const t = task("T09", { state, microtasks: [micro("T09.M01", state)] });
      const root = render(board([agent("z-lead", { tasks: [t] })])); const indicator = geometry(bubble(root, t.title), 24);
      const d = resolved(indicator); footprints.push([d.width ?? d["inline-size"], d.height ?? d["block-size"], d["box-sizing"]]); root.remove();
    }
    expect(footprints.every(v => JSON.stringify(v) === JSON.stringify(footprints[0]))).toBe(true);
  });
});

describe("V1 M6 dimmed retained lanes", () => {
  it("M6 read failure dims last-good lanes without hiding or deleting them", () => {
    styles(); const wall = integrated("swarm");
    expect(dimmed(lane(wall.host, "z-lead"))).toBe(false);
    wall.events.mockImplementation(() => { throw new Error("read denied"); }); wall.wall.refresh();
    const row = lane(wall.host, "z-lead");
    expect(dimmed(row), "M6 last-good lanes visibly signal stale data").toBe(true);
    expect(resolved(row).display).not.toBe("none");
  });
});

describe("V1 M9 theme tokens", () => {
  it("M9 board state colours and keyboard focus use existing tokens without literal colour values", () => {
    styles(); const root = render(), button = bubble(root, "Task T09"); button.click();
    const tokens = { pending: "--c-st-pending", active: "--c-st-running", done: "--c-st-done", blocked: "--c-st-blocked" };
    for (const m of task().microtasks) {
      const indicator = geometry(microNode(root, m.text).parentElement!, 16);
      expect(paintTokens(indicator), `M9 ${m.state} paint derives from its existing state token`).toContain(tokens[m.state]);
      for (const node of [indicator, ...indicator.querySelectorAll("*")]) for (const pseudo of ["", "::before", "::after"]) {
        for (const [key, value] of Object.entries(declarations(node, pseudo))) if (/^(background|color|fill|stroke|border)/.test(key)) {
          expect(value, "M9 bubble paint cannot introduce literal colours").not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i);
        }
      }
    }
    button.focus();
    expect(paintTokens(button), "M9 keyboard focus derives from the existing focus token").toContain("--c-focus");
    expect(swarmCSS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i);
  });

  it.each(["light", "dark"] as const)("M9 %s theme preserves accessible states and resolves the state palette", theme => {
    styles(1440, false, theme); const root = render(), button = bubble(root, "Task T09"); button.click();
    for (const m of task().microtasks) {
      const n = microNode(root, m.text), indicator = geometry(n.parentElement!, 16);
      expect(name(n)).toContain(`${m.text}, ${m.state},`);
      expect(drawing(indicator)).not.toContain("unresolved");
      expect(declarations(indicator)).toBeDefined();
    }
  });
});
