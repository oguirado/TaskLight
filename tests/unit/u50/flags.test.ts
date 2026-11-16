// U50 oracle (Amendment W0-R): defaults true/true; local = external; remote = external && remote && !kill.
import { describe, expect, test } from "vitest";
import {
  CONFIG_DEFAULTS, KEY_SPECS, PROVIDER_FLAG_DEFAULTS, PROVIDER_FLAG_SPECS,
  externalProvidersPolicy, parseProviderFlags,
} from "../../../src/config/keys";
import type { ProviderFlagKey, ProviderFlags } from "../../../src/config/types";
import { ALL_KEYS } from "../u16/helpers";

// Independent reference tables (never derived from the unit under test).
const REF_DEFAULTS: ProviderFlags = { external_providers_enabled: true, remote_providers_enabled: true };
const NAMES = ["external_providers_enabled", "remote_providers_enabled"] as const;
const BAD = ["", "TRUE", "FALSE", "True", "1", "0", " true", "true ", "yes", "no", "null", "undefined", "\ttrue", "true\n", "tru"];
const refPolicy = (kill: boolean, ext: boolean, rem: boolean) => ({ local: ext, remote: ext && rem && !kill });
const allGet = (v: string) => () => v;
const byKey = (m: Record<ProviderFlagKey, string>) => (k: ProviderFlagKey) => m[k];

describe("O1 defaults and specs", () => {
  test("PROVIDER_FLAG_DEFAULTS equals {true,true} and is frozen", () => {
    expect(PROVIDER_FLAG_DEFAULTS).toEqual(REF_DEFAULTS);
    expect(Object.isFrozen(PROVIDER_FLAG_DEFAULTS)).toBe(true);
  });
  test("PROVIDER_FLAG_SPECS has exactly the two names, both bool, frozen", () => {
    expect(Object.keys(PROVIDER_FLAG_SPECS).sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) expect(PROVIDER_FLAG_SPECS[n]).toEqual({ kind: "bool" });
    expect(Object.isFrozen(PROVIDER_FLAG_SPECS)).toBe(true);
  });
});

