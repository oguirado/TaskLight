// U38 G4: the hosted wall loads tokens, wall, views, agents CSS (links in hosting/index.html OR css imports in hosting/src/main.ts).
import { describe, expect, it } from "vitest";
import { hostedSheets, read, stripTs } from "./helpers";

const WANT = ["tokens.css", "wall.css", "views.css", "agents.css"];

describe("G4 hosted wall stylesheets", () => {
  const sheets = hostedSheets();
  const mech = (["html", "ts"] as const).filter((h) => WANT.every((f) => sheets.some((s) => s.how === h && s.file === f)));
  it("one mechanism (index.html <link> or main.ts import) loads all four sheets", () => {
    expect(mech.length, JSON.stringify(sheets)).toBeGreaterThan(0);
  });
  it("in the order tokens, wall, views, agents (tokens first, wall before views so views win the cascade)", () => {
    const h = mech[0]; expect(h).toBeDefined();
    const order = sheets.filter((s) => s.how === h).map((s) => s.file).filter((f) => WANT.includes(f));
    expect(order).toEqual(WANT);
  });
  it("every reference resolves to a real file, same-origin only (CSP style-src 'self')", () => {
    const h = mech[0]; expect(h).toBeDefined();
    for (const s of sheets.filter((x) => x.how === h)) {
      expect(s.ref, "no external stylesheet").not.toMatch(/^(https?:)?\/\//);
      expect(s.resolves, `dangling stylesheet reference ${s.ref}`).toBe(true);
    }
  });
  it("the HTML keeps its strict CSP (style-src 'self', no unsafe-inline) and the #wall root", () => {
    const html = read("hosting/index.html");
    expect(html).toMatch(/style-src 'self';/);
    expect(html).not.toMatch(/unsafe-inline/);
    expect(html).toContain('id="wall"');
  });
  it("main.ts adds no inline <style> element", () => {
    expect(stripTs(read("hosting/src/main.ts"))).not.toMatch(/createElement\(\s*["']style["']\s*\)/);
  });
});
