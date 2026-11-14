import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const raw = (n: string) => existsSync(join(REPO, "styles", n)) ? readFileSync(join(REPO, "styles", n), "utf8") : "";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const agents = () => strip(raw("agents.css"));
const tokens = () => strip(raw("tokens.css")); // read at test time: U36 replaces it in parallel

const rules = (css: string): { sel: string; body: string }[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? "").trim(), body: m[2] ?? "" }));
const decls = (body: string): [string, string][] =>
  body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(":"); return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as [string, string]; });

function blocks(css: string, re: RegExp): string[] {
  const res: string[] = [];
  for (const m of css.matchAll(re)) {
    let depth = 1, j = (m.index ?? 0) + m[0].length;
    const s = j;
    for (; j < css.length && depth > 0; j++) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; }
    res.push(css.slice(s, j - 1));
  }
  return res;
}
const RM = /@media[^{]*prefers-reduced-motion[^{]*\{/g;
function stripBlocks(css: string, re: RegExp): string {
  let out = css, i: number;
  const r = new RegExp(re.source);
  while ((i = out.search(r)) >= 0) {
    const open = out.indexOf("{", i);
    let depth = 0, j = open;
    for (; j < out.length; j++) { if (out[j] === "{") depth++; else if (out[j] === "}" && --depth === 0) break; }
    out = out.slice(0, i) + out.slice(j + 1);
  }
  return out;
}
/** Selector text of every rule plus declaration values, for targeted scans. */
const selectorText = (css: string) => rules(css).map((r) => r.sel).join("\n");
const valueText = (css: string) => rules(css).flatMap((r) => decls(r.body).map(([, v]) => v)).join("\n");
const declared = (css: string): Set<string> => new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1] ?? ""));
const used = (css: string): string[] => [...css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((m) => m[1] ?? "");

const real = () => {
  expect(raw("agents.css")).not.toMatch(/U35 stub/);
  expect(agents().trim().length, "styles/agents.css is still a stub").toBeGreaterThan(1500);
};

describe("U35 styles/agents.css: real stylesheet covering the markup", () => {
  it("is not the stub and mentions the contract selectors", () => {
    real();
    const c = agents();
    for (const sel of [".agent-chat", ".agent-chat-head", ".agent-chat-title", ".agent-chat-close", ".agent-chat-log", ".chat-msg", ".chat-from", ".chat-text", ".chat-at",
      ".chat-banner", ".chat-escalate", ".chat-accept-drift", ".drift-added", ".drift-removed", ".agent-chat-composer", ".chat-input", ".chat-suggest", ".chat-suggest-note", ".chat-send", ".chat-count"]) {
      expect(c, sel).toContain(sel);
    }
    expect(c).toMatch(/:focus-visible/);
    expect(c).toMatch(/\[data-over\]/);
    expect(c).toMatch(/\[data-kind\s*=\s*["']?silent/);
    expect(c).toMatch(/\[data-kind\s*=\s*["']?drift/);
    expect(c).toMatch(/\[data-verdict/);
  });

  it("chat bubbles: user right-aligned with a primary tint, agent left neutral, nano left with a gradient hairline", () => {
    real();
    const rs = rules(agents());
    const body = (re: RegExp) => rs.filter((r) => re.test(r.sel)).map((r) => r.body).join(";");
    const user = body(/\[data-from\s*=\s*["']?user["']?\]/);
    const agent = body(/\[data-from\s*=\s*["']?agent["']?\]/);
    const nano = body(/\[data-from\s*=\s*["']?nano["']?\]/);
    expect(user.length, "no [data-from=user] rule").toBeGreaterThan(0);
    expect(agent.length, "no [data-from=agent] rule").toBeGreaterThan(0);
    expect(nano.length, "no [data-from=nano] rule").toBeGreaterThan(0);
    expect(user).toMatch(/(align-self\s*:\s*(flex-end|end)|justify-self\s*:\s*end|margin-(inline-start|left)\s*:\s*auto|text-align\s*:\s*(right|end))/);
    expect(user).toMatch(/primary/);
    expect(agent).not.toMatch(/(align-self\s*:\s*(flex-end|end)|margin-(inline-start|left)\s*:\s*auto|text-align\s*:\s*(right|end))/);
    expect(agent).not.toMatch(/primary/);
    expect(nano).not.toMatch(/(align-self\s*:\s*(flex-end|end)|margin-(inline-start|left)\s*:\s*auto)/);
    expect(agents().match(/\[data-from\s*=\s*["']?nano["']?\][^{]*\{[^}]*gradient/) ?? nano.match(/gradient/)).not.toBeNull();
  });
});

describe("U35 styles/agents.css: colour only from custom properties", () => {
  it("no hex literals in declaration values", () => {
    real();
    expect(valueText(agents())).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(agents()).not.toMatch(/:\s*[^;{}]*#[0-9a-fA-F]{3,8}\b/);
  });

  it("no rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()/color() literals", () => {
    real();
    expect(agents()).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/i);
    expect(valueText(agents())).not.toMatch(/(^|[\s,(])color\s*\(/i);
  });

  it("no named colour keywords as values (transparent/currentColor/inherit allowed)", () => {
    real();
    const NAMED = ["red", "blue", "green", "white", "black", "gray", "grey", "orange", "yellow", "purple", "pink", "brown", "cyan", "magenta", "silver", "gold", "navy", "teal"];
    const vals = valueText(agents()).replace(/var\(\s*--[^)]*\)/g, " ");
    for (const n of NAMED) expect(vals, n).not.toMatch(new RegExp(`(^|[\\s,(/])${n}($|[\\s,;)/])`, "i"));
  });

  it("no id selectors", () => {
    real();
    expect(selectorText(agents())).not.toMatch(/#[A-Za-z_-]/);
  });

  it("no !important", () => {
    real();
    expect(agents()).not.toMatch(/!\s*important/i);
  });

  it("every var(--name) exists in styles/tokens.css (read at test time) or is defined in agents.css itself", () => {
    real();
    const t = tokens(), a = agents();
    const tokenNames = declared(t);
    expect(tokenNames.size, "styles/tokens.css has no custom properties yet (U36 not landed)").toBeGreaterThan(0);
    const known = new Set([...tokenNames, ...declared(a)]);
    const refs = used(a);
    expect(refs.length).toBeGreaterThan(10);
    const unknown = [...new Set(refs.filter((r) => !known.has(r)))];
    expect(unknown).toEqual([]);
  });

  it("agents.css does not re-declare token names it does not define as its own private ones with literal colours", () => {
    real();
    for (const m of agents().matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g)) {
      expect(m[2] ?? "", m[1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\s*\(/i);
    }
  });
});

describe("U35 styles/agents.css: motion", () => {
  const TIME = /(^|[^\w.-])\d*\.?\d+m?s\b/;

  it("every transition/animation lives in a rule that uses var(--motion-duration); no literal durations outside the reduced-motion block", () => {
    real();
    const outside = stripBlocks(agents(), RM);
    const motion = rules(outside).flatMap((r) => decls(r.body).filter(([p]) => /^(transition|animation)(-duration)?$/.test(p)));
    expect(motion.length, "no transition/animation declarations at all").toBeGreaterThan(0);
    for (const [p, v] of motion) {
      if (/^(none)$/i.test(v)) continue;
      expect(v, `${p}: ${v}`).toContain("var(--motion-duration)");
      expect(v, `${p}: ${v}`).not.toMatch(TIME);
    }
    expect(valueText(outside)).not.toMatch(TIME);
    expect(outside).toContain("var(--motion-duration)");
  });

  it("has a prefers-reduced-motion block that actually neutralises motion", () => {
    real();
    const bs = blocks(agents(), RM);
    expect(bs.length).toBeGreaterThan(0);
    const all = bs.join("\n");
    expect(all.trim().length).toBeGreaterThan(20);
    expect(all).toMatch(/(transition|animation|scroll-behavior)/);
    expect(all).toMatch(/(none|0s|0ms|auto)/);
  });

  it("reduced-motion block uses only zero/none durations (no new motion)", () => {
    real();
    for (const b of blocks(agents(), RM)) {
      for (const m of b.matchAll(/(\d*\.?\d+)(m?s)\b/g)) expect(Number(m[1]) <= 0.01, m[0]).toBe(true);
    }
  });
});
