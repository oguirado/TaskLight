// @vitest-environment node
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORIGIN, EXT_ID, OUTPUTS, PUBLIC, SITE_KEY, assertOrigins, assertPublic,
  assertRemote, fixture, invoke, json, maskPublicValues, put, reject,
  run, snapshot, text,
} from "./harness";

describe("FB2 public-config CLI", () => {
  it("M1 valid public config succeeds; extra measurementId is ignored", () => {
    const f = fixture({ ...PUBLIC, measurementId: "G-PUBLIC123" });
    run(f); assertPublic(f);
    expect(text(f, OUTPUTS[0])).not.toContain("G-PUBLIC123");
    expect(json(f, ".firebaserc")).toEqual({ projects: { default: PUBLIC.projectId } });
  });
  it.each([
    ["minimum projectId", { projectId: "abcde0" }, {}],
    ["maximum projectId", { projectId: `a${"b".repeat(28)}0` }, {}],
    ["hostname authDomain and storageBucket", { authDomain: "auth.example.test", storageBucket: "bucket.example.test" }, {}],
    ["URL-safe public key characters", { apiKey: `AIza${"_".repeat(34)}-` }, { siteKey: "a_-".repeat(7) }],
    ["numeric string sender including leading zero", { messagingSenderId: "012345", appId: "1:012345:web:0a" }, {}],
    ["minimum site key", {}, { siteKey: "a".repeat(20) }],
    ["maximum site key", {}, { siteKey: "a".repeat(64) }],
    ["extension alphabet lower bound", {}, { extId: "a".repeat(32) }],
    ["extension alphabet upper bound", {}, { extId: "p".repeat(32) }],
  ])("M1 accepts %s", (_name, patch, opts) => {
    const config = { ...PUBLIC, ...patch }; const f = fixture(config);
    run(f, opts); assertPublic(f, config, "siteKey" in opts ? opts.siteKey : SITE_KEY);
  });

  const badConfig: Array<[string, Record<string, unknown>]> = [
    ["projectId too short", { projectId: "abcd0" }],
    ["projectId too long", { projectId: `a${"b".repeat(29)}0` }],
    ["projectId starts with number", { projectId: "1project" }],
    ["projectId uppercase", { projectId: "Project1" }],
    ["projectId trailing hyphen", { projectId: "project-" }],
    ["projectId punctuation", { projectId: "project_id" }],
    ["projectId traversal", { projectId: "../../escape" }],
    ["apiKey wrong prefix", { apiKey: `BIZA${"A".repeat(35)}` }],
    ["apiKey too short", { apiKey: `AIza${"A".repeat(34)}` }],
    ["apiKey too long", { apiKey: `AIza${"A".repeat(36)}` }],
    ["apiKey invalid character", { apiKey: `AIza${"A".repeat(34)}!` }],
    ["apiKey nonstring", { apiKey: 42 }],
    ["appId namespace", { appId: "2:123:web:ab" }],
    ["appId platform", { appId: "1:123:ios:ab" }],
    ["appId uppercase hex", { appId: "1:123:web:AB" }],
    ["appId nonnumeric sender", { appId: "1:abc:web:ab" }],
    ["appId empty suffix", { appId: "1:123:web:" }],
    ["authDomain URL", { authDomain: "https://auth.example.test" }],
    ["authDomain path", { authDomain: "auth.example.test/path" }],
    ["authDomain whitespace", { authDomain: "auth example.test" }],
    ["authDomain empty", { authDomain: "" }],
    ["storageBucket URL", { storageBucket: "gs://bucket.example.test" }],
    ["storageBucket path", { storageBucket: "bucket.example.test/path" }],
    ["storageBucket whitespace", { storageBucket: "bucket example.test" }],
    ["storageBucket empty", { storageBucket: "" }],
    ["messagingSenderId nondigits", { messagingSenderId: "abc" }],
    ["messagingSenderId sign", { messagingSenderId: "-123" }],
    ["messagingSenderId fraction", { messagingSenderId: "123.0" }],
    ["messagingSenderId number", { messagingSenderId: 123 }],
    ["messagingSenderId empty", { messagingSenderId: "" }],
  ];
  it.each(badConfig)("M1 rejects %s before any write", (_name, patch) => { reject(fixture({ ...PUBLIC, ...patch })); });
  it.each(Object.keys(PUBLIC))("M1 rejects missing %s before any write", (key) => {
    const config: Record<string, unknown> = { ...PUBLIC }; delete config[key]; reject(fixture(config));
  });
  it.each([null, [], "not an object", 42])("M1 rejects nonobject JSON %j", (input) => { reject(fixture(input)); });
  it("M1 rejects malformed JSON before any write", () => {
    const f = fixture(); put(f.input, "{ not JSON"); reject(f);
  });
  it("M1 rejects unreadable config before any write", () => {
    const f = fixture(); rmSync(f.input); reject(f);
  });
  it.each(["--config", "--site-key", "--ext-id"])("M1 rejects missing required option %s", (omit) => { reject(fixture(), { omit }); });
  it.each([
    ["short", "a".repeat(31)], ["long", "a".repeat(33)], ["outside a-p", "q".repeat(32)],
    ["uppercase", "A".repeat(32)], ["path injection", "../outside"], ["placeholder", "<EXT_ID>"],
  ])("M1 rejects extension id %s", (_name, extId) => { reject(fixture(), { extId }); });
  it.each([
    ["short", "a".repeat(19)], ["long", "a".repeat(65)], ["punctuation", `${"a".repeat(20)}!`], ["empty", ""],
  ])("M1 rejects site key %s", (_name, siteKey) => { reject(fixture(), { siteKey }); });
  it.each([
    "http://judge.example.test", "https://judge.example.test/panel", "https://", "judge.example.test",
  ])("M1 rejects hosting origin %s", (origin) => { reject(fixture(), { origin }); });
  it.each(["PLACEHOLDER_public_fixture", "replace_me_public_fixture", "cHaNgEmE_public_fixture", "TODO_public_fixture", "<PUBLIC_KEY>", "  TODO_public_fixture  "])(
    "M1 rejects placeholder semantics for site key %s", (siteKey) => { reject(fixture(), { siteKey }); },
  );
  it.each(Object.keys(PUBLIC))("M1 rejects placeholder config field %s", (key) => {
    reject(fixture({ ...PUBLIC, [key]: "PLACEHOLDER_VALUE" }));
  });
  it("M1 rejects a regex-valid lowercase TODO projectId", () => { reject(fixture({ ...PUBLIC, projectId: "todoproject" })); });
  it("M1 prints one diagnostic line per validation problem", () => {
    const f = fixture({ ...PUBLIC, apiKey: "bad", appId: "bad", messagingSenderId: "bad" });
    const output = reject(f);
    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it.each(["private_key", "client_email", "client_secret", "refresh_token", "debug", "debugToken", "debug_token", "token", "access_token", "FIREBASE_APPCHECK_DEBUG_TOKEN"])(
    "M2 refuses secret-bearing key %s without writing it", (key) => {
      const f = fixture({ ...PUBLIC, [key]: "SYNTHETIC_REFUSAL_SENTINEL" });
      expect(reject(f)).toMatch(/only public (?:firebase )?web config/i);
    },
  );
  it("M2 refuses service-account JSON with only-public-web-config guidance", () => {
    const f = fixture({ type: "service_account", project_id: PUBLIC.projectId, private_key: "SYNTHETIC_NOT_A_KEY", client_email: "synthetic@example.test" });
    expect(reject(f)).toMatch(/only public (?:firebase )?web config/i);
  });
  it.each([null, ""])("M2 refuses private_key even with empty value %j", (value) => {
    expect(reject(fixture({ ...PUBLIC, private_key: value }))).toMatch(/only public (?:firebase )?web config/i);
  });
  it("M2 refuses a nested PEM-looking value", () => {
    expect(reject(fixture({ ...PUBLIC, extra: { note: "-----BEGIN SYNTHETIC MATERIAL-----" } }))).toMatch(/only public (?:firebase )?web config/i);
  });
  it("M2 refuses a PEM-looking value under an otherwise ignored key", () => {
    expect(reject(fixture({ ...PUBLIC, measurementId: "-----BEGIN SYNTHETIC MATERIAL-----" }))).toMatch(/only public (?:firebase )?web config/i);
  });
  it("M2 refuses nested debug or PEM data rather than silently ignoring extras", () => {
    expect(reject(fixture({ ...PUBLIC, extra: { debug_token: "SYNTHETIC_REFUSAL_SENTINEL" } }))).toMatch(/only public (?:firebase )?web config/i);
  });
  it("M2 applies secret refusal in dry-run too", () => {
    expect(reject(fixture({ ...PUBLIC, token: "SYNTHETIC_REFUSAL_SENTINEL" }), { dryRun: true })).toMatch(/only public (?:firebase )?web config/i);
  });

  it("M3 changes only public config values and preserves every other byte", () => {
    const f = fixture();
    put(join(f.root, OUTPUTS[0]), text(f, OUTPUTS[0]) + '\r\n// unchanged sentinel: PLACEHOLDER_SENTINEL\r\n');
    const before = text(f, OUTPUTS[0]);
    run(f); assertPublic(f);
    expect(maskPublicValues(text(f, OUTPUTS[0]))).toBe(maskPublicValues(before));
    expect(text(f, OUTPUTS[0])).toContain('export const PLACEHOLDER_PREFIX = "PLACEHOLDER_" as const;');
  });
  it("M3 substitutes extension CSP ids without leaving EXT_ID or changing other JSON keys", () => {
    const f = fixture();
    const expectedFirebase = JSON.parse(text(f, OUTPUTS[1]).replaceAll("<EXT_ID>", EXT_ID));
    const expectedHeaders = JSON.parse(text(f, OUTPUTS[2]).replaceAll("<EXT_ID>", EXT_ID));
    run(f); assertOrigins(f);
    expect(json(f, OUTPUTS[1])).toEqual({ ...expectedFirebase, remoteconfig: { template: OUTPUTS[7] } });
    expect(json(f, OUTPUTS[2])).toEqual(expectedHeaders);
  });
  it("M3 default origin admits both project domains and preserves manifest keys and localhost", () => {
    const f = fixture(); const prod = json(f, OUTPUTS[3]); const dev = json(f, OUTPUTS[4]);
    run(f); assertOrigins(f);
    for (const [path, before] of [[OUTPUTS[3], prod], [OUTPUTS[4], dev]] as const) {
      const after = json(f, path);
      expect(after).toEqual({ ...before, externally_connectable: after.externally_connectable,
        content_security_policy: { ...before.content_security_policy, extension_pages: before.content_security_policy.extension_pages.replaceAll("https://site.test", DEFAULT_ORIGIN) } });
      expect(after.key).toBe(before.key);
    }
  });
  it("M3 panel rewrite preserves all bytes except its hosted origin", () => {
    const f = fixture(); const before = text(f, OUTPUTS[5]); run(f);
    expect(text(f, OUTPUTS[5])).toBe(before.replaceAll("https://site.test", DEFAULT_ORIGIN));
  });
  it("M3 explicit custom HTTPS origin reaches manifests, CSP and panel", () => {
    const f = fixture(); const origin = "https://judge.example.test";
    run(f, { origin }); assertOrigins(f, PUBLIC.projectId, EXT_ID, origin);
  });

  it("M4 creates the exact project binding and typed defaults for every Remote Config key", () => {
    const f = fixture(); run(f);
    expect(json(f, ".firebaserc")).toEqual({ projects: { default: PUBLIC.projectId } }); assertRemote(f);
  });
  it("M5 rerunning identical inputs changes no bytes", () => {
    const f = fixture(); run(f); const before = snapshot(f.dir); run(f);
    expect(snapshot(f.dir)).toEqual(before);
  });
  it("M5 changed public values update configured files structurally, including prior extension ids", () => {
    const f = fixture(); run(f);
    const config = { apiKey: `AIza${"B".repeat(35)}`, projectId: "fb2-second", authDomain: "fb2-second.firebaseapp.com",
      storageBucket: "fb2-second.firebasestorage.app", messagingSenderId: "999999999999", appId: "1:999999999999:web:fedcba987654" };
    put(f.input, JSON.stringify(config)); const siteKey = "second_public_site_key_12345"; const extId = "p".repeat(32);
    run(f, { siteKey, extId }); assertPublic(f, config, siteKey); assertOrigins(f, config.projectId, extId); assertRemote(f);
    expect(json(f, ".firebaserc")).toEqual({ projects: { default: config.projectId } });
    for (const path of OUTPUTS) {
      expect(text(f, path)).not.toContain(PUBLIC.projectId);
      expect(text(f, path)).not.toContain(EXT_ID);
    }
  });
  it("M5 switches custom origin to default and back without retaining stale origins", () => {
    const f = fixture(); const first = "https://first.example.test"; const second = "https://second.example.test";
    run(f, { origin: first }); run(f); assertOrigins(f);
    for (const path of [OUTPUTS[3], OUTPUTS[4], OUTPUTS[5]]) expect(text(f, path)).not.toContain(first);
    run(f, { origin: second }); assertOrigins(f, PUBLIC.projectId, EXT_ID, second);
    for (const path of [OUTPUTS[3], OUTPUTS[4], OUTPUTS[5]]) expect(text(f, path)).not.toContain(DEFAULT_ORIGIN);
  });

  it("M6 dry-run writes nothing, including absent project/template outputs", () => {
    const f = fixture(); const before = snapshot(f.dir); run(f, { dryRun: true });
    expect(snapshot(f.dir)).toEqual(before);
    expect(existsSync(join(f.root, ".firebaserc"))).toBe(false);
    expect(existsSync(join(f.root, OUTPUTS[7]))).toBe(false);
  });
  it("M6 dry-run reports each file and its affected fields", () => {
    const f = fixture(); const output = run(f, { dryRun: true });
    const fields = [
      /apiKey|authDomain|projectId|FIREBASE_PUBLIC_CONFIG/i, /remoteconfig|template|frame-ancestors|Content-Security-Policy|EXT_ID/i,
      /frame-ancestors|Content-Security-Policy|EXT_ID/i, /externally_connectable|matches|frame-src|extension_pages/i,
      /externally_connectable|matches|frame-src|extension_pages/i, /iframe|src|origin/i,
      /projects|default|projectId/i, /parameters|defaultValue|valueType|mode_status/i,
    ];
    for (const [i, path] of OUTPUTS.entries()) {
      expect(output).toContain(path);
      const start = output.indexOf(path);
      const end = Math.min(...OUTPUTS.filter((p) => p !== path).map((p) => output.indexOf(p, start + path.length)).filter((n) => n >= 0), output.length);
      expect(output.slice(start, end), path).toMatch(fields[i]!);
    }
    for (const field of [...Object.keys(PUBLIC), "RECAPTCHA_SITE_KEY_PUBLIC"]) expect(output).toContain(field);
  });
  it("M6 dry-run of changed inputs preserves an already configured tree", () => {
    const f = fixture(); run(f); const before = snapshot(f.dir);
    run(f, { dryRun: true, origin: "https://second.example.test", extId: "p".repeat(32) });
    expect(snapshot(f.dir)).toEqual(before);
  });
  it("M1/M6 invalid dry-run inputs still refuse with exit 2 and no writes", () => { reject(fixture({ ...PUBLIC, apiKey: "invalid" }), { dryRun: true }); });

  it("M7 all successful changes stay within the exact file allowlist", () => {
    const f = fixture(); const before = snapshot(f.dir); run(f); const after = snapshot(f.dir);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
    expect(changed.sort()).toEqual(OUTPUTS.map((p) => `project/${p}`).sort());
  });
  it("M7 omitted root uses the copied tool's project root rather than cwd", () => {
    const f = fixture(); const before = snapshot(f.dir); run(f, { defaultRoot: true }); assertPublic(f); assertRemote(f);
    const after = snapshot(f.dir);
    for (const path of Object.keys(after).filter((p) => !p.startsWith("project/"))) expect(after[path]).toBe(before[path]);
  });
  it.each(["file", "directory"])("M7 does not follow an output %s symlink outside root", (kind) => {
    const f = fixture(); const outside = join(f.dir, "outside");
    const target = kind === "file" ? join(f.root, "hosting/headers.json") : join(f.root, "hosting");
    renameSync(target, outside); symlinkSync(outside, target, kind === "file" ? "file" : "dir");
    const before = snapshot(f.dir); const outsideBefore = kind === "file" ? readFileSync(outside) : snapshot(outside);
    const result = invoke(f);
    expect([0, 2], result.output).toContain(result.status);
    expect(kind === "file" ? readFileSync(outside) : snapshot(outside)).toEqual(outsideBefore);
    expect(existsSync(f.audit)).toBe(false);
    if (result.status === 2) expect(snapshot(f.dir)).toEqual(before);
    else { assertPublic(f); assertOrigins(f); assertRemote(f); }
  });

  it.each([false, true])("M8 ends with two builds and three separate deploys, printed only (dry-run %s)", (dryRun) => {
    const f = fixture(); const output = run(f, { dryRun }); const lines = output.trim().split(/\r?\n/).filter(Boolean).slice(-5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/node\s+["']?(?:\.\/)?extension\/build\.mjs["']?\s+--manifest(?:=|\s+)["']?prod["']?(?:\s|$)/);
    expect(lines[1]).toMatch(/(?:npx\s+)?vite\s+build\b/);
    expect(lines[1]).toContain("hosting/vite.config.ts");
    expect(lines[1]).toMatch(/--mode(?:=|\s+)["']?production["']?(?:\s|$)/);
    expect(lines[1]).toContain("VITE_RECAPTCHA_SITE_KEY"); expect(lines[1]).toContain("VITE_EXTENSION_ORIGINS");
    for (const [i, only] of ["hosting", "firestore:rules", "remoteconfig"].entries()) {
      expect(lines[i + 2]).toMatch(/firebase\s+deploy\b/);
      expect(lines[i + 2]).toMatch(new RegExp(`--only(?:=|\\s+)["']?${only}["']?(?:\\s|$)`));
      expect(lines[i + 2]).not.toMatch(/--only[^\n]*,/);
    }
    expect(existsSync(f.audit)).toBe(false);
    expect(text(f, "hosting/dist/index.html")).toContain("untouched sentinel");
  });
});
