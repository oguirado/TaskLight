import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import { getTemplateMemorySections } from "../../../src/app/starter_templates";
import { harness } from "./helpers";
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
describe("U64 static stop rules", () => {
  it.each(["src/app/plan_wiring.ts", "src/app/starter_templates.ts"])("A10 %s uses no global timers, time, network or DOM", path => {
    const text = source(path).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(text).not.toMatch(/(?:^|[^.\w])(?:setTimeout|clearTimeout|setInterval|clearInterval|fetch)\s*\(/m);
    expect(text).not.toMatch(/(?:globalThis|window|self)\s*\.\s*(?:setTimeout|clearTimeout|setInterval|clearInterval|fetch)\s*\(/);
    expect(text).not.toMatch(/\bDate\s*\.\s*now\s*\(/);
    expect(text).not.toMatch(/\b(?:document|localStorage)\s*\./);
  });
  it("A10 bundled metadata comes from all five static JSON imports", () => {
    // Public loader must work before inspecting its build-time loading contract.
    expect(getTemplateMemorySections("blank")?.length).toBeGreaterThan(0);
    const imports = [...source("src/app/starter_templates.ts").matchAll(/\bimport\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)].map(m => m[1]);
    for (const id of ["blank", "web-app", "cli-library", "mobile-app", "data-ml"]) expect(imports).toContain(`../../templates/planning/${id}.json`);
  });
  it("A10 hosted composition imports plan CSS immediately after views CSS", () => {
    // Required composition API is the entry-point prerequisite for this static integration check.
    const h = harness([]); const w = createPlanWiring(h.deps); w.dispose();
    const imports = [...source("hosting/src/main.ts").matchAll(/\bimport\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)].map(m => m[1]);
    const views = imports.indexOf("../../styles/views.css"); const plan = imports.indexOf("../../styles/plan.css");
    expect(views).toBeGreaterThanOrEqual(0); expect(plan).toBe(views + 1);
    expect(plan).toBeLessThan(imports.indexOf("../../styles/model_selector.css")); expect(plan).toBeLessThan(imports.indexOf("../../styles/agents.css"));
  });
});
