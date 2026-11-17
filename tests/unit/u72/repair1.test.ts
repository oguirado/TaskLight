// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const demo = readFileSync(new URL("../../../tools/demo/run_demo.mjs", import.meta.url), "utf8");
const code = demo.replace(/^\s*\/\/.*$/gm, "");

describe("U72 repair 1 startup regressions", () => {
  test("the actual Vite config loads and injects the complete stylesheet cascade", async () => {
    // A-U72b: dynamic specifier keeps tsc from type-checking the demo tooling (outside tsconfig scope).
    const configPath: string = "../../../tools/demo/vite.demo.config.ts";
    const { default: configure } = (await import(/* @vite-ignore */ configPath)) as { default: (env: unknown) => any };
    const config: any = await configure({ command: "serve", mode: "development" });
    const plugin = (config.plugins ?? []).flat(Infinity).find((item: any) => item?.name === "cw-demo-styles");
    const links = plugin.transformIndexHtml();
    const main = readFileSync(new URL("../../../hosting/src/main.ts", import.meta.url), "utf8");
    const imported = [...main.matchAll(/import\s+["']\.\.\/\.\.\/styles\/([^"']+\.css)["']/g)].map(match => match[1]);
    // A-R40: correct the stale import snapshot, U138 Oracle and legacy amendments (U72).
    expect(imported).toEqual(["tokens.css", "wall.css", "views.css", "plan.css", "swarm.css", "model_selector.css", "agents.css"]);
    expect(links).toHaveLength(7);
    expect(links.map((link: any) => link.attrs.href.split("/").pop())).toEqual(imported);
    for (const link of links) {
      expect(link.tag).toBe("link");
      expect(link.attrs.rel).toBe("stylesheet");
    }
  });

  test("HTTP readiness is bounded, validates TaskLight, and gates Chrome with log diagnostics", () => {
    const probe = code.match(/async function waitForVite\(url\) \{([\s\S]*?)\n\}/)?.[1];
    expect(probe).toBeDefined();
    expect(probe).toMatch(/Date\.now\(\)\s*\+\s*15000/);
    expect(probe).toMatch(/while\s*\(Date\.now\(\)\s*<\s*deadline\)/);
    expect(probe).toMatch(/fetch\(url,\s*\{[^}]*signal:\s*AbortSignal\.timeout/);
    expect(probe).toMatch(/response\.status\s*===\s*200/);
    expect(probe).toContain('<title>TaskLight</title>');
    expect(probe).toContain('id="wall"');
    expect(probe).toContain('join(P.logs, "vite.log")');
    expect(probe).toMatch(/\.slice\(-20\)/);
    expect(probe).toMatch(/throw new Error/);
    const readiness = code.indexOf("await waitForVite(wallUrl)");
    expect(readiness).toBeGreaterThan(code.indexOf('startProc("vite"'));
    expect(code.indexOf('startProc("chrome"')).toBeGreaterThan(readiness);
    expect(code).toMatch(/let rc = 1;[\s\S]*try\s*\{[\s\S]*rc = await main\(\);[\s\S]*catch[\s\S]*process\.exit\(rc\)/);
  });

  test("render success requires the TaskLight title and its real app root", () => {
    const index = readFileSync(new URL("../../../hosting/index.html", import.meta.url), "utf8");
    expect(index).toContain('<title>TaskLight</title>');
    expect(index).toContain('id="wall"');
    expect(code).toMatch(/if\s*\(!await waitFor\(`document\.title === "TaskLight" && !!document\.querySelector\('#wall'\)`\s*,\s*"wall page rendered"\)\)\s*\{\s*throw new Error/);
    expect(code).not.toContain("querySelector('h1, h2')");
  });
});
