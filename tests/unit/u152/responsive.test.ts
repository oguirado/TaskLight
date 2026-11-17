import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESTINATIONS, mount, name, navButtons, visible } from "./helpers";

const css = readFileSync(resolve(__dirname, "../../../styles/views.css"), "utf8");

/** Project width media rules because this DOM environment does not evaluate media.
 * This checks CSS/DOM behavior, not rendered geometry or an accessibility-tree receipt.
 */
function mediaMatches(query: string, width: number): boolean {
  return query.split(",").some(branch => {
    const evaluated = branch.toLowerCase()
      .replace(/\((min|max)-width\s*:\s*([\d.]+)px\)/g, (_match, bound: string, amount: string) =>
        String(bound === "min" ? width >= Number(amount) : width <= Number(amount)))
      .replace(/\(width\s*(<=|>=|<|>)\s*([\d.]+)px\)/g, (_match, op: string, amount: string) => {
        const value = Number(amount);
        return String(op === "<=" ? width <= value : op === ">=" ? width >= value : op === "<" ? width < value : width > value);
      })
      .replace(/\(prefers-reduced-motion\s*:\s*(reduce|no-preference)\)/g, (_match, preference: string) => String(preference === "no-preference"))
      .replace(/\b(?:only\s+)?(?:screen|all)\b/g, "true")
      .replace(/\bprint\b/g, "false");
    const terms = evaluated.trim().split(/\s+and\s+/);
    expect(terms.every(term => /^(?:not\s+)?(?:true|false)$/.test(term.trim())), `unsupported media precondition: ${query}`).toBe(true);
    return terms.every(term => term.trim() === "true" || term.trim() === "not false");
  });
}

function installAt(width: number): void {
  const style = document.createElement("style");
  style.dataset.u152 = "";
  style.textContent = css;
  document.head.append(style);
  expect(style.sheet, "styles/views.css must parse before checking responsive rules").not.toBeNull();
  const project = (rules: CSSRuleList): string => [...rules].map(rule => {
    if (rule.type === CSSRule.MEDIA_RULE) {
      const media = rule as CSSMediaRule;
      return mediaMatches(media.conditionText, width) ? project(media.cssRules) : "";
    }
    return rule.cssText;
  }).join("\n");
  style.textContent = project(style.sheet!.cssRules);
}

function disclosureFor(root: HTMLElement): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('button[aria-expanded="false"][aria-controls],details:not([open]) > summary')]
    .find(toggle => {
      if (!visible(toggle) || !name(toggle)) return false;
      const target = toggle.tagName === "SUMMARY" ? toggle.parentElement
        : document.getElementById(toggle.getAttribute("aria-controls") ?? "");
      return !!target && (navButtons(target).length > 0 || /navigation|menu|views/i.test(name(toggle)));
    });
}

function compactNavigation(root: HTMLElement): boolean {
  const buttons = navButtons(root);
  const disclosure = disclosureFor(root);
  if (disclosure && (buttons.length === 0 || buttons.some(button => !visible(button)))) return true;
  if (!buttons.length || buttons.some(button => !visible(button))) return false;
  // A compact icon rail is also allowed, provided controls retain accessible names.
  const labels = [...root.querySelectorAll<HTMLElement>(".nav-label")];
  if (labels.length && labels.every(label => !visible(label))) return buttons.every(button => !!name(button));
  // A compact horizontal or multi-column navigation is allowed instead of a menu.
  const groups = new Set(buttons.map(button => button.closest('nav,[role="navigation"],[role="tablist"]')));
  const multiItemGroups = [...groups].filter((group): group is HTMLElement => group instanceof HTMLElement && navButtons(group).length > 1);
  return multiItemGroups.length > 0 && multiItemGroups.every(group => {
    const style = getComputedStyle(group);
    return (/^(?:inline-)?flex$/.test(style.display) && /^(?:row|row-reverse)$/.test(style.flexDirection))
      || (/^(?:inline-)?grid$/.test(style.display) && (style.gridAutoFlow.includes("column")
        || /repeat\(\s*(?:[2-9]\d*|auto-fit|auto-fill)|\S+\s+\S+/.test(style.gridTemplateColumns)));
  });
}

describe("U152 AC4 narrow navigation", () => {
  it("AC4 collapses navigation at 390px instead of only stacking the expanded sidebar", () => {
    installAt(390);
    const { host } = mount();
    expect(compactNavigation(host), "at 390px navigation must use an accessible disclosure, compact named icon rail, or compact row/grid").toBe(true);
  });

  it("AC4 all six destinations remain named and usable at 390px, after opening a collapsed menu if present", () => {
    installAt(390);
    const { host, onView } = mount();
    disclosureFor(host)?.click();
    expect(navButtons(host).map(button => button.dataset.nav)).toEqual(DESTINATIONS.map(([view]) => view));
    for (const [view, label] of DESTINATIONS) {
      // Each selection can collapse the menu, so reacquire and reopen between operations.
      disclosureFor(host)?.click();
      const button = navButtons(host).find(item => item.dataset.nav === view);
      expect(button).toBeDefined();
      expect(visible(button!)).toBe(true);
      expect(name(button!)).toBe(label);
      expect(button!.disabled).toBe(false);
      button!.click();
      expect(onView).toHaveBeenLastCalledWith(view);
    }
    expect(onView).toHaveBeenCalledTimes(DESTINATIONS.length);
  });
});
