import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { EXT_DIR, REPO_DIR, scanText, scanTree, codeFiles, importsOf, resolvesOutside } from "./scan";

describe("O15 no_firebase_static (+control)", () => {
  it("control: scanner flags every planted pattern", () => {
    const planted = [
      'import { getAI } from "firebase/ai";', "getAI(app)", "model.generateContent(x)", "initializeDeviceModel(cb)",
      "LanguageModel.create()", "eval(code)", "new Function('x')", "importScripts('a.js')", 'import("https://evil.test/x.js")',
    ];
    for (const p of planted) expect(scanText(p).length, p).toBeGreaterThan(0);
    expect(scanText("// getAI is forbidden here\n/* eval( */\nconst ok = 1;")).toEqual([]);
  });
  it("extension/ (src, native, html, manifest-adjacent code) has 0 hits", () => {
    expect(codeFiles().length).toBeGreaterThan(5);
    expect(scanTree()).toEqual([]);
  });
  it("the sources that must exist do exist (surface complete)", () => {
    for (const f of ["manifest.json", "src/limits.ts", "src/types.ts", "src/router.ts", "src/client.ts", "src/sw.ts", "src/chrome_ports.ts",
      "src/port.ts", "src/pins.ts", "src/snapshot.ts", "src/panel/panel.html", "src/panel/panel.ts", "native/relay.ts"]) {
      expect(existsSync(resolve(EXT_DIR, f)), f).toBe(true);
    }
  });
  it("tools/secret_scan.sh passes on extension/; control: planted service-account fixture exits non-zero", () => {
    const script = resolve(REPO_DIR, "tools/secret_scan.sh");
    expect(spawnSync("bash", [script, EXT_DIR]).status).toBe(0);
    const d = mkdtempSync(join(tmpdir(), "u13-scan-"));
    try {
      mkdirSync(join(d, "x"));
      // Fake service-account marker assembled at runtime so scanners do not flag this source.
      writeFileSync(join(d, "x", "k.json"), '{"type": "service' + '_account"}');
      expect(spawnSync("bash", [script, d]).status).not.toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("import restrictions (SPEC_U13 s1)", () => {
  const ts = () => codeFiles().filter((f) => f.endsWith(".ts"));
  it("no bare (npm) specifiers: the extension bundles nothing third-party", () => {
    const bad: string[] = [];
    for (const f of ts()) for (const [spec] of importsOf(readFileSync(f, "utf8"))) if (!spec.startsWith(".")) bad.push(`${relative(EXT_DIR, f)}: ${spec}`);
    expect(bad).toEqual([]);
  });
  it("only imports outside extension/ are repo/src/app/connector and repo/src/app/types (type-only)", () => {
    const allowed = [resolve(REPO_DIR, "src/app/connector"), resolve(REPO_DIR, "src/app/types")];
    const bad: string[] = [];
    for (const f of ts()) for (const [spec, typeOnly] of importsOf(readFileSync(f, "utf8"))) {
      const out = resolvesOutside(f, spec);
      if (out === null) continue;
      const base = out.replace(/\.(ts|js)$/, "");
      if (!allowed.includes(base)) bad.push(`${relative(EXT_DIR, f)}: ${spec}`);
      else if (base.endsWith("types") && !typeOnly) bad.push(`${relative(EXT_DIR, f)}: ${spec} (value import of types)`);
    }
    expect(bad).toEqual([]);
  });
  it("control: importsOf sees `import type`, `export ... from` and side-effect imports", () => {
    const got = importsOf('import type { A } from "../x";\nexport { b } from "./y";\nimport "./z";\nimport { c } from "firebase/app";');
    expect(got.map((g) => g[0])).toEqual(["../x", "./y", "./z", "firebase/app"]);
    expect(got[0]![1]).toBe(true);
  });
  it("chrome.* is touched only in chrome_ports.ts", () => {
    const bad = ts().filter((f) => !f.endsWith("chrome_ports.ts")).filter((f) => /\bchrome\s*\./.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))).map((f) => relative(EXT_DIR, f));
    expect(bad.filter((f) => !f.startsWith("src/panel/"))).toEqual([]);
  });
  it("storage.local is never referenced (payloads only in storage.session, B6)", () => {
    const bad = ts().filter((f) => /storage\s*\.\s*local/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))).map((f) => relative(EXT_DIR, f));
    expect(bad.filter((f) => !f.endsWith("chrome_ports.ts"))).toEqual([]);
  });
  it("nothing is logged (B6): no console.* in extension code", () => {
    const bad = ts().filter((f) => /\bconsole\s*\./.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))).map((f) => relative(EXT_DIR, f));
    expect(bad).toEqual([]);
  });
});
