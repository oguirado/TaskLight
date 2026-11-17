import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const css = ["views.css", "plan.css"].map(name =>
  readFileSync(resolve(import.meta.dirname, "../../../styles", name), "utf8"));
interface Rule { selector: string; declaration: CSSStyleDeclaration; media: readonly string[] }
function rules(list: CSSRuleList, media: readonly string[] = []): Rule[] {
  const result: Rule[] = [];
  for (const rule of list) {
    if ("selectorText" in rule) {
      const style = rule as CSSStyleRule;
      result.push({ selector: style.selectorText, declaration: style.style, media });
    } else if ("cssRules" in rule) {
      const group = rule as CSSMediaRule;
      result.push(...rules(group.cssRules, group.conditionText ? [...media, group.conditionText] : media));
    }
  }
  return result;
}
let styles: HTMLStyleElement[];
beforeEach(() => {
  styles = css.map(text => {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
    return style;
  });
});
afterEach(() => {
  for (const style of styles) style.remove();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

function probe(inDiary = true) {
  // A public-shape CSS fixture, independent of the renderer's missing wrapper.
  const host = document.createElement("section");
  if (inDiary) host.className = "diary";
  const entry = document.createElement("li");
  entry.className = "entry";
  const time = document.createElement("time");
  time.className = "entry-time";
  time.textContent = "10:05";
  const body = document.createElement("div");
  body.className = "entry-body";
  const title = document.createElement("p");
  title.className = "entry-title";
  title.textContent = "T".repeat(1024);
  const outcome = document.createElement("p");
  outcome.className = "entry-outcome";
  outcome.textContent = "First line.\n  " + "O".repeat(240);
  const meta = document.createElement("p");
  meta.className = "entry-meta";
  for (const cls of ["entry-took", "entry-author"]) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = cls === "entry-author" ? "a".repeat(1024) : "2m";
    meta.append(span);
  }
  const evidence = document.createElement("ul");
  evidence.className = "entry-evidence";
  const item = document.createElement("li");
  item.textContent = `evidence/${"x".repeat(2048)}.md`;
  evidence.append(item);
  body.append(title, outcome, meta, evidence);
  entry.append(time, body);
  host.append(entry);
  document.body.append(host);
  return { host, entry, time, body, title, outcome, meta, evidence };
}
function overflowWrap(node: Element | null): string {
  if (!node) return "";
  const value = getComputedStyle(node).overflowWrap;
  // overflow-wrap inherits in browsers; jsdom may leave an inherited value empty.
  return value || overflowWrap(node.parentElement);
}
const allRules = () => styles.flatMap(style => rules(style.sheet!.cssRules));
const matching = (node: Element, list: readonly Rule[]) => list.filter(rule => node.matches(rule.selector));

describe.each(["light", "dark"])("U106 declared Diary layout, %s theme", theme => {
  beforeEach(() => document.documentElement.setAttribute("data-theme", theme));

  it("M3/B2 body and immediate children have explicit zero minimum widths", () => {
    const { body } = probe();
    for (const node of [body, ...body.children]) {
      expect(Number.parseFloat(getComputedStyle(node).minWidth), `${node.className} min-width`).toBe(0);
    }
  });

  it("M3/B2 body and all content wrap unbroken text anywhere", () => {
    const { body } = probe();
    for (const node of [body, ...body.querySelectorAll("*")]) {
      expect(overflowWrap(node), `${node.className || node.tagName} overflow-wrap`).toBe("anywhere");
    }
  });

  it("M3 preserves the wide grid and a narrow time/body stack", () => {
    const { entry, time } = probe();
    const wide = getComputedStyle(entry);
    expect(wide.display).toBe("grid");
    expect(wide.gridTemplateColumns).toMatch(/^\S+\s+minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)$/);
    const narrow = allRules().filter(rule => rule.media.some(condition => {
      const max = /max-width\s*:\s*(\d+(?:\.\d+)?)px/.exec(condition);
      return max !== null && Number(max[1]) >= 390 && Number(max[1]) < 768;
    }));
    expect(matching(entry, narrow).some(rule =>
      /^(?:1fr|100%|minmax\(0(?:px)?,\s*1fr\))$/.test(rule.declaration.getPropertyValue("grid-template-columns").trim())))
      .toBe(true);
    expect(matching(time, narrow).some(rule => rule.declaration.getPropertyValue("text-align") === "left")).toBe(true);
  });

  it("M3 preserves outcome whitespace and token colors", () => {
    const { title, outcome, meta } = probe();
    expect(getComputedStyle(outcome).whiteSpace).toBe("pre-wrap");
    const base = allRules().filter(rule => rule.media.length === 0);
    for (const [node, token] of [[title, "--c-text-1"], [outcome, "--c-text-2"], [meta, "--c-text-3"]] as const) {
      expect(matching(node, base).some(rule => rule.declaration.getPropertyValue("color") === `var(${token})`))
        .toBe(true);
    }
  });

  it("M3 body content has no clipping, ellipsis or forced non-wrapping", () => {
    const { body } = probe();
    for (const node of [body, ...body.querySelectorAll("*")]) {
      const style = getComputedStyle(node);
      expect(["hidden", "clip"]).not.toContain(style.overflow);
      expect(["hidden", "clip"]).not.toContain(style.overflowX);
      expect(style.textOverflow).not.toBe("ellipsis");
      expect(style.whiteSpace).not.toBe("nowrap");
    }
  });

  it("M3 added shrink/wrap overrides stay within Diary", () => {
    const { body, title, outcome, meta, evidence } = probe(false);
    // Existing shared declarations remain valid; the new overrides must be scoped.
    expect(Number.parseFloat(getComputedStyle(body).minWidth)).toBe(0);
    for (const node of [title, outcome, meta, evidence]) {
      expect(["", "auto"]).toContain(getComputedStyle(node).minWidth);
    }
    for (const node of [body, meta, evidence]) {
      expect(["", "normal"]).toContain(getComputedStyle(node).overflowWrap);
    }
  });
});
