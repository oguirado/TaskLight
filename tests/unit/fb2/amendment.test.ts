// @vitest-environment node
import { expect, it } from "vitest";
import { LEGACY, OUTPUTS, fixture, json, legacyResult, put, run, text } from "./harness";
import { join } from "node:path";

for (const path of LEGACY) {
  it(`A-FB2 ${path} accepts placeholder and configured fixture states`, () => {
    const f = fixture();
    // Successful dry-run first: today this test must be red because of the CLI stub.
    run(f, { dryRun: true });
    expect(text(f, path)).toContain("// A-FB2:");
    const placeholder = legacyResult(f, [path]);
    expect(placeholder.status, placeholder.output).toBe(0);
    run(f);
    const configured = legacyResult(f, [path]);
    expect(configured.status, configured.output).toBe(0);
  }, 40000);
}

it("A-FB2 configured manifest predicates reject a project not matching .firebaserc", () => {
  const f = fixture(); run(f);
  const binding = json(f, ".firebaserc"); binding.projects.default = "fb2-wrong-project";
  put(join(f.root, ".firebaserc"), JSON.stringify(binding));
  for (const path of LEGACY.slice(1)) {
    const result = legacyResult(f, [path]);
    expect(result.status, result.output).toBe(1);
    expect(result.report.numFailedTests).toBeGreaterThan(0);
  }
}, 40000);

it("A-FB2 configured state cannot retain the placeholder reCAPTCHA key", () => {
  const f = fixture(); const placeholder = text(f, OUTPUTS[0]).match(/RECAPTCHA_SITE_KEY_PUBLIC\s*=\s*("[^"]*")/)![1]!;
  run(f);
  put(join(f.root, OUTPUTS[0]), text(f, OUTPUTS[0]).replace(/(RECAPTCHA_SITE_KEY_PUBLIC\s*=\s*)"[^"]*"/, `$1${placeholder}`));
  const result = legacyResult(f, [LEGACY[0]]);
  expect(result.status, result.output).toBe(1);
  expect(result.report.numFailedTests).toBeGreaterThan(0);
}, 25000);
