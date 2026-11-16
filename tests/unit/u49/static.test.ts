// Oracle 16 (static) + shape: frozen constants and types. Green on the stubs by design.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_RELAY_LIMITS } from "../../../extension/src/types";
import type { ExtModelMsg, PageModelMsg, StoredSelection, ModelNackCode } from "../../../extension/src/types";
import { MODEL_SELECTION_KEY, createModelRelay } from "../../../extension/src/model_relay";
import { createLocalStore } from "../../../extension/src/chrome_ports";
import type { ModelSelection } from "../../../src/providers/types";

const ROOT = resolve(__dirname, "../../..");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = (f: string): string => strip(readFileSync(resolve(ROOT, f), "utf8"));
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });

describe("O16 static", () => {
  it("model_relay.ts has no chrome identifier, console, localStorage, fetch or storage access", () => {
    const s = src("extension/src/model_relay.ts");
    expect(s).not.toMatch(/\bchrome\b/);
    expect(s).not.toMatch(/\bconsole\b/);
    expect(s).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|eval)\b/);
    expect(s).not.toMatch(/\bnew\s+Function\b/);
    expect(s).not.toMatch(/storage\s*\.\s*(local|session)/);
  });
  it("storage.local appears only in chrome_ports.ts (extension/src and extension/native)", () => {
    const hits = [...walk(join(ROOT, "extension/src")), ...walk(join(ROOT, "extension/native"))].filter((f) => /storage\s*\.\s*local\b/.test(strip(readFileSync(f, "utf8"))));
    expect(hits.map((f) => f.slice(ROOT.length + 1))).toEqual(["extension/src/chrome_ports.ts"]);
  });
  it("model_relay.ts imports nothing but types and chrome_ports types", () => {
    const imports = [...src("extension/src/model_relay.ts").matchAll(/^\s*import\s+(type\s+)?[^;]*from\s+["']([^"']+)["']/gm)];
    for (const m of imports) expect(m[2], m[0]).toMatch(/^\.\/(types|chrome_ports|limits)$/);
  });
});

describe("shape (frozen API)", () => {
  it("MODEL_RELAY_LIMITS values (J1)", () => {
    expect(MODEL_RELAY_LIMITS).toEqual({ FRAME_MAX_BYTES: 65536, QUEUE_MAX: 8, MESSAGES_MAX: 32, MAX_TOKENS_MAX: 8192, SLACK_MS: 2000, LIST_MS: 2000, PROBE_MS: 3500, LOCAL_GENERATE_MS: 32000, REMOTE_GENERATE_MS: 62000 });
  });
  it("exports exist", () => {
    expect(MODEL_SELECTION_KEY).toBe("u49.model_selection"); expect(typeof createModelRelay).toBe("function"); expect(typeof createLocalStore).toBe("function");
  });
  it("StoredSelection and ModelSelection (src/providers/types.ts) are mutually assignable; frames type-check", () => {
    const a: ModelSelection = {} as StoredSelection; const b: StoredSelection = {} as ModelSelection; void a; void b;
    const page: PageModelMsg[] = [
      { t: "model_list", v: 1, rid: "r" }, { t: "model_probe", v: 1, rid: "r", id: "x" }, { t: "model_cancel", v: 1, rid: "r" }, { t: "model_sel_get", v: 1, rid: "r" },
      { t: "model_generate", v: 1, rid: "r", id: "x", tier: "private", messages: [{ role: "user", content: "c" }], max_tokens: 1, rung: 1, schema: {} },
      { t: "model_sel_set", v: 1, rid: "r", selection: { all: "a", groups: { capsule: "b" } } },
    ];
    const codes: ModelNackCode[] = ["host_absent", "bad_request", "store_failed", "cancelled", "policy"];
    const ext: ExtModelMsg[] = [
      { t: "model_hello", v: 1, endpoints: [] }, { t: "model_health", v: 1, rid: "r", id: "x", state: "needs_setup", rung: null },
      { t: "model_result", v: 1, rid: "r", text: "" }, { t: "model_nack", v: 1, rid: "r", code: codes[0]! }, { t: "model_sel", v: 1, rid: "r", selection: {} },
    ];
    expect(page.length + ext.length).toBe(11);
  });
});
