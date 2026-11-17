import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemoryView } from "../../../src/views/memory";

const names = ["tokens", "views", "plan", "model_selector"] as const;
const sources = Object.fromEntries(names.map(name => [name,
  readFileSync(resolve(import.meta.dirname, "../../../styles", `${name}.css`), "utf8")])) as Record<typeof names[number], string>;
const css = names.map(name => sources[name]).join("\n");
const durationNames = [...new Set(css.match(/--(?:motion-duration|dur-[\w-]+)(?=\s*:)/g))];
type Trigger = "none" | "app" | "document" | "os";

// jsdom has no viewport layout or media emulation. Select media branches explicitly;
// these assertions cover computed CSS contracts, never claim pixel measurements.
function rulesFor(text: string, reduced: boolean, width = 390): CSSStyleRule[] {
  const sheet = document.createElement("style");
  sheet.textContent = text;
  document.head.append(sheet);
  expect(sheet.sheet, "Fixture CSS must parse before any assertion").not.toBeNull();
  const selected: CSSStyleRule[] = [];
  function visit(rules: CSSRuleList): void {
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) selected.push(rule as CSSStyleRule);
      else if (rule.type === CSSRule.MEDIA_RULE) {
        const media = rule as CSSMediaRule;
        const matches = media.conditionText.split(",").some(branch => {
          let match = true;
          const rest = branch.replace(/\(prefers-reduced-motion:\s*(reduce|no-preference)\)/g,
            (_, value: string) => { match &&= reduced === (value === "reduce"); return ""; })
            .replace(/\((min|max)-width:\s*(\d+)px\)/g, (_, bound: string, amount: string) => {
              match &&= bound === "max" ? width <= Number(amount) : width >= Number(amount); return "";
            }).replace(/\b(?:screen|all|and)\b/g, "").trim();
          expect(rest, "Unsupported media condition cannot silently pass").toBe("");
          return match;
        });
        if (matches) visit(media.cssRules);
      }
    }
  }
  visit(sheet.sheet!.cssRules);
  sheet.remove();
  return selected;
}

function fixture(text: string, trigger: Trigger = "none"): CSSStyleRule[] {
  document.head.replaceChildren();
  document.documentElement.className = trigger === "document" ? "ui-reduced-motion" : "";
  document.body.innerHTML = `<main class="app${trigger === "app" ? " ui-reduced-motion" : ""}">
    <section class="main"><div class="plan-wall"><div class="plan-band">
      <header class="plan-band-head"><h2 class="plan-title">${"W".repeat(120)}</h2><span class="progress">Progress</span></header>
      <div class="plan-phases"><button class="phase-chip">${"P".repeat(120)}</button></div></div>
      <div class="phase-groups"><section class="phase-group"><div class="phase-tasks"><article class="task">
      <div class="step" data-activity="working"><span class="step-indicator"></span><span class="step-label">Working</span></div>
      </article></div></section></div></div>
      <aside class="model-sheet"><button>Models</button></aside><section class="liaison-panel"><button>Source</button></section>
    </section></main>`;
  const memory = renderMemoryView(document, {
    room: "demo", sections: [{ id: "goal", label: "Memory", text: "X".repeat(120), required: false, empty: false, rev: 1, maxChars: 2000 }],
    history: { goal: [{ rev: 1, by: "A".repeat(120), ts: 1000, text: "H".repeat(2000) }] },
  });
  memory.querySelector("details")!.open = true;
  document.querySelector(".main")!.append(memory);
  const rules = rulesFor(text, trigger === "os");
  const active = document.createElement("style");
  active.textContent = rules.map(rule => rule.cssText).join("\n");
  document.head.append(active);
  return rules;
}
function node(selector: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(selector);
  expect(result, `Fixture must contain ${selector}`).not.toBeNull();
  return result!;
}
const containers = [".plan-band", ".phase-groups", ".phase-group", ".phase-tasks", ".task",
  ".memory", ".memory-list", ".memory-panel", ".memory-export", ".memory-export-command", ".memory-history", ".memory-history-list"];
