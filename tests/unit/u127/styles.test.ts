import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "./browser";
import { aliases, aliasProbe, css, markup, motionProbe, sources, spacingViolations, styleNames } from "./fixtures";

const browser = new Browser();
let html: string;
beforeAll(async () => { html = markup(); await browser.start(); }, 20_000);
afterAll(async () => { await browser.close(); });

type AliasResult = { alias: string; actual: { raw: string; color: string }; expected: { raw: string; color: string } };
function paletteProblems(rows: AliasResult[]): string[] {
  return rows.filter(row => !row.actual.raw || !row.expected.raw || row.actual.color !== row.expected.color).map(row => row.alias);
}
type MotionResult = {
  values: { node: string; name: string; raw: string; milliseconds: number }[];
  layers: { node: string; pseudo: string | null; animation: string; transition: string }[];
  working: string; visible: boolean;
};
function motionProblems(result: MotionResult): unknown[] {
  return [...result.values.filter(value => !value.raw || value.milliseconds !== 0),
    ...result.layers.filter(layer => [layer.animation, layer.transition].some(values =>
      values.split(",").some(value => parseFloat(value) !== 0))),
    ...(!result.visible || result.working !== "Working" ? ["Working text disappeared"] : [])];
}
const decoration = `.u127-decoration::before, .u127-decoration::after {
  content: ''; animation-duration: 123ms; transition-duration: 123ms;
}`;
const motionHTML = () => html.replace('class="app"', 'class="app u127-decoration" style="animation-duration:123ms;transition-duration:123ms"')
  .replace('</main>', '<span class="u127-decoration" style="animation-duration:123ms;transition-duration:123ms">Decoration</span></main>');

function withoutReducedRules(text: string): string {
  const style = document.createElement("style"); style.textContent = text; document.head.append(style);
  const filter = (rules: CSSRuleList): string => [...rules].map(rule => {
    if (rule instanceof CSSMediaRule) return /prefers-reduced-motion/.test(rule.conditionText)
      ? "" : `@media ${rule.conditionText} { ${filter(rule.cssRules)} }`;
    if (rule instanceof CSSStyleRule && rule.selectorText.includes("ui-reduced-motion")) return "";
    return rule.cssText;
  }).join("\n");
  const result = filter(style.sheet!.cssRules); style.remove(); return result;
}

describe("A1 / M2 canonical theme aliases", () => {
  it.each(["default", "light", "dark"])("A1 resolves all eight aliases in the rendered %s theme", async theme => {
    await browser.load(css, html, theme === "default" ? {} : { theme });
    expect(paletteProblems(await browser.evaluate<AliasResult[]>(aliasProbe))).toEqual([]);
    // Coincidentally equal literals are not aliases: canonical changes must propagate.
    const overrides = aliases.map(([, canonical], index) => `${canonical}: rgb(${index + 1},2,3) !important;`).join(" ");
    await browser.evaluate(`document.head.append(Object.assign(document.createElement('style'), {
      textContent: ${JSON.stringify(`:root { ${overrides} }`)}
    }))`);
    expect(paletteProblems(await browser.evaluate<AliasResult[]>(aliasProbe))).toEqual([]);
  });
  it.each(["swarm", "narrator"] as const)("M2/B2 %s has no raw colour literals", name => {
    const declarations = sources[name].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations.match(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/gi) ?? []).toEqual([]);
  });
  it("A6 negative M2 detects an independent legacy palette with the A1 oracle", async () => {
    await browser.load(css + ":root { --color-bg: rgb(1,2,3) !important; }", html);
    expect(paletteProblems(await browser.evaluate<AliasResult[]>(aliasProbe))).toContain("--color-bg");
  });
  it.each(["light", "dark"])("M7/B4 state, blocker and provenance text has a nonzero contrasting box in %s", async theme => {
    await browser.load(css, html, { theme });
    const rows = await browser.evaluate<{ text: string; visible: boolean; distinct: boolean }[]>(`(() => {
      const selectors = ['.swarm-activity', '.swarm-dependency', '.narrator-source', '.narrator-text'];
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(node => {
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        let background = node;
        while (background.parentElement && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement;
        return { text: node.textContent, visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible',
          distinct: style.color !== getComputedStyle(background).backgroundColor };
      }));
    })()`);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.every(row => row.visible && row.distinct)).toBe(true);
    expect(rows.map(row => row.text).join(" ")).toMatch(/Failed.*Liveness unknown.*executor-b.*Rules summary/);
  });
});

