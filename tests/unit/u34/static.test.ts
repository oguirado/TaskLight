import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const AGENTS = join(resolve(__dirname, "../../.."), "src/agents");
const walk = (d: string): string[] => existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : [];
const files = () => walk(AGENTS).filter((f) => /\.ts$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("A9 static scan of src/agents", () => {
  it("types.ts and index.ts exist, index is not a stub, and an implementation exists", () => {
    expect(existsSync(join(AGENTS, "types.ts"))).toBe(true);
    expect(existsSync(join(AGENTS, "index.ts"))).toBe(true);
    const idx = readFileSync(join(AGENTS, "index.ts"), "utf8");
    expect(idx).not.toMatch(/U34 stub/);
    const total = files().reduce((n, f) => n + strip(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(3000);
  });

  it("index.ts exports the nine public functions", () => {
    const idx = files().map((f) => readFileSync(f, "utf8")).join("\n");
    for (const n of ["foldRoom", "foldRoomWithStats", "contractHash", "diffPlans", "driftRules", "buildDriftPrompt", "reviewDrift", "silentAgents", "toTaskVM"]) {
      expect(idx, n).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${n}\\b|export\\s+(const|\\{[^}]*\\b)${n}\\b`));
    }
  });

  const BAD: [string, RegExp][] = [
    ["innerHTML", /innerHTML/],
    ["eval(", /\beval\s*\(/],
    ["new Function", /new\s+Function\b/],
    ["Function(", /(^|[^.\w])Function\s*\(/],
  ];
  it.each(BAD)("no %s in src/agents (comments stripped)", (_n, re) => {
    const fs = files();
    expect(fs.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(AGENTS, "index.ts"), "utf8"), "src/agents/index.ts is still the stub").not.toMatch(/U34 stub/);
    for (const f of fs) expect(strip(readFileSync(f, "utf8")), f).not.toMatch(re);
  });

  it("the raw spec pattern /innerHTML|eval\\(|new Function/ does not match any source file (comments included)", () => {
    expect(readFileSync(join(AGENTS, "index.ts"), "utf8")).not.toMatch(/U34 stub/);
    for (const f of files()) expect(readFileSync(f, "utf8"), f).not.toMatch(/innerHTML|eval\(|new Function/);
  });

  it("no network, DOM or Firebase access: pure module", () => {
    expect(readFileSync(join(AGENTS, "index.ts"), "utf8")).not.toMatch(/U34 stub/);
    for (const f of files()) {
      const s = strip(readFileSync(f, "utf8"));
      expect(s, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|firebase|document\s*\.|window\s*\./);
    }
  });
});
