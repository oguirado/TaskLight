import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStarterTemplateHash, resolveStarterTemplate, STARTER_TEMPLATE_IDS } from "../../../src/app/starter_templates";

const root = process.cwd();
const raw: unknown = JSON.parse(readFileSync(resolve(root, "templates/planning/autonomous-software.json"), "utf8"));

function validatedTemplate(): Record<string, unknown> {
  const result = spawnSync("python3", ["-B", "-c", [
    "import json, sys",
    "from bridge.plan.template import validate_template",
    "print(json.dumps(validate_template(json.load(sys.stdin))))",
  ].join("\n")], { cwd: root, input: JSON.stringify(raw), encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  expect(result.error, "bounded Python reference process").toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("U76 M1 / A1 sixth starter", () => {
  it("lists exactly six starters in the specified order", () => {
    expect(STARTER_TEMPLATE_IDS).toEqual(["blank", "web-app", "cli-library", "mobile-app", "data-ml", "autonomous-software"]);
  });
  it("canonical hash equals Python validate_template for the shipped JSON", () => {
    expect(canonicalStarterTemplateHash(raw)).toBe(validatedTemplate()["hash"]);
  });
  it("resolves the entire autonomous-software template with the Python canonical hash", () => {
    const expected = validatedTemplate();
    expect(resolveStarterTemplate("autonomous-software", expected["hash"] as string)).toEqual(expected);
  });
  it("rejects the wrong autonomous-software hash", () => {
    expect(resolveStarterTemplate("autonomous-software", "0".repeat(64))).toBeUndefined();
  });
  it.each(["../autonomous-software", "__proto__", "constructor", ""])("rejects hostile or absent id %j", id => {
    expect(resolveStarterTemplate(id, canonicalStarterTemplateHash(raw))).toBeUndefined();
  });
});
