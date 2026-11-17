import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

export const swarmCSS = readFileSync(resolve("styles/swarm.css"), "utf8");
const tokens = readFileSync(resolve("styles/tokens.css"), "utf8");
type Environment = { width: number; reduced: boolean };
let env: Environment = { width: 1440, reduced: false };
let rules: CSSStyleRule[] = [];

function mediaMatches(query: string): boolean {
  if (/prefers-reduced-motion:\s*reduce\b/.test(query) && !env.reduced) return false;
  if (/prefers-reduced-motion:\s*no-preference/.test(query) && env.reduced) return false;
  for (const match of query.matchAll(/(min|max)-width:\s*([\d.]+)(px|rem|em)/g)) {
    const threshold = Number(match[2]) * (match[3] === "px" ? 1 : 16);
    if (match[1] === "min" ? env.width < threshold : env.width > threshold) return false;
  }
  return true;
}
export function styles(width = 1440, reduced = false, theme: "light" | "dark" = "light"): void {
  env = { width, reduced }; rules = []; document.documentElement.dataset.theme = theme;
  for (const sheet of [tokens, swarmCSS]) {
    const style = document.createElement("style"); style.dataset.v1Oracle = "true"; style.textContent = sheet; document.head.append(style);
    expect(style.sheet, "Existing board CSS must parse").not.toBeNull();
    function visit(items: CSSRuleList): void {
      for (const rule of items) {
        if (rule.type === CSSRule.STYLE_RULE) rules.push(rule as CSSStyleRule);
        else if (rule.type === CSSRule.MEDIA_RULE) {
          const media = rule as CSSMediaRule; if (mediaMatches(media.conditionText)) visit(media.cssRules);
        } else if ("cssRules" in rule && rule.type !== CSSRule.KEYFRAMES_RULE) visit((rule as CSSGroupingRule).cssRules);
      }
    }
    visit(style.sheet!.cssRules);
  }
}
function selectorParts(selector: string): string[] {
  let depth = 0, start = 0; const result: string[] = [];
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === "(") depth++;
    if (selector[i] === ")") depth--;
    if (selector[i] === "," && depth === 0) { result.push(selector.slice(start, i)); start = i + 1; }
  }
  result.push(selector.slice(start)); return result;
}
export function declarations(node: Element, pseudo = ""): Record<string, string> {
  const result: Record<string, string> = {};
  function copy(style: CSSStyleDeclaration): void {
    for (let i = 0; i < style.length; i++) { const key = style.item(i); result[key] = style.getPropertyValue(key); }
  }
  for (const rule of rules) {
    const matches = selectorParts(rule.selectorText).some(raw => {
      const found = raw.match(/::(before|after)/)?.[0] ?? "";
      if (found !== pseudo) return false;
      try { return node.matches(raw.replace(/::(before|after)/g, "")); } catch { return false; }
    });
    if (matches) copy(rule.style);
  }
  if (!pseudo && (node instanceof HTMLElement || node instanceof SVGElement)) copy(node.style);
  return result;
}
export function resolved(node: Element, pseudo = ""): Record<string, string> {
  const ancestors: Element[] = []; for (let at: Element | null = node; at; at = at.parentElement) ancestors.unshift(at);
  const variables: Record<string, string> = {};
  for (const at of ancestors) for (const [key, value] of Object.entries(declarations(at))) if (key.startsWith("--")) variables[key] = value;
  function expand(value: string, remaining = 16): string {
    if (remaining === 0) return value;
    const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, key: string, fallback: string | undefined) => variables[key] ?? fallback ?? "unresolved");
    return next === value ? value : expand(next, remaining - 1);
  }
  return Object.fromEntries(Object.entries(declarations(node, pseudo)).map(([key, value]) => [key, expand(value)]));
}
function px(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^([\d.]+)(px|rem|em)?$/);
  return match ? Number(match[1]) * (match[2] && match[2] !== "px" ? 16 : 1) : undefined;
}
export function geometry(root: Element, diameter: number): Element {
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const pseudo of ["", "::before", "::after"]) {
      const d = resolved(node, pseudo);
      const width = px(d["inline-size"] ?? d.width ?? node.getAttribute("width") ?? undefined);
      const height = px(d["block-size"] ?? d.height ?? node.getAttribute("height") ?? undefined);
      if (width === diameter && height === diameter) return node;
    }
  }
  expect.fail(`M4 a reserved ${diameter}px bubble must be declared for this content`);
}
export function drawing(root: Element): string {
  const evidence: unknown[] = [];
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const pseudo of ["", "::before", "::after"]) evidence.push(Object.entries(resolved(node, pseudo))
      .filter(([key]) => /^(background|mask|clip-path|fill|stroke|border|transform|content)/.test(key)));
    if (node instanceof SVGElement) evidence.push([...node.attributes].filter(a => /^(d|stroke|fill|r|cx|cy|pathLength)/.test(a.name)).map(a => [a.name, a.value]));
  }
  return JSON.stringify(evidence);
}
export function indentation(root: Element): boolean {
  for (let node: Element | null = root; node && node !== document.body; node = node.parentElement) {
    const d = resolved(node);
    if ([d["padding-inline-start"], d["margin-inline-start"], d["padding-left"], d["margin-left"]].some(v => (px(v) ?? 0) > 0)) return true;
  }
  return false;
}
export function animation(root: Element): string {
  return [root, ...root.querySelectorAll("*")].flatMap(node => ["", "::before", "::after"].map(p => {
    const d = resolved(node, p); return `${d.animation ?? ""} ${d["animation-name"] ?? ""} ${d["animation-duration"] ?? ""}`.trim();
  })).filter(s => s && !/^(none|0s|none 0s)$/.test(s)).join(" ");
}
export function dimmed(root: Element): boolean {
  for (let node: Element | null = root; node && node !== document.body; node = node.parentElement) {
    const d = resolved(node), opacity = Number(d.opacity);
    if (d.opacity && opacity >= 0 && opacity < 1 || /opacity\((0?\.\d+|[1-9]?\d%)\)/.test(d.filter ?? "")) return true;
  }
  return false;
}

/** Follow only variables actually used by paint declarations, allowing existing token aliases. */
export function paintTokens(root: Element): Set<string> {
  const found = new Set<string>();
  for (const node of [root, ...root.querySelectorAll("*")]) {
    const variables: Record<string, string> = {};
    const ancestors: Element[] = []; for (let at: Element | null = node; at; at = at.parentElement) ancestors.unshift(at);
    for (const at of ancestors) for (const [key, value] of Object.entries(declarations(at))) if (key.startsWith("--")) variables[key] = value;
    const visit = (value: string, seen = new Set<string>()): void => {
      for (const match of value.matchAll(/var\((--[\w-]+)/g)) {
        const key = match[1]!; found.add(key);
        if (!seen.has(key)) { const next = new Set(seen); next.add(key); visit(variables[key] ?? "", next); }
      }
    };
    for (const pseudo of ["", "::before", "::after"]) for (const [key, value] of Object.entries(declarations(node, pseudo))) {
      if (/^(background|color|fill|stroke|border|outline)/.test(key)) visit(value);
    }
  }
  return found;
}
