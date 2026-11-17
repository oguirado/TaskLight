// U127 r3 review: long model labels must wrap inside the model sheet instead of overflowing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "styles/model_selector.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("U127w model sheet wrapping", () => {
  it.each([".model-row-state", ".model-group-title", ".model-group-note", ".model-sheet-foot button"])(
    "%s can shrink and wraps long words", selector => {
      const block = css.split("}").find(rule => (rule.split("{")[0] ?? "").split(",").map(s => s.trim()).includes(selector) && /overflow-wrap:\s*anywhere/.test(rule) && /min-width:\s*0/.test(rule));
      expect(block, `${selector} needs min-width:0 and overflow-wrap:anywhere`).toBeDefined();
    });
});
