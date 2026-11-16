import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

export const cssText = () => ["tokens.css", "views.css", "plan.css"]
  .map(file => readFileSync(resolve(__dirname, "../../../styles", file), "utf8")).join("\n");
interface Rule { selector: string; style: CSSStyleDeclaration; order: number }
const parsed = new Map<string, Rule[]>();

export function rules(css = cssText(), reduced = false): Rule[] {
  const key = `${reduced}:${css}`;
  const cached = parsed.get(key); if (cached) return cached;
  const style = document.createElement("style"); style.dataset.u91 = "probe"; style.textContent = css;
  document.head.append(style);
  const result: Rule[] = [];
  function visit(list: CSSRuleList) {
    for (const rule of list) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const r = rule as CSSStyleRule;
        // Commas inside :is()/rgba() are not selector separators.
        for (const selector of r.selectorText.split(/,(?![^()]*\))/)) {
          result.push({ selector: selector.trim(), style: r.style, order: result.length });
        }
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        const media = rule as CSSMediaRule;
        const query = media.conditionText;
        if (/prefers-reduced-motion\s*:\s*reduce/.test(query) && reduced) visit(media.cssRules);
        else if (/prefers-reduced-motion\s*:\s*no-preference/.test(query) && !reduced) visit(media.cssRules);
        else if (/^\s*all\s*$/.test(query)) visit(media.cssRules);
      }
    }
  }
  if (style.sheet) visit(style.sheet.cssRules);
  style.remove(); parsed.set(key, result); return result;
}
function specificity(selector: string): number {
  return (selector.match(/#[\w-]+/g)?.length ?? 0) * 10000
    + (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g)?.length ?? 0) * 100
    + (selector.match(/(^|[\s>+~])\s*[a-z][\w-]*/gi)?.length ?? 0);
}
function matches(element: Element, selector: string, pseudo: "" | "before" | "after"): boolean {
  const found = selector.match(/::?(before|after)\b/);
  if ((found?.[1] ?? "") !== pseudo) return false;
  const base = selector.replace(/::?(before|after)\b/g, "").replace(/:focus-visible\b/g, '[data-u91-focus="true"]');
  try { return element.matches(base); } catch { return false; }
}
export function declaration(element: Element, property: string, pseudo: "" | "before" | "after" = "",
  reduced = false, css = cssText()): string {
  const candidates = rules(css, reduced).filter(r => matches(element, r.selector, pseudo))
    .filter(r => r.style.getPropertyValue(property).trim());
  candidates.sort((a, b) => Number(a.style.getPropertyPriority(property) === "important")
    - Number(b.style.getPropertyPriority(property) === "important")
    || specificity(a.selector) - specificity(b.selector) || a.order - b.order);
  return candidates.at(-1)?.style.getPropertyValue(property).trim() ?? "";
}
export function hasAnimation(element: Element, pseudo: "" | "before" | "after" = "", reduced = false, css = cssText()): boolean {
  const short = declaration(element, "animation", pseudo, reduced, css);
  const name = declaration(element, "animation-name", pseudo, reduced, css);
  const value = short || name;
  if (!value || /^(none|initial|unset)\b/i.test(value)) return false;
  const duration = declaration(element, "animation-duration", pseudo, reduced, css);
  return !/^(0s|0ms)$/.test(duration) && !/(?:^|\s)0(?:s|ms)(?:\s|$)/.test(value);
}
export function expectStationary(root: ParentNode, reduced = false, css = cssText()) {
  const icons = [...root.querySelectorAll<HTMLElement>(".step-indicator, .status-icon, [data-activity] [aria-hidden='true']")];
  expect(icons.length, "Activity has a visible decorative indicator").toBeGreaterThan(0);
  for (const icon of icons) for (const pseudo of ["", "before", "after"] as const) {
    expect(hasAnimation(icon, pseudo, reduced, css), `Unexpected activity animation (${pseudo || "element"})`).toBe(false);
  }
}
export function icon(scope: HTMLElement): HTMLElement {
  const node = scope.querySelector<HTMLElement>(".step-indicator, .status-icon, [aria-hidden='true']");
  expect(node, "Activity needs an aria-hidden symbol alongside its text").not.toBeNull(); return node!;
}
export function visualSignature(element: HTMLElement): string {
  const properties = ["content", "background", "background-color", "background-image", "border", "border-color", "border-width",
    "border-style", "border-radius", "border-left", "border-bottom", "box-shadow", "transform", "clip-path", "mask", "mask-image"];
  return JSON.stringify({ text: element.textContent, children: element.innerHTML,
    styles: (["", "before", "after"] as const).map(pseudo => properties.map(p => declaration(element, p, pseudo))) });
}
// jsdom has no pseudo-element layout or native media emulation. Materialize the
// declarations selected by the CSSOM into a real element for computed-style checks.
// This checks authored reduced-motion rules; browser pixel QA remains integration work.
export function computedMotion(element: Element, pseudo: "" | "before" | "after", reduced: boolean): Pick<CSSStyleDeclaration, "animation" | "animationName" | "animationDuration"> {
  const probe = document.createElement("span");
  for (const property of ["animation", "animation-name", "animation-duration", "animation-iteration-count"]) {
    const value = declaration(element, property, pseudo, reduced);
    if (value) probe.style.setProperty(property, value);
  }
  document.body.append(probe); const computed = getComputedStyle(probe);
  const result = { animation: computed.animation, animationName: computed.animationName, animationDuration: computed.animationDuration };
  probe.remove(); return result;
}
export function token(name: string, theme: "light" | "dark"): string {
  document.documentElement.dataset.theme = theme;
  const value = declaration(document.documentElement, name);
  expect(value, `Defined ${theme} CSS token ${name}`).toBeTruthy(); return value;
}
function luminance(hex: string): number {
  expect(hex, "Contrast tokens must resolve to an opaque hex color").toMatch(/^#[a-f\d]{6}$/i);
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
export function contrast(foreground: string, background: string): number {
  const f = luminance(foreground), b = luminance(background); return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
}
