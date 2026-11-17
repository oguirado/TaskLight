import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, expect } from "vitest";
import { CONFIG_DEFAULTS, PROVIDER_FLAG_DEFAULTS } from "../../../src/config/keys";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
export const OUTPUTS = [
  "src/app/firebase-config.public.ts", "firebase.json", "hosting/headers.json",
  "extension/manifest.json", "extension/manifest.dev.json", "extension/src/panel/panel.html",
  ".firebaserc", "firebase/remoteconfig.template.json",
] as const;
export const LEGACY = [
  "tests/unit/u22/config.test.ts", "tests/unit/u37c/amend_u13_sw_main.test.ts",
  "tests/unit/u38/g6_manifest.test.ts",
] as const;
const COPIES = [
  ...OUTPUTS.slice(0, 6), ...LEGACY, "src/config/keys.ts", "src/config/types.ts",
  "hosting/vite.config.ts", "firebase/firestore.rules", "tools/firebase_go_live.mjs",
];
export const PUBLIC = Object.freeze({
  apiKey: `AIza${"A".repeat(35)}`, authDomain: "fb2-oracle.firebaseapp.com",
  projectId: "fb2-oracle", storageBucket: "fb2-oracle.firebasestorage.app",
  messagingSenderId: "123456789012", appId: "1:123456789012:web:abc012def345",
});
export const SITE_KEY = "public_site_key_fixture_12345";
export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
export const DEFAULT_ORIGIN = `https://${PUBLIC.projectId}.web.app`;
export const DEFAULTS = { ...CONFIG_DEFAULTS, ...PROVIDER_FLAG_DEFAULTS };

