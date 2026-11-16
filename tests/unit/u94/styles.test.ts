import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderMemoryView } from "../../../src/views/memory";

const css = readFileSync(resolve(import.meta.dirname, "../../../styles/views.css"), "utf8");
let style: HTMLStyleElement;
interface Rule { selector: string; declaration: CSSStyleDeclaration; media: readonly string[] }
function rules(list: CSSRuleList, media: readonly string[] = []): Rule[] {
  const result: Rule[] = [];
  for (const rule of list) {
    if ("selectorText" in rule) {
      const item = rule as CSSStyleRule;
      result.push({ selector: item.selectorText, declaration: item.style, media });
    } else if ("cssRules" in rule) {
      const group = rule as CSSMediaRule;
      result.push(...rules(group.cssRules, group.conditionText ? [...media, group.conditionText] : media));
    }
  }
  return result;
}
const selectors = (selector: string, rs: readonly Rule[]) => rs.filter(r =>
  r.selector.split(",").some(s => s.trim() === selector));
const wraps = (declaration: CSSStyleDeclaration) =>
  ["anywhere", "break-word"].includes(declaration.getPropertyValue("overflow-wrap")) ||
  ["break-all", "break-word"].includes(declaration.getPropertyValue("word-break"));

beforeEach(() => {
  style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
});
afterEach(() => {
  style.remove();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

describe.each(["light", "dark"])("U94 CSS contracts, %s theme", theme => {
  beforeEach(() => document.documentElement.setAttribute("data-theme", theme));

  it("A6/A7 Memory has explicit panel styling and preserves displayed line breaks", () => {
    const root = renderMemoryView(document, { sections: [
      { id: "goal", label: "Goal", text: "first\nsecond", required: false, empty: false, rev: 9, maxChars: 2000 },
    ] });
    document.body.append(root);
    const rs = rules(style.sheet!.cssRules);
    expect(rs.some(r => r.selector.includes(".memory-panel"))).toBe(true);
    const text = root.querySelector<HTMLElement>(".memory-text")!;
    expect(["pre-wrap", "pre-line", "break-spaces"]).toContain(getComputedStyle(text).whiteSpace);
    expect(getComputedStyle(text).getPropertyValue("user-select")).not.toBe("none");
  });

  it("A7 Memory long tokens wrap without clipping or ellipsis", () => {
    const rs = rules(style.sheet!.cssRules);
    const textRules = rs.filter(r => r.selector.includes(".memory-text"));
    expect(textRules.some(r => wraps(r.declaration))).toBe(true);
    for (const r of rs.filter(r => /\.memory(?:-panel|-text|-list)?(?:\b|\s)/.test(r.selector))) {
      expect(["hidden", "clip"]).not.toContain(r.declaration.getPropertyValue("overflow"));
      expect(["hidden", "clip"]).not.toContain(r.declaration.getPropertyValue("overflow-x"));
      expect(r.declaration.getPropertyValue("text-overflow")).not.toBe("ellipsis");
      expect(r.declaration.getPropertyValue("white-space")).not.toBe("nowrap");
    }
  });

  it("A7 Diary has an explicit narrow breakpoint that stacks timestamp and body", () => {
    const rs = rules(style.sheet!.cssRules);
    const narrow = selectors(".entry", rs).filter(r => r.media.some(condition => {
      const match = /max-width\s*:\s*(\d+(?:\.\d+)?)px/.exec(condition);
      return match !== null && Number(match[1]) >= 320 && Number(match[1]) < 1280;
    }));
    expect(narrow.some(r => {
      const columns = r.declaration.getPropertyValue("grid-template-columns").trim();
      return /^(?:1fr|100%|minmax\(0(?:px)?,\s*1fr\))$/.test(columns) ||
        r.declaration.getPropertyValue("flex-direction") === "column" ||
        r.declaration.getPropertyValue("display") === "block";
    })).toBe(true);
    // The body can share its narrow rule with the entry or retain a base
    // shrink guard; the spec does not prescribe where that declaration lives.
    expect(selectors(".entry-body", rs).some(r => r.declaration.getPropertyValue("min-width") === "0" ||
      r.declaration.getPropertyValue("min-width") === "0px")).toBe(true);
  });

  it("A7 archive metadata wraps, project names are complete, Restore remains available", () => {
    const rs = rules(style.sheet!.cssRules);
    for (const selector of [".archived-head", ".archived-meta"]) {
      expect(selectors(selector, rs).some(r => r.declaration.getPropertyValue("flex-wrap") === "wrap")).toBe(true);
    }
    const projects = selectors(".archived-project", rs);
    expect(projects.some(r => wraps(r.declaration))).toBe(true);
    const effective = Object.assign({}, ...projects.map(r => Object.fromEntries(
      [...Array(r.declaration.length).keys()].map(i => {
        const name = r.declaration.item(i);
        return [name, r.declaration.getPropertyValue(name)];
      }))));
    expect(effective["white-space"]).not.toBe("nowrap");
    expect(effective["text-overflow"]).not.toBe("ellipsis");
    expect(["hidden", "clip"]).not.toContain(effective.overflow);
    for (const r of selectors(".archived-restore", rs)) {
      expect(r.declaration.getPropertyValue("display")).not.toBe("none");
      expect(r.declaration.getPropertyValue("visibility")).not.toBe("hidden");
    }
  });

  it("M9 archive labels come from DOM text, not generated CSS", () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/content\s*:[^;}]*["'](?:Duration unknown|\d+ tasks?)/i);
  });
});
