// Module-mocked scenarios: assumes build.ts/hash.ts read PROMPT_PACKS from ./templates (spec file list).
import { afterEach, describe, expect, it, vi } from "vitest";
import { LONE_SURROGATE, PREV, cap, codes, ev, ok, tails } from "./helpers";
import type { PromptPack } from "../../../src/prompts/types";

const TPL = "../../../src/prompts/templates";
type Tpls = PromptPack["templates"];
const TASKS = ["status", "summary", "next_action", "screenshot", "digest"] as const;

async function load(extra: (real: Record<string, PromptPack>) => Record<string, PromptPack>) {
  vi.resetModules();
  vi.doMock(TPL, async () => {
    const actual = await vi.importActual<typeof import("../../../src/prompts/templates")>(TPL);
    return { ...actual, PROMPT_PACKS: extra(actual.PROMPT_PACKS as Record<string, PromptPack>) };
  });
  return import("../../../src/prompts/index");
}
const uniform = (header: string, footer: string): Tpls => {
  const t = { header, footer };
  return { status: t, summary: t, next_action: t, screenshot: t, digest: t };
};
afterEach(() => { vi.doUnmock(TPL); vi.resetModules(); });

describe("template change changes the hash (Q5, B4)", () => {
  it("header edit in v1 changes template_hash for that task and is stable otherwise", async () => {
    const real = await load((r) => r);
    const before = real.templateHash("status", "v1");
    const mod = await load((r) => {
      const v1 = r["v1"] as PromptPack;
      return { ...r, v1: { ...v1, templates: { ...v1.templates, status: { ...v1.templates.status, header: v1.templates.status.header + " CHANGED" } } } };
    });
    const after = mod.templateHash("status", "v1");
    expect(after).not.toBe(before);
    expect(mod.templateHash("summary", "v1")).toBe(real.templateHash("summary", "v1"));
    const v = ok(mod.buildPrompt(cap("status", [ev(1, 50)])));
    expect(v.template_hash).toBe(after);
    expect(v.text).toContain("CHANGED");
  });
  it("footer edit also changes it; a new version pack gives a different hash and is selected", async () => {
    const real = await load((r) => r);
    const mod = await load((r) => {
      const v1 = r["v1"] as PromptPack;
      return { ...r, v1: { ...v1, templates: { ...v1.templates, status: { ...v1.templates.status, footer: v1.templates.status.footer + " X" } } },
        v2: { version: "v2", templates: v1.templates } };
    });
    expect(mod.templateHash("status", "v1")).not.toBe(real.templateHash("status", "v1"));
    expect(mod.templateHash("summary", "v2")).not.toBe(mod.templateHash("summary", "v1"));
    const v = ok(mod.buildPrompt(cap("summary", [ev(1, 50)]), { version: "v2" }));
    expect(v.prompt_version).toBe("v2");
    expect(v.degraded).not.toContain("UNKNOWN_VERSION_FALLBACK");
    expect(v.template_hash).toBe(mod.templateHash("summary", "v2"));
  });
});

describe("OVER_BUDGET with a 7300-char header (Q4)", () => {
  it("rejects, never throws", async () => {
    const mod = await load((r) => ({ ...r, vbig: { version: "vbig", templates: uniform("H".repeat(7300), "F") } }));
    for (const t of ["status", "summary", "next_action"] as const) {
      const b = mod.buildPrompt(cap(t, [ev(1, 50)]), { version: "vbig" });
      expect(b.ok).toBe(false);
      expect(codes(b)).toEqual(["OVER_BUDGET"]);
    }
    expect(mod.buildPrompt({ task: "digest", entries: [{ projectId: "p", tier: "standard", status: "idle", attention: "low" }] }, { version: "vbig" }).ok).toBe(false);
  });
  it("header exactly fitting nothing else still OVER_BUDGET; tiny header fits (control)", async () => {
    const mod = await load((r) => ({ ...r, vtiny: { version: "vtiny", templates: uniform("H", "F") } }));
    const v = ok(mod.buildPrompt(cap("status", [ev(1, 50)]), { version: "vtiny" }));
    expect(v.chars).toBeLessThanOrEqual(7300);
    expect(v.text.startsWith("H")).toBe(true);
    expect(v.text.endsWith("F")).toBe(true);
    expect(v.prompt_version).toBe("vtiny");
  });
});

describe("clip newest event to remaining space (B10 step 3)", () => {
  it("keeps tail, prefixes ellipsis, within budget", async () => {
    const mod = await load((r) => ({ ...r, vtiny: { version: "vtiny", templates: uniform("H", "F") } }));
    const v = ok(mod.buildPrompt(cap("status", [ev(1, 1000)], { prev: null }), { version: "vtiny", maxChars: 512 }));
    expect(v.chars).toBeLessThanOrEqual(512);
    expect(v.text).toContain("_TAIL1");
    expect(v.text).not.toContain("START1_");
    expect(v.text).toContain("…x");
    expect(v.truncation.clippedChars).toBeGreaterThan(0);
    expect(v.truncation.droppedEvents).toBe(0);
    expect(v.degraded).toContain("TRUNCATED");
    expect(v.text).not.toContain("earlier events omitted");
  });
  it("sweep of budgets: always within cap, newest kept, no lone surrogate, marker consistent", async () => {
    const mod = await load((r) => ({ ...r, vtiny: { version: "vtiny", templates: uniform("H", "F") } }));
    const emoji = { seq: 6, kind: "log", text: "x" + "😀".repeat(400) + "_TAIL6" };
    for (let maxChars = 512; maxChars <= 760; maxChars++) {
      const delta = [ev(1, 300), ev(2, 300), ev(3, 300), ev(4, 300), ev(5, 300), emoji];
      const b = mod.buildPrompt(cap("summary", delta, { prev: null }), { version: "vtiny", maxChars });
      const v = ok(b);
      expect(v.chars, String(maxChars)).toBeLessThanOrEqual(maxChars);
      expect(v.chars).toBe(v.text.length);
      expect(v.text).toContain("_TAIL6");
      expect(v.text).not.toMatch(LONE_SURROGATE);
      expect(v.truncation.droppedEvents).toBeGreaterThanOrEqual(1);
      expect(v.text).toContain(`[${v.truncation.droppedEvents} earlier events omitted]`);
      const kept = tails(v.text);
      expect(kept.length + v.truncation.droppedEvents).toBe(6);
    }
  });
  it("greedy newest-first admission is maximal (a bigger budget never keeps fewer events)", async () => {
    const mod = await load((r) => ({ ...r, vtiny: { version: "vtiny", templates: uniform("H", "F") } }));
    let prevKept = 0;
    for (const maxChars of [512, 800, 1200, 1800, 2600, 3600]) {
      const v = ok(mod.buildPrompt(cap("summary", Array.from({ length: 12 }, (_, i) => ev(i + 1, 300)), { prev: null }), { version: "vtiny", maxChars }));
      const k = tails(v.text).length;
      expect(v.chars).toBeLessThanOrEqual(maxChars);
      expect(k).toBeGreaterThanOrEqual(prevKept);
      expect(tails(v.text)[k - 1]).toBe(12);
      prevKept = k;
    }
    expect(PREV.status).toBe("running");
  });
});
