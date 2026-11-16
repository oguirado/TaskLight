// Repair loop 2: regression tests for reviewer review r1 (B5 vocab from schema, B8/B13 sparse arrays, input bounds).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrompt } from "../../../src/prompts/index";
import type { CapsuleInput, DigestEntry, PromptEvent } from "../../../src/prompts/index";
import { cap, entry, ev } from "./helpers";

type Err = { code: string; path: string };
const errsOf = (b: ReturnType<typeof buildPrompt>): Err[] => {
  expect(b.ok).toBe(false);
  return b.ok ? [] : (b.errors as unknown as Err[]);
};
const has = (errs: Err[], code: string, path: string): boolean => errs.some((e) => e.code === code && e.path === path);

describe("R2-1 B5 (orchestrator decision): vocabulary in templates comes from the schema exports", () => {
  afterEach(() => { vi.doUnmock("../../../src/schema"); vi.resetModules(); });

  it("with CAPSULE_STATUS/ATTENTION replaced by disjoint values, each prompt lists exactly the exported vocabulary", async () => {
    const STAT = Object.freeze(["alpha_s", "beta_s"] as const);
    const ATT = Object.freeze(["att_x", "att_y", "att_z"] as const);
    vi.resetModules();
    vi.doMock("../../../src/schema", async () => {
      const actual = await vi.importActual<Record<string, unknown>>("../../../src/schema");
      return { ...actual, CAPSULE_STATUS: STAT, ATTENTION: ATT };
    });
    const m = await import("../../../src/prompts/index");
    const text = (i: unknown): string => {
      const b = m.buildPrompt(i as never);
      expect(b.ok, JSON.stringify(b.ok ? "" : b.errors)).toBe(true);
      return b.ok ? b.value.text : "";
    };
    const e1 = [{ seq: 1, kind: "log", text: "x" }];
    const base = { projectId: "p1", tier: "standard" } as const;
    const byTask: Record<string, string> = {
      status: text({ task: "status", ...base, prev: null, delta: e1 }),
      summary: text({ task: "summary", ...base, prev: null, delta: e1 }),
      next_action: text({ task: "next_action", ...base, prev: null, delta: e1 }),
      screenshot: text({ task: "screenshot", ...base, prev: null }),
      digest: text({ task: "digest", entries: [{ projectId: "p1", tier: "standard", status: "alpha_s", attention: "att_x" }] }),
    };
    const wantStatuses = ["status", "summary", "screenshot"];
    const wantAttention = ["summary", "next_action", "digest"];
    for (const t of wantStatuses) {
      for (const v of STAT) expect(byTask[t], `${t} lists ${v}`).toContain(v);
      for (const old of ["waiting_input", "blocked", "failed"]) expect(byTask[t], `${t} must not list stale ${old}`).not.toMatch(new RegExp(`\\b${old}\\b`));
    }
    for (const t of wantAttention) {
      for (const v of ATT) expect(byTask[t], `${t} lists ${v}`).toContain(v);
      for (const old of ["low", "high", "now"]) expect(byTask[t], `${t} must not list stale ${old}`).not.toMatch(new RegExp(`\\b${old}\\b`));
    }
  });
});

describe("R2-2 B8/B13: sparse array holes are missing elements (BAD_INPUT at the index)", () => {
  it("delta [ <hole>, event ] -> BAD_INPUT at delta[0]", () => {
    const delta = [, { seq: 1, kind: "log", text: "x" }] as unknown as PromptEvent[];
    const errs = errsOf(buildPrompt(cap("status", delta)));
    expect(has(errs, "BAD_INPUT", "delta[0]")).toBe(true);
  });
  it("delta new Array(2) -> BAD_INPUT at delta[0] and delta[1], nothing reported at path \"\"", () => {
    const errs = errsOf(buildPrompt(cap("status", new Array(2) as unknown as PromptEvent[])));
    expect(has(errs, "BAD_INPUT", "delta[0]")).toBe(true);
    expect(has(errs, "BAD_INPUT", "delta[1]")).toBe(true);
    expect(errs.some((e) => e.path === "")).toBe(false);
  });
  it("digest entries new Array(2) -> BAD_INPUT at entries[0] and entries[1], not OVER_BUDGET", () => {
    const errs = errsOf(buildPrompt({ task: "digest", entries: new Array(2) as unknown as DigestEntry[] }));
    expect(has(errs, "BAD_INPUT", "entries[0]")).toBe(true);
    expect(has(errs, "BAD_INPUT", "entries[1]")).toBe(true);
    expect(errs.some((e) => e.code === "OVER_BUDGET")).toBe(false);
  });
  it("digest entries [ <hole>, valid ] -> BAD_INPUT at entries[0]", () => {
    const entries = [, entry("p1", "now")] as unknown as DigestEntry[];
    expect(has(errsOf(buildPrompt({ task: "digest", entries })), "BAD_INPUT", "entries[0]")).toBe(true);
  });
});

describe("R2-3 B8/B13: input bounds are enforced without scanning the oversized input", () => {
  it("delta of 1,000,000 identical events: TOO_MANY_EVENTS and a bounded error list (no 999,999 DUPLICATE_SEQ)", () => {
    const e: PromptEvent = ev(1, 10);
    const delta = new Array<PromptEvent>(1_000_000).fill(e);
    const errs = errsOf(buildPrompt(cap("status", delta as CapsuleInput["delta"] & PromptEvent[])));
    expect(errs.some((x) => x.code === "TOO_MANY_EVENTS")).toBe(true);
    expect(errs.length).toBeLessThanOrEqual(257);
  });
  it("digest of 1,000,000 identical entries: BAD_INPUT at entries and a bounded error list", () => {
    const e = entry("p1", "now");
    const entries = new Array<DigestEntry>(1_000_000).fill(e);
    const errs = errsOf(buildPrompt({ task: "digest", entries }));
    expect(has(errs, "BAD_INPUT", "entries")).toBe(true);
    expect(errs.length).toBeLessThanOrEqual(65);
  });
});