const focusProbe = `(() => {
  const node = document.activeElement; const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
  const colour = document.createElement('i'); colour.style.color = 'var(--c-focus)';
  if (node instanceof HTMLInputElement) {
    // A-U127a: Inputs cannot render children; resolve their focus token on a sibling,
    // while measuring the outline and unclipped box on the focused input itself.
    colour.style.color = style.getPropertyValue('--c-focus'); node.after(colour);
  } else node.append(colour);
  const expected = getComputedStyle(colour).color; colour.remove();
  let unclipped = rect.left >= 4 && rect.right <= innerWidth - 4 && rect.top >= 4 && rect.bottom <= innerHeight - 4;
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const box = parent.getBoundingClientRect(), css = getComputedStyle(parent);
    if (/hidden|clip|scroll|auto/.test(css.overflowX)) unclipped &&= rect.left - 4 >= box.left && rect.right + 4 <= box.right;
    if (/hidden|clip|scroll|auto/.test(css.overflowY)) unclipped &&= rect.top - 4 >= box.top && rect.bottom + 4 <= box.bottom;
  }
  return { selector: node.className, width: style.outlineWidth, style: style.outlineStyle, colour: style.outlineColor,
    offset: style.outlineOffset, expected, keyboard: node.matches(':focus-visible'), unclipped,
    visible: rect.width > 0 && rect.height > 0 };
})()`;
type FocusResult = { selector: string; width: string; style: string; colour: string; offset: string;
  expected: string; keyboard: boolean; unclipped: boolean; visible: boolean };