function widthProblems(): string[] {
  return containers.filter(selector => {
    const style = getComputedStyle(node(selector));
    return style.maxWidth !== "100%" || style.minWidth !== "0px" || style.boxSizing !== "border-box"
      || style.overflowWrap !== "anywhere";
  });
}
function withoutRule(text: string, selector: string): string {
  // Locate one original block rather than round-tripping CSSOM's normalized selectors.
  const block = [...text.matchAll(/([^{}]+)\{[^{}]*\}/g)].find(match =>
    match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(",").some(part => part.trim() === selector));
  expect(block, `Mutation requires a real ${selector} rule`).toBeDefined();
  return text.slice(0, block!.index) + text.slice(block!.index! + block![0].length);
}
function zeroMotionProblems(rules: CSSStyleRule[], selectors: string[]): string[] {
  const failures: string[] = [];
  for (const selector of selectors) for (const pseudo of ["", "::before", "::after"]) {
    const element = node(selector);
    for (const property of ["animation-duration", "transition-duration"]) {
      const covering = rules.filter(rule => {
        const value = rule.style.getPropertyValue(property);
        const variable = value.match(/^var\((--[\w-]+)\)$/)?.[1];
        const resolved = variable ? rule.style.getPropertyValue(variable).trim() : value;
        return resolved === "0ms" && rule.style.getPropertyPriority(property) === "important" && rule.selectorText.split(",").some(part => {
        const candidate = part.trim();
        if (pseudo ? !candidate.endsWith(pseudo) : candidate.includes("::")) return false;
        // CSSOM normalizes "*::before" to "::before"; restore the implicit universal.
        const origin = pseudo ? candidate.slice(0, -pseudo.length) : candidate;
        return element.matches(pseudo && (!origin || /\s$/.test(origin)) ? origin + "*" : origin);
      });
      });
      if (!covering.length) failures.push(`${selector}${pseudo}: ${property}`);
    }
  }
  return failures;
}

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); document.documentElement.className = ""; });

describe("narrow Wall and retained Memory CSS contracts", () => {
  it("bounds containers and grid/flex children without clipping the page", () => {
    fixture(css);
    expect(widthProblems()).toEqual([]);
    for (const selector of [".plan-band-head", ".plan-phases"]) expect(getComputedStyle(node(selector)).flexWrap).toBe("wrap");
    for (const selector of [".plan-title", ".phase-chip"]) {
      expect(getComputedStyle(node(selector)).minWidth).toBe("0px");
      expect(getComputedStyle(node(selector)).overflowWrap).toBe("anywhere");
    }
  });
  it("keeps long selectable commands in their own wrapping, scrollable box", () => {
    fixture(css);
    const command = node(".memory-export-command") as HTMLTextAreaElement;
    const style = getComputedStyle(command);
    expect(command.readOnly).toBe(true);
    expect(style.width).toBe("100%");
    expect(style.whiteSpace).toBe("pre-wrap");
    expect(style.overflowX).toBe("auto");
    expect(style.resize).toBe("vertical");
  });
  it("negative control: removing the shared containment rule fails the same oracle", () => {
    fixture(withoutRule(css, ".phase-groups"));
    expect(widthProblems()).toContain(".phase-groups");
  });
});

describe("complete independent reduced-motion triggers", () => {
  it.each(["app", "document", "os"] as const)("resolves every declared duration token to zero with %s", trigger => {
    fixture(css, trigger);
    expect(durationNames).toEqual(expect.arrayContaining(["--motion-duration", "--dur-1", "--dur-2", "--dur-3", "--dur-spin", "--dur-live"]));
    for (const selector of [".app", ".main", ".step-indicator", ".model-sheet", ".model-sheet button", ".liaison-panel button"])
      for (const name of durationNames) expect(getComputedStyle(node(selector)).getPropertyValue(name).trim(), `${selector}: ${name}`).toBe("0ms");
    expect(node(".step-label").textContent).toBe("Working");
    expect(getComputedStyle(node(".step-label")).display).not.toBe("none");
    expect(getComputedStyle(node(".step-indicator")).display).not.toBe("none");
  });
  it.each(["app", "document", "os"] as const)("guards roots, descendants and pseudo-elements with %s across the stylesheet cascade", trigger => {
    const rules = fixture(css, trigger);
    expect(zeroMotionProblems(rules, [".app", ".main", ".model-sheet button", ".liaison-panel button"])).toEqual([]);
  });
  it.each(["app", "document", "os"] as const)("Models guards sheet and liaison layers with %s independently of global CSS", trigger => {
    const rules = fixture(sources.model_selector, trigger);
    expect(zeroMotionProblems(rules, [".model-sheet", ".model-sheet button", ".liaison-panel", ".liaison-panel button"])).toEqual([]);
  });
  it("preserves ordinary token durations without a preference", () => {
    fixture(css);
    for (const name of durationNames) {
      const value = getComputedStyle(node(".app")).getPropertyValue(name).trim();
      expect(value, name).not.toBe("");
      expect(value, name).not.toBe("0ms");
    }
  });
  it("negative control: removing a duration reset reveals the derived addition", () => {
    const mutant = css.replace(/--dur-2:\s*0ms;/g, "");
    expect(mutant).not.toBe(css);
    for (const trigger of ["app", "os"] as const) {
      fixture(mutant, trigger);
      expect(getComputedStyle(node(".app")).getPropertyValue("--dur-2").trim()).not.toBe("0ms");
    }
  });
  it("negative control: removing a Models guard fails the same layer oracle", () => {
    const mutant = withoutRule(sources.model_selector, ".ui-reduced-motion .model-sheet");
    const rules = fixture(mutant, "app");
    expect(zeroMotionProblems(rules, [".model-sheet", ".liaison-panel"])).not.toEqual([]);
  });
});
