import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { capsuleTemplate } from "../../../src/ui/badges";
import { createRenderer } from "../../../src/render";
import { CAPSULE_STATUS, ATTENTION } from "../../../src/schema";

const REPO = resolve(__dirname, "../../..");
const UI = join(REPO, "src/ui");
const walk = (d: string): string[] => existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : [];
const srcFiles = () => walk(UI).filter((f) => /\.tsx?$/.test(f) && !/__tests__|__fixtures__/.test(f));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("U20 files (spec section 1)", () => {
  it.each(["types", "state", "shell", "onboarding", "badges", "keyboard", "announcer", "caps", "index"])("src/ui/%s.ts exists and is not a stub", (n) => {
    const p = join(UI, `${n}.ts`); expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).not.toMatch(/U20 stub/);
  });
  it.each(["tokens.css", "wall.css"])("styles/%s is non-trivial", (n) => {
    const p = join(REPO, "styles", n); expect(existsSync(p)).toBe(true);
    expect(stripCss(readFileSync(p, "utf8")).trim().length).toBeGreaterThan(50);
  });
});

describe("U20 static scan of src/ui (B9, DOM safety, forbidden imports)", () => {
  const BAD: [string, RegExp][] = [
    ["innerHTML", /innerHTML/], ["outerHTML", /outerHTML/], ["insertAdjacentHTML", /insertAdjacent(HTML|Element|Text)/],
    ["document.write", /document\s*\.\s*write/], ["eval", /\beval\s*\(/], ["new Function", /new\s+Function\s*\(/],
    ["DOMParser/createContextualFragment", /DOMParser|createContextualFragment/],
    ["inline style prop", /\.style\s*[.=\[]|\.style\.cssText|setAttribute\(\s*["']style["']/],
    ["srcdoc", /srcdoc/], ["javascript: url", /javascript:/], ["setTimeout(string)", /set(Timeout|Interval)\(\s*["'`]/],
  ];
  it("sources exist to scan", () => { expect(srcFiles().length).toBeGreaterThanOrEqual(9); });
  it.each(BAD)("no %s anywhere in src/ui", (_n, re) => {
    for (const f of srcFiles()) expect(stripComments(readFileSync(f, "utf8")), f).not.toMatch(re);
  });
  it("forbidden imports: firebase/*, src/sync (types of U06/U22 redeclared structurally)", () => {
    for (const f of srcFiles()) {
      const s = stripComments(readFileSync(f, "utf8"));
      expect(s, f).not.toMatch(/from\s+["'](firebase|@firebase)[/"']/);
      expect(s, f).not.toMatch(/from\s+["'][./]*\/sync(\/|["'])/);
    }
  });
  it("does not read capsule text into console (B18)", () => {
    for (const f of srcFiles()) expect(stripComments(readFileSync(f, "utf8")), f).not.toMatch(/console\.(log|info|debug|warn|error)/);
  });
  it("no requestAnimationFrame in src/ui (only via U11/U12)", () => {
    for (const f of srcFiles()) expect(stripComments(readFileSync(f, "utf8")), f).not.toMatch(/requestAnimationFrame/);
  });
});

describe("U20 capsuleTemplate (B10) handed to U11", () => {
  it("builds a renderer without template_invalid / allowlist_invalid", () => {
    const { template, allowlist } = capsuleTemplate();
    const container = document.createElement("div");
    expect(() => createRenderer({
      container, template, allowlist, poolCapacity: 12,
      caps: { maxPatchesThisFrame: () => 8, frameJsBudgetMs: () => 4, effectsEnabled: () => true, beginFrame() {}, endFrame() {} },
      scheduler: { request() {} }, clock: { nowUs: () => 0 },
    })).not.toThrow();
  });
  it("slots: unique, include badge, stale_badge, step_1..step_5", () => {
    const slots: string[] = []; const walkN = (n: { slot?: string; children?: readonly unknown[] }) => { if (n.slot) slots.push(n.slot); (n.children ?? []).forEach((c) => walkN(c as never)); };
    walkN(capsuleTemplate().template.root as never);
    expect(new Set(slots).size).toBe(slots.length);
    for (const s of ["root", "headline", "summary", "badge", "stale_badge", "step_1", "step_2", "step_3", "step_4", "step_5"]) expect(slots).toContain(s);
  });
  it("allowlist: classMap built from CAPSULE_STATUS/ATTENTION; source -> data-source; stale; limits 120/600", () => {
    const a = capsuleTemplate().allowlist;
    expect(Object.keys(a.status.classMap ?? {}).sort()).toEqual([...CAPSULE_STATUS].sort());
    expect(Object.keys(a.attention.classMap ?? {}).sort()).toEqual([...ATTENTION].sort());
    expect(a.inference_source).toMatchObject({ kind: "attr", attr: "data-source" });
    expect(a.stale.kind).toBe("class"); expect(Object.values(a.stale.classMap ?? {})).toContain("is-stale");
    expect(a.headline.maxChars).toBe(120); expect(a.summary.maxChars).toBe(600);
  });
});

/* ---------- CSS ---------- */
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = (n: string) => stripCss(readFileSync(join(REPO, "styles", n), "utf8"));
const themeBlock = (src: string, t: "light" | "dark") => {
  const out: string[] = []; const re = new RegExp(`\\[data-theme=["']${t}["']\\]\\s*\\{([^}]*)\\}`, "g"); let m;
  while ((m = re.exec(src))) out.push(m[1]!); return out.join("\n");
};
const vars = (b: string) => Object.fromEntries([...b.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const lum = (hex: string) => {
  let h = hex.replace("#", ""); if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const REQUIRED = ["--color-bg", "--color-surface", "--color-text", "--color-text-muted", "--color-accent", "--color-danger", "--color-warning", "--color-ok"];

describe("U20 O15 theme_tokens_parity (B17)", () => {
  const tokens = () => css("tokens.css");
  it("light and dark define the identical, non-empty variable-name set incl. required tokens", () => {
    const l = vars(themeBlock(tokens(), "light")); const d = vars(themeBlock(tokens(), "dark"));
    expect(Object.keys(l).length).toBeGreaterThanOrEqual(REQUIRED.length);
    expect(Object.keys(l).sort()).toEqual(Object.keys(d).sort());
    for (const r of REQUIRED) { expect(l).toHaveProperty(r); expect(d).toHaveProperty(r); }
    expect(l["--color-bg"]).not.toBe(d["--color-bg"]);
  });
  it("no !important in tokens.css or wall.css", () => {
    expect(tokens()).not.toMatch(/!\s*important/i); expect(css("wall.css")).not.toMatch(/!\s*important/i);
  });
  it.each(["light", "dark"] as const)("%s: text/background pairs >= 4.5:1 [TARGET-spec]", (t) => {
    const v = vars(themeBlock(tokens(), t));
    for (const [fg, bg] of [["--color-text", "--color-bg"], ["--color-text", "--color-surface"], ["--color-text-muted", "--color-bg"]] as const) {
      expect(v[fg], fg).toMatch(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i); expect(v[bg], bg).toMatch(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i);
      expect(ratio(v[fg]!, v[bg]!), `${t} ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("wall.css takes every colour from custom properties (no hex/rgb/hsl literals) and only uses defined vars", () => {
    const w = css("wall.css");
    expect(w.length).toBeGreaterThan(50);
    expect(w).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    const defined = new Set([...Object.keys(vars(themeBlock(tokens(), "light"))), ...Object.keys(vars(tokens()))]);
    const used = [...w.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(defined.has(u) || u === "--motion-duration", u).toBe(true);
  });
});

describe("U20 reduced motion in CSS (B16)", () => {
  const all = () => css("tokens.css") + "\n" + css("wall.css");
  it("--motion-duration defined; .ui-reduced-motion sets it to 0ms", () => {
    expect(all()).toMatch(/--motion-duration\s*:\s*(?!0ms)[^;]+;/);
    expect(all()).toMatch(/\.ui-reduced-motion[^{]*\{[^}]*--motion-duration\s*:\s*0ms/);
  });
  it("prefers-reduced-motion media query disables transitions/animations", () => {
    expect(all()).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?(transition(-duration)?\s*:\s*(none|0s|0ms)|animation(-duration)?\s*:\s*(none|0s|0ms)|--motion-duration\s*:\s*0ms)/);
  });
  it("every transition/animation duration in wall.css is driven by var(--motion-duration)", () => {
    const w = css("wall.css"); const decls = [...w.matchAll(/(transition|animation)(-duration)?\s*:\s*([^;}]+)/g)];
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) expect(/^\s*none\s*$/.test(d[3]!) || /var\(\s*--motion-duration/.test(d[3]!), d[0]).toBe(true);
  });
  it("state is never colour only: badge/stale classes present in wall.css", () => {
    const w = css("wall.css"); expect(w).toMatch(/\.is-stale/); expect(w).toMatch(/\.is-hidden/);
    expect(w).toMatch(/:focus-visible/);
  });
});