export interface Fixture { dir: string; root: string; input: string; audit: string }
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
export function fixture(config: unknown = PUBLIC): Fixture {
  const dir = mkdtempSync(join(HERE, ".scratch-"));
  scratch.push(dir);
  const root = join(dir, "project");
  for (const path of COPIES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPO, path), join(root, path));
  }
  const input = join(dir, "public-config.json");
  const audit = join(dir, "unexpected-execution.txt");
  put(input, JSON.stringify(config));
  // A preload blocks networking before the CLI loads. It never opens a port.
  put(join(dir, "network-guard.cjs"), `
const fs = require("node:fs");
const deny = () => {
  fs.appendFileSync(process.env.FB2_EXECUTION_SENTINEL, "network attempted\\n");
  throw new Error("FB2 oracle: network forbidden");
};
for (const [name, keys] of [["http", ["request", "get"]], ["https", ["request", "get"]],
  ["net", ["connect", "createConnection"]], ["tls", ["connect"]], ["dgram", ["createSocket"]],
  ["dns", ["lookup", "resolve"]]]) {
  const mod = require("node:" + name);
  for (const key of keys) mod[key] = deny;
}
globalThis.fetch = deny;
require("node:module").syncBuiltinESMExports();
`);
  // These harmless executables catch accidentally executing the printed commands.
  for (const name of ["node", "npm", "npx", "firebase", "vite"]) {
    const path = join(dir, "bin", name);
    put(path, '#!/bin/sh\nprintf "%s\\n" "unexpected command" >> "$FB2_EXECUTION_SENTINEL"\nexit 97\n'.replaceAll("\\n", "\n"));
    chmodSync(path, 0o755);
  }
  // Also catch invoking the extension builder with process.execPath.
  put(join(root, "extension/build.mjs"), `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FB2_EXECUTION_SENTINEL, "extension build executed\\n");
process.exitCode = 97;
`);
  for (const path of ["tests/not-owned.test.ts", "node_modules/untouched.txt", ".git/HEAD", "hosting/dist/index.html", "src/unrelated.ts"]) {
    put(join(root, path), `FB2 untouched sentinel: ${path}\n`);
  }
  return { dir, root, input, audit };
}
export function text(f: Fixture, path: string): string { return readFileSync(join(f.root, path), "utf8"); }
export function json(f: Fixture, path: string): any { return JSON.parse(text(f, path)); }
export function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name); const rel = prefix + name; const st = lstatSync(path);
      if (st.isSymbolicLink()) result[rel] = `link:${readlinkSync(path)}`;
      else if (st.isDirectory()) visit(path, `${rel}/`);
      else result[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  visit(root);
  return result;
}
export interface RunOptions { siteKey?: string; extId?: string; origin?: string; dryRun?: boolean; defaultRoot?: boolean; omit?: string }
export function invoke(f: Fixture, opts: RunOptions = {}) {
  const args = ["--config", f.input, "--site-key", opts.siteKey ?? SITE_KEY, "--ext-id", opts.extId ?? EXT_ID];
  if (!opts.defaultRoot) args.push("--root", f.root);
  if (opts.origin !== undefined) args.push("--hosting-origin", opts.origin);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.omit) { const i = args.indexOf(opts.omit); if (i !== -1) args.splice(i, 2); }
  const result = spawnSync(process.execPath, [join(f.root, "tools/firebase_go_live.mjs"), ...args], {
    cwd: f.dir, encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024,
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(join(f.dir, "network-guard.cjs"))}`,
      PATH: `${join(f.dir, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      FB2_EXECUTION_SENTINEL: f.audit, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
export function run(f: Fixture, opts: RunOptions = {}, expected = 0): string {
  const result = invoke(f, opts);
  expect(result.status, result.output).toBe(expected);
  expect(existsSync(f.audit), "builds, deploys and networking must never execute").toBe(false);
  return result.output;
}
export function reject(f: Fixture, opts: RunOptions = {}): string {
  const before = snapshot(f.dir);
  const output = run(f, opts, 2);
  expect(snapshot(f.dir)).toEqual(before);
  return output;
}
export function publicModule(source: string): Record<string, any> {
  const js = stripTypeScriptTypes(source).replace(/^export\s+/gm, "");
  return runInNewContext(`${js}\n;({ FIREBASE_PUBLIC_CONFIG, RECAPTCHA_SITE_KEY_PUBLIC, isPlaceholderConfig, isPlaceholderValue });`, {});
}
export function maskPublicValues(source: string): string {
  return source.replace(/(export const FIREBASE_PUBLIC_CONFIG[^=]*=\s*\{)([\s\S]*?)(\n\};)/,
    (_match, a: string, body: string, b: string) => a + body.replace(/(\b\w+\s*:\s*)(["'])[^"'\r\n]*\2/g, "$1<value>") + b)
    .replace(/(export const RECAPTCHA_SITE_KEY_PUBLIC\s*=\s*)(["'])[^"'\r\n]*\2/, "$1<value>");
}
export function assertPublic(f: Fixture, config: Record<string, string> = PUBLIC, site = SITE_KEY): void {
  const mod = publicModule(text(f, OUTPUTS[0]));
  expect(mod.FIREBASE_PUBLIC_CONFIG).toEqual(config);
  expect(mod.RECAPTCHA_SITE_KEY_PUBLIC).toBe(site);
  expect(mod.isPlaceholderConfig(mod.FIREBASE_PUBLIC_CONFIG)).toBe(false);
  expect(mod.isPlaceholderValue(site)).toBe(false);
}
export function assertOrigins(f: Fixture, project: string = PUBLIC.projectId, ext: string = EXT_ID, origin?: string): void {
  const hosted = origin ?? `https://${project}.web.app`;
  const matches = origin ? [`${origin}/*`] : [`https://${project}.web.app/*`, `https://${project}.firebaseapp.com/*`];
  for (const [path, dev] of [[OUTPUTS[3], false], [OUTPUTS[4], true]] as const) {
    const m = json(f, path);
    expect([...m.externally_connectable.matches].sort()).toEqual([...matches, ...(dev ? ["http://localhost/*"] : [])].sort());
    expect(m.content_security_policy.extension_pages).toContain(`frame-src ${hosted}`);
    expect(text(f, path)).not.toContain("https://site.test");
  }
  for (const path of [OUTPUTS[1], OUTPUTS[2]]) {
    expect(text(f, path)).toContain(`chrome-extension://${ext}`);
    expect(text(f, path)).not.toContain("<EXT_ID>");
  }
  expect(text(f, OUTPUTS[5])).toContain(`src="${hosted}/"`);
}
export function assertRemote(f: Fixture): void {
  const parameters = json(f, OUTPUTS[7]).parameters;
  expect(Object.keys(parameters).sort()).toEqual(Object.keys(DEFAULTS).sort());
  for (const [key, value] of Object.entries(DEFAULTS)) {
    expect(parameters[key]).toMatchObject({ defaultValue: { value: String(value) }, valueType: typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? "NUMBER" : "STRING" });
    expect(typeof parameters[key].defaultValue.value).toBe("string");
  }
  expect(json(f, "firebase.json").remoteconfig).toEqual({ template: OUTPUTS[7] });
}

// Run the real suites in a disposable project. Preserve configured files while
// filling in their existing import dependencies; do not assume a predicate API.
export function legacyResult(f: Fixture, paths: readonly string[]) {
  for (const dir of ["src", "extension/src", "extension/native", "tests/unit/u22", "tests/unit/u37c", "tests/unit/u13", "tests/unit/u38"]) {
    cpSync(join(REPO, dir), join(f.root, dir), { recursive: true, force: false });
  }
  for (const path of ["package.json", "vitest.config.ts"]) copyFileSync(join(REPO, path), join(f.root, path));
  const packagePath = createRequire(import.meta.url).resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const executable = join(dirname(packagePath), typeof pkg.bin === "string" ? pkg.bin : pkg.bin.vitest);
  const result = spawnSync(process.execPath, [executable, "run", ...paths, "--root", f.root,
    "--config", join(f.root, "vitest.config.ts"), "--project", "unit", "--reporter=json",
    "--outputFile", join(f.dir, "legacy-report.json"),
    "--no-cache", "--maxWorkers=1", "--no-file-parallelism"], {
    cwd: f.root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  expect(existsSync(join(f.dir, "legacy-report.json")), result.stderr || result.stdout).toBe(true);
  const report = JSON.parse(readFileSync(join(f.dir, "legacy-report.json"), "utf8"));
  expect(report.testResults, result.stderr).toHaveLength(paths.length);
  expect(report.numTotalTests).toBeGreaterThan(0);
  for (const file of report.testResults) expect(file.assertionResults.length, file.message).toBeGreaterThan(0);
  const failures = report.testResults.flatMap((file: any) => file.assertionResults.flatMap((test: any) => test.failureMessages)).join("\n");
  return { status: result.status, report, output: `${result.stdout}${result.stderr}${failures}` };
}
