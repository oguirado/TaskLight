// @vitest-environment node
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, test } from "vitest";

// A variable specifier avoids requiring a declaration file for this Node ESM module.
const modulePath = "../../../tools/demo/demo_lib.mjs";
const { parseStylesheetImports, chromeCandidates, summaryExitCode } = await import(modulePath);
// A-R40: retain the already loaded Swarm stylesheet in cascade order, U138 Surface / Oracle and legacy amendments.
const sheets = ["tokens.css", "wall.css", "views.css", "plan.css", "swarm.css", "model_selector.css", "agents.css"];
const browsers = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];

describe("A1 / M1 stylesheet imports", () => {
  test("A1 actual hosting imports preserve the complete stylesheet order", () => {
    const source = readFileSync(new URL("../../../hosting/src/main.ts", import.meta.url), "utf8");
    expect(parseStylesheetImports(source)).toEqual(sheets);
  });
  test("M1 derives order from source rather than a frozen list", () => {
    const reversed = [...sheets].reverse();
    expect(parseStylesheetImports(reversed.map(s => `import "../../styles/${s}";`).join("\n"))).toEqual(reversed);
  });
  test("M1 empty source produces no invented stylesheets", () => {
    expect(parseStylesheetImports("")).toEqual([]);
  });
  test("M1 unrelated imports are excluded", () => {
    expect(parseStylesheetImports('import "./app.js";\nimport "../../styles/plan.css";')).toEqual(["plan.css"]);
  });
  test("M1 hostile code is passive source text and is never executed", () => {
    const source = 'throw new Error("must not execute");\nimport "../../styles/wall.css";';
    expect(parseStylesheetImports(source)).toEqual(["wall.css"]);
  });
});

describe("A3 / M6 browser candidate priority", () => {
  test.each(["linux", "darwin"])("A3 %s CHROME wins before every PATH browser", platform => {
    const result = chromeCandidates(platform, { CHROME: "fixtures/custom-browser", PATH: "fixtures/bin-a:fixtures/bin-b" });
    expect(result[0]).toBe("fixtures/custom-browser");
    const pathCandidates = browsers.flatMap(browser => [posix.join("fixtures/bin-a", browser), posix.join("fixtures/bin-b", browser)]);
    expect(result.slice(1, 1 + pathCandidates.length)).toEqual(pathCandidates);
  });
  test("A3 linux PATH ordering with no override", () => {
    expect(chromeCandidates("linux", { PATH: "fixtures/bin" })).toEqual(browsers.map(b => posix.join("fixtures/bin", b)));
  });
  test("A3 darwin standard app bundles follow PATH candidates", () => {
    const result = chromeCandidates("darwin", { PATH: "fixtures/bin" });
    expect(result.slice(0, browsers.length)).toEqual(browsers.map(b => posix.join("fixtures/bin", b)));
    // M6 does not specify a priority among app bundles: require coverage only.
    const apps = ["Google Chrome.app", "Chromium.app", "Microsoft Edge.app", "Brave Browser.app"];
    const executables = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"];
    for (const [i, app] of apps.entries()) {
      expect(result.slice(browsers.length)).toContain(posix.join(posix.sep, "Applications", app, "Contents", "MacOS", executables[i]!));
    }
  });
  test("M6 linux empty PATH has no fabricated candidates", () => {
    expect(chromeCandidates("linux", { PATH: "" })).toEqual([]);
  });
  test("M6 shell metacharacters in CHROME remain literal data", () => {
    const override = "fixtures/browser; echo MUST_NOT_EXECUTE";
    expect(chromeCandidates("linux", { CHROME: override, PATH: "fixtures/bin" })[0]).toBe(override);
  });
});

const keys = ["plan", "drift", "question", "planV2", "memory"] as const;
describe("A4 / M5 exit gate", () => {
  test.each(Array.from({ length: 32 }, (_, mask) => mask))("A4 complete truth table mask %i", mask => {
    const summary = Object.fromEntries(keys.map((key, bit) => [key, Boolean(mask & (1 << bit))]));
    expect(summaryExitCode(summary)).toBe(mask === 31 ? 0 : 1);
  });
  test.each([undefined, null, 0, "", false])("A4 absent or false required result %s cannot pass", value => {
    expect(summaryExitCode({ plan: true, drift: true, question: true, planV2: true, memory: value })).toBe(1);
  });
  test.each([undefined, false, true])("A4 no-mcp ignores optional checks %s", value => {
    expect(summaryExitCode({ plan: true, drift: true, question: true, planV2: value, memory: value }, { noMcp: true })).toBe(0);
  });
  test.each(["plan", "drift", "question"])("A4 no-mcp still requires %s", key => {
    expect(summaryExitCode({ plan: true, drift: true, question: true, [key]: false }, { noMcp: true })).toBe(1);
  });
  test("A4 legacy question receipt remains a successful question", () => {
    expect(summaryExitCode({ plan: true, drift: true, question: { agent: "wall-user", lamport: 1 }, planV2: true, memory: true })).toBe(0);
  });
});
