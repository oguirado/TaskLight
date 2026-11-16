// U50 static guards: P4 (no provider URLs/names/keys in Remote Config), scope of the write surface, no side effects.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (f: string) => readFileSync(join(process.cwd(), "src/config", f), "utf8");
const u50Part = (): string => { const s = strip(read("keys.ts")); const i = s.indexOf("PROVIDER_FLAG_DEFAULTS"); return i < 0 ? "" : s.slice(i); };

describe("U50 static", () => {
  test("keys.ts defines the U50 symbols", () => {
    const s = u50Part();
    for (const n of ["PROVIDER_FLAG_DEFAULTS", "PROVIDER_FLAG_SPECS", "parseProviderFlags", "externalProvidersPolicy"]) expect(s).toContain(n);
  });
  test("types.ts exports ProviderFlags, ProviderFlagKey, ExternalProvidersPolicy and still WallConfig", () => {
    const s = strip(read("types.ts"));
    for (const n of ["interface ProviderFlags", "type ProviderFlagKey", "interface ExternalProvidersPolicy", "interface WallConfig"]) expect(s).toContain(n);
    const wall = s.slice(s.indexOf("interface WallConfig"), s.indexOf("export type ConfigKey"));
    expect(wall).not.toMatch(/providers_enabled/);
  });
  test("index re-exports keys (public surface reaches the new exports)", async () => {
    expect(read("index.ts")).toMatch(/export \* from "\.\/keys"/);
    const m = await import("../../../src/config/index");
    for (const n of ["PROVIDER_FLAG_DEFAULTS", "PROVIDER_FLAG_SPECS", "parseProviderFlags", "externalProvidersPolicy"]) expect(n in m).toBe(true);
  });
  test("U50 code has no URLs, provider names, keys, timers, network, storage, Date or random", () => {
    const s = u50Part();
    expect(s).not.toMatch(/https?:\/\/|openai|anthropic|api[_-]?key|bearer|localhost|ollama/i);
    expect(s).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|Date\.now|new Date|Math\.random|setTimeout|console\./);
    expect(s).not.toMatch(/firebase\//);
  });
  test("U50 flag names carry no per-provider URL/name/key entries (only the two names appear as flag keys)", () => {
    const keys = [...u50Part().matchAll(/\b([a-z]+_[a-z_]+)\s*:/g)].map((m) => m[1] ?? "");
    expect(new Set(keys.filter((k) => /provider|url|endpoint|key|token/.test(k)))).toEqual(new Set(["external_providers_enabled", "remote_providers_enabled"]));
  });
});