describe("O2 parse", () => {
  test("empty strings -> defaults (true) and two INVALID_KEPT warnings with raw ''", () => {
    const r = parseProviderFlags(allGet(""));
    expect(r.flags).toEqual(REF_DEFAULTS);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.map((w) => w.key).sort()).toEqual([...NAMES].sort());
    for (const w of r.warnings) expect(w).toEqual({ key: w.key, code: "INVALID_KEPT", raw: "" });
  });
  test("empty strings with prev -> prev kept", () => {
    const prev: ProviderFlags = { external_providers_enabled: false, remote_providers_enabled: false };
    expect(parseProviderFlags(allGet(""), prev).flags).toEqual(prev);
  });
  test("exact true/false set each flag independently, no warnings", () => {
    for (const a of ["true", "false"]) for (const b of ["true", "false"]) {
      const r = parseProviderFlags(byKey({ external_providers_enabled: a, remote_providers_enabled: b }));
      expect(r.flags).toEqual({ external_providers_enabled: a === "true", remote_providers_enabled: b === "true" });
      expect(r.warnings).toEqual([]);
    }
  });
  test("get is called with the spec key names only", () => {
    const seen = new Set<string>();
    parseProviderFlags((k) => { seen.add(k); return "true"; });
    expect([...seen].sort()).toEqual([...NAMES].sort());
  });
  test.each(BAD)("bad value %j -> default true (no prev), INVALID_KEPT with raw, other key unaffected", (bad) => {
    for (const n of NAMES) {
      const other = NAMES.find((x) => x !== n)!;
      const r = parseProviderFlags((k) => (k === n ? bad : "false"));
      expect(r.flags[n]).toBe(true);
      expect(r.flags[other]).toBe(false);
      expect(r.warnings).toEqual([{ key: n, code: "INVALID_KEPT", raw: bad }]);
    }
  });
  test.each(BAD)("bad value %j keeps prev (false and true)", (bad) => {
    for (const p of [false, true]) {
      const prev: ProviderFlags = { external_providers_enabled: p, remote_providers_enabled: !p };
      const r = parseProviderFlags(allGet(bad), prev);
      expect(r.flags).toEqual(prev);
      expect(r.warnings.map((w) => w.code)).toEqual(["INVALID_KEPT", "INVALID_KEPT"]);
      for (const w of r.warnings) expect(w.raw).toBe(bad);
    }
  });
  test("throwing getter: no throw, default/prev kept, INVALID_KEPT without raw", () => {
    const boom = () => { throw new Error("boom"); };
    const r = parseProviderFlags(boom);
    expect(r.flags).toEqual(REF_DEFAULTS);
    expect(r.warnings).toHaveLength(2);
    for (const w of r.warnings) { expect(w.code).toBe("INVALID_KEPT"); expect("raw" in w).toBe(false); }
    const prev: ProviderFlags = { external_providers_enabled: false, remote_providers_enabled: false };
    expect(parseProviderFlags(boom, prev).flags).toEqual(prev);
  });
  test("one key throwing does not affect the other", () => {
    const r = parseProviderFlags((k) => { if (k === "external_providers_enabled") throw new Error("x"); return "false"; });
    expect(r.flags).toEqual({ external_providers_enabled: true, remote_providers_enabled: false });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ key: "external_providers_enabled", code: "INVALID_KEPT" });
  });
  test("non-string getter results (hostile) never throw and are INVALID_KEPT", () => {
    for (const v of [undefined, null, 1, true, {}, []] as unknown[]) {
      const r = parseProviderFlags((() => v) as unknown as (k: ProviderFlagKey) => string);
      expect(r.flags).toEqual(REF_DEFAULTS);
      expect(r.warnings.map((w) => w.code)).toEqual(["INVALID_KEPT", "INVALID_KEPT"]);
    }
  });
  test("prev frozen and not mutated; result is a fresh object", () => {
    const prev = Object.freeze({ external_providers_enabled: false, remote_providers_enabled: true });
    const r = parseProviderFlags(allGet("false"), prev);
    expect(prev).toEqual({ external_providers_enabled: false, remote_providers_enabled: true });
    expect(r.flags).not.toBe(prev);
    expect(r.flags).not.toBe(PROVIDER_FLAG_DEFAULTS);
  });
  test("deterministic: same input twice gives deep-equal output", () => {
    const g = byKey({ external_providers_enabled: "true", remote_providers_enabled: "bogus" });
    expect(parseProviderFlags(g)).toEqual(parseProviderFlags(g));
  });
});

describe("O3 precedence matrix (all 8 rows)", () => {
  const rows: Array<[boolean, boolean, boolean]> = [];
  for (const kill of [false, true]) for (const ext of [false, true]) for (const rem of [false, true]) rows.push([kill, ext, rem]);
  test.each(rows)("kill=%s external=%s remote=%s", (kill, ext, rem) => {
    const got = externalProvidersPolicy({ kill_switch_cloud: kill, external_providers_enabled: ext, remote_providers_enabled: rem });
    expect(got).toEqual(refPolicy(kill, ext, rem));
  });
  test("literal table", () => {
    const t = (k: boolean, e: boolean, r: boolean) => externalProvidersPolicy({ kill_switch_cloud: k, external_providers_enabled: e, remote_providers_enabled: r });
    expect(t(false, false, false)).toEqual({ local: false, remote: false });
    expect(t(false, false, true)).toEqual({ local: false, remote: false });
    expect(t(false, true, false)).toEqual({ local: true, remote: false });
    expect(t(false, true, true)).toEqual({ local: true, remote: true });
    expect(t(true, false, false)).toEqual({ local: false, remote: false });
    expect(t(true, false, true)).toEqual({ local: false, remote: false });
    expect(t(true, true, false)).toEqual({ local: true, remote: false });
    expect(t(true, true, true)).toEqual({ local: true, remote: false });
  });
  test("only kill=false,ext=true,rem=true yields remote:true; any kill:true row has remote:false", () => {
    const remotes = rows.filter(([k, e, r]) => externalProvidersPolicy({ kill_switch_cloud: k, external_providers_enabled: e, remote_providers_enabled: r }).remote);
    expect(remotes).toEqual([[false, true, true]]);
  });
  test("kill switch never disables local (loopback is not cloud)", () => {
    expect(externalProvidersPolicy({ kill_switch_cloud: true, external_providers_enabled: true, remote_providers_enabled: true }).local).toBe(true);
  });
  test("remote flag alone enables nothing", () => {
    expect(externalProvidersPolicy({ kill_switch_cloud: false, external_providers_enabled: false, remote_providers_enabled: true })).toEqual({ local: false, remote: false });
  });
  test("non-true inputs count as false (defensive)", () => {
    for (const bad of [undefined, null, "true", 1, 0, "", {}] as unknown[]) {
      const p = externalProvidersPolicy({ kill_switch_cloud: false, external_providers_enabled: bad as boolean, remote_providers_enabled: true });
      expect(p).toEqual({ local: false, remote: false });
      const q = externalProvidersPolicy({ kill_switch_cloud: false, external_providers_enabled: true, remote_providers_enabled: bad as boolean });
      expect(q).toEqual({ local: true, remote: false });
    }
  });
  test("extra fields on cfg (full WallConfig-like object) are ignored", () => {
    const cfg = { ...CONFIG_DEFAULTS, ...PROVIDER_FLAG_DEFAULTS };
    expect(externalProvidersPolicy(cfg)).toEqual({ local: true, remote: true });
  });
});

