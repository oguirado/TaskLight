import { afterEach, describe, expect, it } from "vitest";
import { activateCSS, cssText, expectNaturalHeight, expectVisible, q, rotates, shape, sources, themes, token } from "./css_probe";
import { fixture, longSlug, states } from "./fixtures";

// C7 aliases refer to the existing palette, scale, spacing and touch tokens.
const aliases = {
  "--wall-reading-max": "--reading-max",
  "--wall-task-pad": "--sp-3", "--wall-task-gap": "--sp-2",
  "--wall-row-gap": "--sp-1", "--wall-row-indent": "--sp-6",
  "--wall-task-font": "--fs-3", "--wall-step-font": "--fs-2", "--wall-meta-font": "--fs-1",
  "--wall-title-font": "--fs-4", "--wall-control-min": "--touch",
  "--wall-step-active-bg": "--c-primary-tint",
  "--wall-state-working": "--c-primary-ink", "--wall-state-waiting": "--c-st-waiting",
  "--wall-state-failed": "--c-st-blocked", "--wall-state-done": "--c-st-done", "--wall-state-unknown": "--c-text-3",
} as const;

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("style[data-u151]").forEach(node => node.remove());
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("ui-reduced-motion");
});

describe("U151 Wall density CSS", () => {
  it.each(themes)("AC1 resolves the C7 Wall aliases in %s", theme => {
    const rules = activateCSS({ theme }, sources.tokens);
    for (const [alias, base] of Object.entries(aliases)) {
      expect(token(alias), `Missing or unresolved ${alias} in ${theme}`).not.toBe("");
      expect(token(alias), `${alias} must follow ${base} in ${theme}`).toBe(token(base));
      const declarations = rules.filter(rule => document.documentElement.matches(rule.selectorText))
        .map(rule => rule.style.getPropertyValue(alias)).filter(Boolean);
      expect(declarations.join(" "), `${alias} must remain an alias`).toMatch(new RegExp(`var\\(\\s*${base}\\s*(?:,|\\))`));
    }
    expect(token("--wall-strip-row-min"), "Noninteractive strip rows retain their density token").toBe("2rem");
  });

  it("AC2 confines Wall density consumers to the Wall and Agents strip", () => {
    const rules = activateCSS();
    const { wall, strip, legacy } = fixture();
    const consumers = rules.filter(rule => [...rule.style].some(property => !property.startsWith("--")
      && /var\(\s*--wall-/.test(rule.style.getPropertyValue(property))));
    for (const root of [wall, strip]) expect(consumers.some(rule => [root, ...root.querySelectorAll("*")]
      .some(node => node.matches(rule.selectorText))), `Wall aliases must be consumed in ${root.className}`).toBe(true);
    for (const node of legacy.querySelectorAll("*")) for (const rule of consumers) {
      expect(node.matches(rule.selectorText), `Density rule leaks to legacy markup: ${rule.selectorText}`).toBe(false);
    }
  });

  it("AC2 preserves legacy step boxes and workspace motion outside the Wall", () => {
    activateCSS();
    const { legacy } = fixture();
    const row = getComputedStyle(q(legacy, ".step-row"));
    expect(parseFloat(row.borderTopWidth)).toBeGreaterThan(0);
    expect(row.borderTopStyle).not.toBe("none");
    expect(rotates(q(legacy, ".ws-running")), "Workspace activity is outside this density change").toBe(true);
  });

  it.each(["button.step-row", "div.step-row"])("AC3 removes boxes from %s in the Wall", selector => {
    activateCSS();
    const { wall } = fixture();
    const rows = wall.querySelectorAll<HTMLElement>(selector);
    expect(rows.length, "The CSS gate needs real rows").toBeGreaterThan(0);
    for (const row of rows) {
      const style = getComputedStyle(row);
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        const width = style[`border${side}Width`];
        const kind = style[`border${side}Style`];
        expect(kind === "none" || kind === "hidden" || parseFloat(width || "0") === 0,
          `Wall ${selector} retains a ${side.toLowerCase()} border`).toBe(true);
      }
      // Quiet ordinary rows stay transparent; working tint is independently allowed.
      if (row.closest(".step")?.getAttribute("data-activity") !== "working") {
        expect(style.backgroundColor, "Ordinary steps must not look like separate cards").toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/);
      }
    }
  });

  it("AC4 aligns desktop agent records with a grid", () => {
    activateCSS({ width: 1440 });
    const { strip } = fixture();
    const rows = strip.querySelectorAll(".agent-strip-row");
    expect(rows.length, "The CSS gate needs real strip records").toBeGreaterThan(0);
    for (const row of rows) expect(getComputedStyle(row).display).toBe("grid");
  });

  it("AC5 animates the working microtask", () => {
    activateCSS();
    const { wall } = fixture();
    expect(rotates(q(wall, '.step[data-activity="working"] .step-indicator'))).toBe(true);
  });

  it.each(states.filter(state => state !== "working"))("AC5 keeps %s microtasks stationary", state => {
    activateCSS();
    const { wall } = fixture();
    expect(rotates(q(wall, `.step[data-activity="${state}"] .step-indicator`))).toBe(false);
  });

  it("AC5 keeps task rings stationary while microtasks work", () => {
    activateCSS();
    const { wall } = fixture();
    const rings = wall.querySelectorAll<HTMLElement>('.status-icon[data-activity="working"]');
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) expect(rotates(ring), "The task ring must not compete with the working microtask").toBe(false);
  });

  it("AC5 keeps agent dots stationary", () => {
    activateCSS();
    const { strip } = fixture();
    const dots = strip.querySelectorAll<HTMLElement>(".wall-agent-dot");
    expect(dots.length, "The CSS gate needs agent indicators").toBeGreaterThan(0);
    for (const dot of dots) expect(rotates(dot)).toBe(false);
  });

  it.each(["system", "preference class"] as const)("AC6 preserves the working shape and word with reduced motion via %s", mode => {
    const { wall, strip } = fixture();
    activateCSS();
    const icon = q(wall, '.step[data-activity="working"] .step-indicator');
    const before = shape(icon);
    expect(rotates(icon), "Nonvacuous control: working animates before reduction").toBe(true);
    activateCSS({ reduced: mode === "system", preferenceClass: mode === "preference class" });
    expect(shape(icon), "Reduced motion must preserve the visible indicator shape").toBe(before);
    for (const root of [wall, strip]) for (const layer of root.querySelectorAll<HTMLElement>(".step-indicator, .status-icon, .wall-agent-dot")) {
      expect(rotates(layer), "Reduced motion must stop rotation").toBe(false);
    }
    const word = q(wall, '.step[data-activity="working"] .step-activity-label');
    expect(word.textContent).toContain("Working");
    expectVisible(word, wall);
    expectVisible(icon, wall);
    for (const control of wall.querySelectorAll(".step-row, .step-chevron")) {
      for (const duration of getComputedStyle(control).transitionDuration.split(",")) {
        const amount = parseFloat(duration || "0") * (duration.trim().endsWith("ms") ? 1 : 1000);
        expect(amount, "Reduced motion neutralizes disclosure transitions").toBeLessThanOrEqual(0.01);
      }
    }
  });

  it.each(themes)("AC7 keeps completed content undimmed in %s", theme => {
    activateCSS({ theme });
    const { wall, strip } = fixture();
    for (const node of [q(wall, '[data-task-id="T02"] .task-title'),
      q(wall, '.step[data-state="done"] .step-label'), q(strip, '[data-activity="finished"]')]) {
      expectVisible(node, node.closest<HTMLElement>(".plan-wall, .agent-strip")!);
    }
  });

  it.each(themes.flatMap(theme => [390, 1440].map(width => ({ theme, width }))))(
    "AC8 allows cards and rows to grow in $theme at $width px", ({ theme, width }) => {
      activateCSS({ theme, width });
      const { wall, strip } = fixture();
      for (const selector of [".task", ".task-head", ".step", ".step-row"]) {
        const nodes = wall.querySelectorAll<HTMLElement>(selector);
        expect(nodes.length, `Natural-height gate needs ${selector}`).toBeGreaterThan(0);
        for (const node of nodes) expectNaturalHeight(node);
      }
      expectNaturalHeight(strip);
      for (const selector of [".agent-strip-group", ".agent-strip-row"]) {
        const nodes = strip.querySelectorAll<HTMLElement>(selector);
        expect(nodes.length, `Natural-height gate needs ${selector}`).toBeGreaterThan(0);
        for (const node of nodes) expectNaturalHeight(node);
      }
    });

  it.each(["height", "block-size"])("N1 rejects a fixed card %s using the same AC8 gate", property => {
    const { wall } = fixture();
    const card = q(wall, ".task");
    activateCSS();
    expectNaturalHeight(card);
    activateCSS({}, `${cssText}\n.plan-wall .task { ${property}: 96px !important; }`);
    expect(() => expectNaturalHeight(card)).toThrow(/No fixed/);
  });

  it("AC9 preserves the touch-token floor on interactive microtask rows", () => {
    const { wall } = fixture();
    const rows = wall.querySelectorAll<HTMLElement>("button.step-row");
    expect(rows.length).toBeGreaterThan(0);
    // Check the shipped floor, then catch a hard-coded target of the same size.
    for (const css of [cssText, `${cssText}\n:root { --touch: 68px; }`]) {
      activateCSS({}, css);
      for (const row of rows) {
        const style = getComputedStyle(row);
        const floor = Math.max(parseFloat(style.minHeight || "0"), parseFloat(style.minBlockSize || "0"));
        expect(floor, "Interactive rows must keep the --touch minimum").toBeGreaterThanOrEqual(parseFloat(token("--touch")));
      }
    }
  });

  it.each(themes)("H1 retains wrap opportunities for the unbroken slug at narrow width in %s", theme => {
    activateCSS({ theme, width: 390 });
    const { wall, strip } = fixture();
    for (const root of [wall, strip]) {
      root.style.inlineSize = "390px";
      const name = q(root, ".wall-agent-name");
      expect(name.textContent).toBe(longSlug);
      expect(name.textContent).toHaveLength(200);
      const style = getComputedStyle(name);
      expect(style.whiteSpace).not.toMatch(/nowrap|^pre$/);
      expect(style.overflowWrap === "anywhere" || style.wordBreak === "break-all",
        "Unbroken identities require an intrinsic wrap opportunity").toBe(true);
      for (const node of [name, name.parentElement!, q(wall, ".task-title")]) {
        const current = getComputedStyle(node);
        expect(current.textOverflow).not.toBe("ellipsis");
        expect(current.overflowX).not.toMatch(/hidden|clip/);
        expectNaturalHeight(node);
      }
    }
    // This is a CSS preflight, not a browser-layout or capsule receipt.
  });
});