function focusProblems(result: FocusResult): string[] {
  return Object.entries({ width: result.width === "2px", style: result.style === "solid", colour: result.colour === result.expected,
    offset: result.offset === "2px", keyboard: result.keyboard, visible: result.visible, unclipped: result.unclipped })
    .filter(([, ok]) => !ok).map(([name]) => name);
}
async function tabTo(selector: string): Promise<FocusResult> {
  // Start just before the actual control; Tab establishes keyboard focus, not a synthetic :focus state.
  await browser.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('HOLD: expected control is absent');
    const sentinel = document.createElement('button'); sentinel.dataset.u127Sentinel = '';
    node.before(sentinel); sentinel.focus();
  })()`);
  await browser.tab();
  const matched = await browser.evaluate<boolean>(`document.activeElement.matches(${JSON.stringify(selector)})`);
  expect(matched, "Keyboard fixture must reach the intended control").toBe(true);
  await browser.evaluate(`document.querySelector('[data-u127-sentinel]').remove(); document.activeElement.scrollIntoView({block:'center'});`);
  return browser.evaluate<FocusResult>(focusProbe);
}

describe("A2 / M3 rendered keyboard focus", () => {
  it.each([".swarm-task-open", ".swarm-detail-close", ".swarm-metadata-toggle", ".narrator-refresh",
    ".models-trigger", ".model-sheet-scope-select", ".model-row-radio", ".model-sheet-close", ".phase-chip", ".wall-banner"])(
    "A2 uniform unclipped focus after Tab and scroll: %s", async selector => {
      await browser.load(css, html);
      // Check each overlay state separately: a fixed open sheet must not occlude background controls.
      if (!selector.startsWith(".model-") && selector !== ".model-sheet-close") {
        await browser.evaluate(`document.querySelector('.model-sheet').dataset.open = 'false'`);
      }
      expect(focusProblems(await tabTo(selector)), selector).toEqual([]);
    });
  it("A6 negative M3 detects accent focus and the wrong offset with the A2 oracle", async () => {
    await browser.load(css + ".app .swarm-task-open:focus-visible { outline: 2px solid var(--c-accent) !important; outline-offset: 4px !important; }", html);
    await browser.evaluate(`document.querySelector('.model-sheet').dataset.open = 'false'`);
    const problems = focusProblems(await tabTo(".swarm-task-open"));
    expect(problems).toContain("colour"); expect(problems).toContain("offset");
  });
  it("A6 negative M3 detects accent focus and the wrong offset on .model-row-radio with the A2 oracle", async () => {
    await browser.load(css + ".app .model-row-radio:focus-visible { outline: 2px solid var(--c-accent) !important; outline-offset: 4px !important; }", html);
    const problems = focusProblems(await tabTo(".model-row-radio"));
    expect(problems).toContain("colour"); expect(problems).toContain("offset");
  });
});

describe("A3 / M4 reduced motion independently", () => {
  it.each(["app-class", "document-class", "os"] as const)("A3 %s makes all duration tokens zero throughout the application", async trigger => {
    await browser.load(css, html, { rootClass: trigger === "app-class", documentClass: trigger === "document-class", reduced: trigger === "os" });
    const result = await browser.evaluate<MotionResult>(motionProbe);
    expect(result.values.filter(value => !value.raw || value.milliseconds !== 0)).toEqual([]);
    expect(result.visible && result.working === "Working").toBe(true);
  });
  it.each(["app-class", "document-class", "os"] as const)("A3/B1 %s overrides root, descendant and pseudo-element decorative durations", async trigger => {
    await browser.load(css + decoration, motionHTML(), { rootClass: trigger === "app-class", documentClass: trigger === "document-class", reduced: trigger === "os" });
    expect(motionProblems(await browser.evaluate<MotionResult>(motionProbe))).toEqual([]);
  });
  it("A3 preserves ordinary motion without either preference", async () => {
    await browser.load(css, html);
    const result = await browser.evaluate<MotionResult>(motionProbe);
    expect(result.values.every(value => value.raw && value.milliseconds > 0)).toBe(true);
    const ring = await browser.evaluate<{ name: string; duration: string }>(`(() => {
      const style = getComputedStyle(document.querySelector('.step-indicator'), '::before');
      return { name: style.animationName, duration: style.animationDuration };
    })()`);
    expect(ring.name).not.toBe("none"); expect(parseFloat(ring.duration)).toBeGreaterThan(0);
  });
  it("A3 negative base-only override retains derived additions and is rejected by the same oracle", async () => {
    const mutant = withoutReducedRules(css) + ".ui-reduced-motion { --motion-duration: 0ms; }";
    expect(mutant).toContain("calc(var(--motion-duration) + 100ms)");
    await browser.load(mutant, html, { rootClass: true });
    const result = await browser.evaluate<MotionResult>(motionProbe);
    expect(result.values).toHaveLength(12);
    expect(motionProblems(result).length).toBeGreaterThan(0);
  });
});

const overflowProbe = `(() => {
  const nodes = [document.documentElement, document.body, document.querySelector('.app'),
    document.querySelector('.swarm-view'), document.querySelector('.model-sheet'), document.querySelector('.main > [role="status"]')];
  return nodes.map(node => ({ name: node.className || node.tagName, width: node.clientWidth, scroll: node.scrollWidth,
    nonzero: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 }));
})()`;
type OverflowResult = { name: string; width: number; scroll: number; nonzero: boolean };
function overflowProblems(rows: OverflowResult[]): OverflowResult[] {
  return rows.filter(row => !row.nonzero || row.scroll > row.width);
}

describe("A5 / M5 spacing and hostile geometry", () => {
  it.each(styleNames.filter(name => name !== "agents"))("M5/B4 %s spacing above 2px uses the scale or a justified optical exception", name => {
    expect(spacingViolations(sources[name])).toEqual([]);
  });
  it("A6 negative M5 detects raw spacing; a declaration-local optical justification is allowed", () => {
    expect(spacingViolations(".step-detail { padding: 14px; }")).toHaveLength(1);
    expect(spacingViolations(".step-detail { padding: var(--sp-3); }")).toEqual([]);
    expect(spacingViolations(".icon { margin-top: 3px; /* optical: aligns the glyph baseline */ }")).toEqual([]);
    expect(spacingViolations(".icon { margin-top: 3px; /* optical: */ }")).toHaveLength(1);
  });
  it.each([[390, 844, 1], [768, 1024, 1], [1440, 900, 1], [390, 844, 2], [768, 1024, 2], [1440, 900, 2]])(
    "A5/B4 120-character rooms, Swarm and Models wrap at %ix%i, reflow scale %i", async (width, height, scale) => {
    // Reflow proxy only; actual browser UI zoom remains an external capsule gate.
    await browser.load(css, markup(true), { width: width / scale, height: height / scale });
    const problems = overflowProblems(await browser.evaluate<OverflowResult[]>(overflowProbe));
    expect(problems, JSON.stringify(problems)).toEqual([]);
    const reachable = await browser.evaluate<boolean>(`(() => {
      const close = document.querySelector('.model-sheet-close'); close.scrollIntoView({block:'center'});
      const rect = close.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
    })()`);
    expect(reachable).toBe(true);
  });
  it.each([[390, 844], [768, 1024], [1440, 900]])("M5 Models follows the responsive drawer bounds at %ix%i", async (width, height) => {
    await browser.load(css, html, { width, height });
    const geometry = await browser.evaluate<{ actual: string[]; expected: string[] }>(`(() => {
      const sheet = document.querySelector('.model-sheet'); const drawer = document.createElement('div');
      drawer.className = 'chat-drawer'; for (const child of sheet.children) drawer.append(child.cloneNode(true)); document.querySelector('.app').append(drawer);
      const measure = node => { const style = getComputedStyle(node); return [style.right, style.bottom, style.left, style.width, style.maxHeight]; };
      return { actual: measure(sheet), expected: measure(drawer) };
    })()`);
    expect(geometry.actual).toEqual(geometry.expected);
  });
  it("M5 preserves separate wide Diary time/body columns", async () => {
    await browser.load(css, html);
    const separated = await browser.evaluate<boolean>(`(() => {
      const entry = document.querySelector('.entry'), time = entry.querySelector('.entry-time'), body = entry.querySelector('.entry-body');
      const a = time.getBoundingClientRect(), b = body.getBoundingClientRect();
      return time.parentElement === body.parentElement && a.width > 0 && b.width > 0 && a.right <= b.left;
    })()`);
    expect(separated).toBe(true);
  });
  it("A6 negative M5 detects horizontal overflow with the same hostile geometry oracle", async () => {
    await browser.load(css + '.app [role="status"] { white-space: nowrap !important; overflow-wrap: normal !important; }', markup(true), { width: 390, height: 844 });
    expect(overflowProblems(await browser.evaluate<OverflowResult[]>(overflowProbe)).length).toBeGreaterThan(0);
  });
});