describe("O4 defaults end-to-end", () => {
  test("unseeded ('') flags -> policy {local:true, remote:true}", () => {
    expect(externalProvidersPolicy({ kill_switch_cloud: false, ...parseProviderFlags(() => "").flags })).toEqual({ local: true, remote: true });
  });
  test("unseeded flags with kill switch on -> {local:true, remote:false}", () => {
    expect(externalProvidersPolicy({ kill_switch_cloud: true, ...parseProviderFlags(() => "").flags })).toEqual({ local: true, remote: false });
  });
  test("console flips to false fail closed", () => {
    const f = parseProviderFlags(allGet("false")).flags;
    expect(externalProvidersPolicy({ kill_switch_cloud: false, ...f })).toEqual({ local: false, remote: false });
  });
});

describe("O5 non-regression of u16 tables", () => {
  test("CONFIG_DEFAULTS and KEY_SPECS keep exactly the 20 u16 keys, without the new names", () => {
    expect(Object.keys(CONFIG_DEFAULTS).sort()).toEqual(ALL_KEYS);
    expect(Object.keys(KEY_SPECS).sort()).toEqual(ALL_KEYS);
    expect(ALL_KEYS).toHaveLength(20);
    for (const n of NAMES) { expect(n in CONFIG_DEFAULTS).toBe(false); expect(n in KEY_SPECS).toBe(false); }
  });
});

describe("O6 purity", () => {
  test("policy: same input twice deep-equal; fresh frozen object each call; frozen inputs ok", () => {
    const cfg = Object.freeze({ kill_switch_cloud: false, external_providers_enabled: true, remote_providers_enabled: true });
    const a = externalProvidersPolicy(cfg), b = externalProvidersPolicy(cfg);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(cfg).toEqual({ kill_switch_cloud: false, external_providers_enabled: true, remote_providers_enabled: true });
  });
  test("policy: mutating a result does not affect later calls", () => {
    const cfg = { kill_switch_cloud: false, external_providers_enabled: false, remote_providers_enabled: false };
    const a = externalProvidersPolicy(cfg) as { local: boolean };
    try { a.local = true; } catch { /* frozen */ }
    expect(externalProvidersPolicy(cfg)).toEqual({ local: false, remote: false });
  });
  test("policy: result has exactly the keys local and remote", () => {
    expect(Object.keys(externalProvidersPolicy({ kill_switch_cloud: false, ...PROVIDER_FLAG_DEFAULTS })).sort()).toEqual(["local", "remote"]);
  });
  test("parse: default constants are not aliased or mutated across calls", () => {
    const r = parseProviderFlags(allGet(""));
    try { (r.flags as { external_providers_enabled: boolean }).external_providers_enabled = false; } catch { /* ok */ }
    expect(PROVIDER_FLAG_DEFAULTS).toEqual(REF_DEFAULTS);
    expect(parseProviderFlags(allGet("")).flags).toEqual(REF_DEFAULTS);
  });
});
