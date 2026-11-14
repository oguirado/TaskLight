import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const raw = (n: string) => existsSync(join(REPO, "styles", n)) ? readFileSync(join(REPO, "styles", n), "utf8") : "";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const views = () => strip(raw("views.css"));
const tokens = () => strip(raw("tokens.css"));
const real = () => { expect(views().trim().length, "styles/views.css is still the stub").toBeGreaterThan(2000); };

/** Every `selector { body }` pair whose body has no nested braces (works inside @media). */
const rules = (css: string): { sel: string; body: string }[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? "").trim(), body: m[2] ?? "" }));
const decls = (body: string): [string, string][] =>
  body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(":"); return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as [string, string]; });
const names = (body: string, re: RegExp) => decls(body).map(([p]) => p).filter((p) => re.test(p));

/** Removes `@media (...prefers-reduced-motion...) { ... }` blocks by brace matching. */
function stripReducedMotion(css: string): string {
  let out = css, i: number;
  while ((i = out.search(/@media[^{]*prefers-reduced-motion/)) >= 0) {
    const open = out.indexOf("{", i);
    let depth = 0, j = open;
    for (; j < out.length; j++) { if (out[j] === "{") depth++; else if (out[j] === "}" && --depth === 0) break; }
    out = out.slice(0, i) + out.slice(j + 1);
  }
  return out;
}
const reducedMotionBlocks = (css: string): string[] => {
  const res: string[] = [];
  for (const m of css.matchAll(/@media[^{]*prefers-reduced-motion[^{]*\{/g)) {
    let depth = 1, j = (m.index ?? 0) + m[0].length;
    const s = j;
    for (; j < css.length && depth > 0; j++) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; }
    res.push(css.slice(s, j - 1));
  }
  return res;
};

/* ---- views.css -------------------------------------------------------------------------- */

describe("U36 styles/views.css: not a stub", () => {
  it("is a real stylesheet covering the markup contract", () => {
    const v = views();
    expect(raw("views.css")).not.toMatch(/U36 stub/);
    expect(v.trim().length).toBeGreaterThan(5000);
    for (const sel of [".app", ".rail", ".topbar", ".focus", ".task", ".step-row", ".step-detail", ".status", ".source", ".agenda-item", ".entry", ".archived", ".workspace", ".nav-item", ".theme-toggle", ".progress-fill"]) {
      expect(v, sel).toContain(sel);
    }
    expect(v).toMatch(/:focus-visible/);
  });

  it(".visually-hidden uses a clip pattern", () => {
    const r = rules(views()).filter((x) => /(^|,|\s)\.visually-hidden\b/.test(x.sel));
    expect(r.length).toBeGreaterThan(0);
    const body = r.map((x) => x.body).join(";");
    expect(body).toMatch(/position\s*:\s*absolute/);
    expect(body).toMatch(/clip(-path)?\s*:/);
    expect(body).toMatch(/(width|height)\s*:\s*1px|overflow\s*:\s*hidden/);
  });

  it("hidden step details and focus are not shown (respects the hidden attribute)", () => {
    real();
    const v = views();
    expect(v).not.toMatch(/\.step-detail\s*\{[^}]*display\s*:\s*(block|grid|flex)[^}]*\}(?![\s\S]*\[hidden\])/);
  });
});

describe("U36 styles/views.css: colour only from custom properties", () => {
  const NAMED = new Set(["red", "green", "blue", "white", "black", "gray", "grey", "yellow", "orange", "purple", "pink", "brown", "cyan", "magenta", "navy", "teal", "silver", "gold", "maroon", "olive", "lime", "aqua", "fuchsia", "indigo", "violet", "crimson", "coral", "salmon", "tomato", "khaki"]);
  const COLOR_PROP = /(color|background|border|outline|fill|stroke|shadow|caret|accent|gradient)/;

  it("no hex literals", () => { real(); expect(views()).not.toMatch(/#[0-9a-f]{3,8}\b/i); });
  it("no rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()/color()", () => {
    real();
    expect(views()).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i);
  });
  it("no named colour keywords in colour-bearing declarations", () => {
    real();
    for (const r of rules(views())) for (const [p, v] of decls(r.body)) {
      if (!COLOR_PROP.test(p) || p.startsWith("--")) continue;
      const words = v.replace(/var\([^)]*\)/g, " ").split(/[\s,()/]+/).map((w) => w.toLowerCase());
      for (const w of words) expect(NAMED.has(w), `${r.sel} { ${p}: ${v} }`).toBe(false);
    }
  });
  it("only uses custom properties that tokens.css or views.css defines (plus --p, set by the view)", () => {
    const defined = new Set([...(tokens() + views()).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? ""));
    const used = [...views().matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? "");
    expect(used.length).toBeGreaterThan(20);
    const tok = new Set([...tokens().matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? ""));
    expect(tok.size).toBeGreaterThan(20); // tokens.css must really be replaced
    for (const u of used) expect(defined.has(u) || u === "--p" || u === "--motion-duration", u).toBe(true);
  });
  it("colour tokens are referenced (not duplicated as literals): at least 30 var(--c-*) uses", () => {
    expect([...views().matchAll(/var\(\s*--c-/g)].length).toBeGreaterThanOrEqual(30);
  });
});

describe("U36 styles: forbidden constructs", () => {
  it.each([["views.css", views], ["tokens.css", tokens]] as const)("no !important in %s", (_n, get) => {
    expect(get().length).toBeGreaterThan(100);
    expect(get()).not.toMatch(/!\s*important/i);
  });
  it("no #id selectors in views.css (selectors only; hex colours are a separate rule)", () => {
    expect(views().length).toBeGreaterThan(100);
    for (const r of rules(views())) expect(r.sel, r.sel).not.toMatch(/#[A-Za-z_-]/);
  });
  it("no #id selector anywhere in views.css text", () => {
    real();
    expect(views()).not.toMatch(/#[A-Za-z_][\w-]*/);
  });
  it("no remote URLs: url(http...), protocol-relative, @import, @font-face src from the network", () => {
    expect(views().length).toBeGreaterThan(100);
    for (const css of [views(), tokens()]) {
      expect(css).not.toMatch(/url\(\s*["']?\s*(https?:)?\/\//i);
      expect(css).not.toMatch(/@import/i);
      expect(css).not.toMatch(/https?:\/\//i);
    }
  });
});

describe("U36 styles: motion", () => {
  const defs = () => {
    const m = new Map<string, string[]>();
    for (const css of [tokens(), views()]) for (const x of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) m.set(x[1] ?? "", [...(m.get(x[1] ?? "") ?? []), (x[2] ?? "").trim()]);
    return m;
  };
  const derives = (name: string, d: Map<string, string[]>, seen = new Set<string>()): boolean => {
    if (name === "--motion-duration") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (d.get(name) ?? []).some((v) => [...v.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => derives(m[1] ?? "", d, seen)));
  };

  it("tokens.css defines --motion-duration as a non-zero time", () => {
    expect(tokens()).toMatch(/--motion-duration\s*:\s*(?!0m?s)[^;]+;/);
  });

  it("every transition/animation duration outside the reduced-motion block goes through var(--motion-duration) or a token derived from it", () => {
    const css = stripReducedMotion(views());
    const d = defs();
    let seen = 0;
    for (const r of rules(css)) for (const [p, v] of decls(r.body)) {
      if (!/^(transition|animation)(-duration)?$/.test(p)) continue;
      seen++;
      if (/^none$/i.test(v)) continue;
      const vars = [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? "");
      const noVars = v.replace(/var\([^)]*\)/g, " ");
      expect(noVars, `literal time in ${r.sel} { ${p}: ${v} }`).not.toMatch(/(^|[\s,])-?\d*\.?\d+m?s\b/);
      expect(vars.some((x) => derives(x, d)), `${r.sel} { ${p}: ${v} }`).toBe(true);
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("derived duration tokens (--dur-*) in tokens.css all derive from --motion-duration", () => {
    const d = defs();
    const durs = [...d.keys()].filter((k) => /^--dur-/.test(k));
    expect(durs.length, "tokens.css defines no --dur-* tokens").toBeGreaterThan(0);
    for (const k of durs) expect(derives(k, d), k).toBe(true);
  });

  it("views.css has a prefers-reduced-motion block that neutralises transitions and animations", () => {
    const blocks = reducedMotionBlocks(views());
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join("\n")).toMatch(/(transition|animation)(-duration)?\s*:\s*(none|0s|0ms|0?\.0*1ms)|--motion-duration\s*:\s*0m?s/);
  });

  it("the infinite animations are switched off in the reduced-motion block", () => {
    const anim = rules(stripReducedMotion(views())).filter((r) => decls(r.body).some(([p, v]) => p === "animation" && /infinite/.test(v)));
    expect(anim.length).toBeGreaterThan(0);
    expect(reducedMotionBlocks(views()).join("\n")).toMatch(/animation\s*:\s*none/);
  });
});

/* ---- tokens.css ------------------------------------------------------------------------- */

describe("U36 styles/tokens.css: design tokens and light/dark parity", () => {
  const COLOR = /^--(c|e|color)-/;
  const set = (bodies: string[]) => new Set(bodies.flatMap((b) => names(b, COLOR)));
  const sel = (re: RegExp, not?: RegExp) => rules(tokens()).filter((r) => re.test(r.sel) && !(not && not.test(r.sel))).map((r) => r.body);
  const light = () => set([...sel(/^:root$/), ...sel(/\[data-theme=["']light["']\]/, /:not\(/)]);
  const darkAttr = () => set(sel(/\[data-theme=["']dark["']\]/, /:not\(/));
  const darkMedia = () => set(sel(/:not\(\s*\[data-theme=["']light["']\]\s*\)/));
  const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

  it("tokens.css is the design tokens, not the U20 stub", () => {
    expect(raw("tokens.css")).not.toMatch(/U20 stub/);
    expect(light().size).toBeGreaterThanOrEqual(40);
  });

  it("light and [data-theme=dark] define exactly the same colour token names", () => {
    expect(darkAttr().size).toBeGreaterThan(0);
    expect(diff(light(), darkAttr())).toEqual([]);
    expect(diff(darkAttr(), light())).toEqual([]);
  });

  it("if the system-preference dark block exists it has the same names too", () => {
    expect(light().size).toBeGreaterThan(0);
    if (darkMedia().size === 0) return;
    expect(diff(light(), darkMedia())).toEqual([]);
    expect(diff(darkMedia(), light())).toEqual([]);
  });

  it("dark is a real theme: the main surface colour differs from light", () => {
    const val = (bodies: string[], n: string) => bodies.flatMap(decls).find(([p]) => p === n)?.[1];
    const l = val(sel(/^:root$/), "--c-wall") ?? val(sel(/\[data-theme=["']light["']\]/), "--color-bg");
    const d = val(sel(/\[data-theme=["']dark["']\]/, /:not\(/), "--c-wall") ?? val(sel(/\[data-theme=["']dark["']\]/, /:not\(/), "--color-bg");
    expect(l).toBeTruthy();
    expect(d).toBeTruthy();
    expect(l).not.toBe(d);
  });

  it("U20 compatibility: [data-theme=light] and [data-theme=dark] blocks with identical names incl. the required --color-* tokens", () => {
    const vars = (re: RegExp) => new Set(rules(tokens()).filter((r) => re.test(r.sel) && !/:not\(/.test(r.sel)).flatMap((r) => names(r.body, /^--/)));
    const l = vars(/\[data-theme=["']light["']\]/), d = vars(/\[data-theme=["']dark["']\]/);
    for (const n of ["--color-bg", "--color-surface", "--color-text", "--color-text-muted", "--color-accent", "--color-danger", "--color-warning", "--color-ok"]) {
      expect(l.has(n), `light ${n}`).toBe(true);
      expect(d.has(n), `dark ${n}`).toBe(true);
    }
    expect(diff(l, d)).toEqual([]);
    expect(diff(d, l)).toEqual([]);
  });

  it("keeps the design's structure: --font-ui, spacing scale, radii, motion easing", () => {
    for (const n of ["--font-ui", "--sp-1", "--sp-4", "--r-2", "--r-pill", "--ease", "--dur-1", "--rail-w"]) expect(tokens(), n).toMatch(new RegExp(`${n}\\s*:`));
  });
});
