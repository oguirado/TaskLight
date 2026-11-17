import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

// Keep the production order: tokens, views, then plan overrides.
const readStyle = (name: string): string => readFileSync(resolve(__dirname, "../../../styles", `${name}.css`), "utf8");
export const sources = { tokens: readStyle("tokens"), views: readStyle("views"), plan: readStyle("plan") };
export const cssText = [sources.tokens, sources.views, sources.plan].join("\n");
export const themes = ["light", "dark"] as const;
export type Theme = typeof themes[number];
export interface Environment { theme?: Theme; width?: number; reduced?: boolean; preferenceClass?: boolean }

function mediaMatches(query: string, width: number, reduced: boolean): boolean {
  return query.split(",").some(branch => {
    let matches = true;
    const rest = branch.replace(/\((min|max)-width\s*:\s*([\d.]+)(px|rem|em)\)/g,
      (_all, bound: string, amount: string, unit: string) => {
        const limit = Number(amount) * (unit === "px" ? 1 : 16);
        matches &&= bound === "max" ? width <= limit : width >= limit;
        return "";
      }).replace(/\(prefers-reduced-motion\s*:\s*(reduce|no-preference)\)/g,
      (_all, preference: string) => { matches &&= reduced === (preference === "reduce"); return ""; })
      .replace(/\b(?:all|screen|and)\b/g, "").trim();
    expect(rest, `Unsupported media precondition: ${branch}`).toBe("");
    return matches;
  });
}

/** Select media branches explicitly; jsdom does not perform viewport layout. */
export function activateCSS(env: Environment = {}, css = cssText): CSSStyleRule[] {
  document.head.querySelectorAll("style[data-u151]").forEach(node => node.remove());
  document.documentElement.dataset.theme = env.theme ?? "light";
  document.documentElement.classList.toggle("ui-reduced-motion", env.preferenceClass ?? false);
  const original = document.createElement("style");
  original.dataset.u151 = "source";
  original.textContent = css;
  document.head.append(original);
  expect(original.sheet, "Production styles must parse").not.toBeNull();
  const selected: string[] = [];
  const rules: CSSStyleRule[] = [];
  function visit(list: CSSRuleList): void {
    for (const rule of list) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        const media = rule as CSSMediaRule;
        if (mediaMatches(media.conditionText, env.width ?? 1440, env.reduced ?? false)) visit(media.cssRules);
      } else if (rule.type === CSSRule.STYLE_RULE) {
        const style = rule as CSSStyleRule;
        rules.push(style);
        selected.push(style.cssText);
        // Materialize pseudo declarations for computed-style assertions. These
        // empty probes represent pseudo layers, never browser pixels or layout.
        if (/::(?:before|after)\b/.test(style.selectorText)) selected.push(
          `${style.selectorText.replace(/::(before|after)\b/g, ' > [data-u151-pseudo="$1"]')} { ${style.style.cssText} }`,
        );
      } else {
        expect(rule.type, "No network imports in CSS assertions").not.toBe(CSSRule.IMPORT_RULE);
        selected.push(rule.cssText);
      }
    }
  }
  visit(original.sheet!.cssRules);
  original.remove();
  const active = document.createElement("style");
  active.dataset.u151 = "active";
  active.textContent = selected.join("\n");
  document.head.append(active);
  expect(active.sheet, "Selected CSS must parse").not.toBeNull();
  return rules;
}

export function pseudoLayers(root: ParentNode): void {
  for (const icon of root.querySelectorAll(".step-indicator, .status-icon, .wall-agent-dot, .ws-running")) {
    for (const side of ["before", "after"]) {
      const probe = document.createElement("span");
      probe.dataset.u151Pseudo = side;
      probe.setAttribute("aria-hidden", "true");
      icon.append(probe);
    }
  }
}

export function q(root: ParentNode, selector: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector);
  expect(node, `Existing markup contract: ${selector}`).not.toBeNull();
  return node!;
}

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function rotates(icon: HTMLElement): boolean {
  const names = new Set<string>();
  function visit(list: CSSRuleList): void {
    for (const rule of list) if (rule.type === CSSRule.KEYFRAMES_RULE) {
      const frames = rule as CSSKeyframesRule;
      if (/\brotate(?:[XYZ])?\s*\(|\brotate\s*:/i.test(frames.cssText)) names.add(frames.name);
    }
  }
  for (const sheet of document.styleSheets) visit(sheet.cssRules);
  return [icon, ...icon.querySelectorAll<HTMLElement>("[data-u151-pseudo]")].some(layer => {
    const style = getComputedStyle(layer);
    return style.animationName.split(",").some((name, index) => {
      const durations = style.animationDuration.split(",");
      const duration = durations[index % durations.length] ?? "0s";
      return names.has(name.trim()) && parseFloat(duration) > 0 && style.animationPlayState !== "paused"
        && style.animationIterationCount !== "0";
    });
  });
}

export function shape(icon: HTMLElement): string {
  const properties = ["display", "visibility", "opacity", "content", "background-color", "background-image",
    "color", "font-size", "width", "height", "clip-path", "mask", "mask-image",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-style",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-radius", "box-shadow"];
  return JSON.stringify({ text: icon.textContent, layers: [icon, ...icon.querySelectorAll<HTMLElement>("[data-u151-pseudo]")]
    .map(layer => properties.map(property => getComputedStyle(layer).getPropertyValue(property))) });
}

export function expectVisible(node: HTMLElement, boundary: HTMLElement): void {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    expect(current.hidden, "Status word must remain visible").toBe(false);
    expect(style.display).not.toBe("none");
    expect(style.visibility).not.toMatch(/hidden|collapse/);
    expect(Number(style.opacity || "1"), "No opacity dimming").toBe(1);
    if (current === boundary) break;
  }
}

export function expectNaturalHeight(node: HTMLElement): void {
  const style = getComputedStyle(node);
  for (const property of ["height", "block-size"]) {
    const value = style.getPropertyValue(property).trim();
    expect(value, `No fixed ${property} on ${node.className}`).toMatch(/^(?:|auto|min-content|max-content|fit-content)$/);
  }
}
