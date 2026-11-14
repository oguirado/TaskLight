// S11 ledger (B16), S12 digest_filter (B15).
import { describe, it, expect } from "vitest";
import type { DigestIn } from "../../../src/sync";
import { SYNC_KEYS } from "../../../src/sync";
import { makeEnv, drain, drive, isTs, textLeaks, assertB4Paths } from "./harness";

const LEDGER_PATH = (d: string): string => `workspaces/u1/ledger/${d}`;

describe("S11 ledger (B16)", () => {
  const DAY = "2026-11-13";
  const seed = (e: ReturnType<typeof makeEnv>): void => {
    e.fs.seedWorkspace("u1");
    e.fs.store.set(LEDGER_PATH(DAY), { on_device: 1, in_cloud: 3, fallbacks: 2, refusals: 0, schema_rejects: 4 });
  };
  it("sums deltas per counter across projects; writes all 5 keys as old+delta in one transaction", async () => {
    const e = makeEnv(); seed(e);
    await drive(e.clock, e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 2 }, p2: { in_cloud: 1, on_device: 3 } }));
    const w = e.fs.committedTo("ledger");
    expect(w).toHaveLength(1);
    expect(w[0]!.segs).toEqual(["workspaces", "u1", "ledger", DAY]);
    expect(w[0]!.data).toEqual({ on_device: 4, in_cloud: 6, fallbacks: 2, refusals: 0, schema_rejects: 4 });
    expect(Object.keys(w[0]!.data).sort()).toEqual([...SYNC_KEYS.LEDGER].sort());
    expect(w[0]!.extraArgs).toBe(0);
  });
  it("absent day doc starts at 0 for every counter", async () => {
    const e = makeEnv(); e.fs.seedWorkspace("u1");
    await drive(e.clock, e.sync.ledger.applyDeltas(DAY, { p1: { refusals: 2 } }));
    expect(e.fs.committedTo("ledger")[0]!.data).toEqual({ on_device: 0, in_cloud: 0, fallbacks: 0, refusals: 2, schema_rejects: 0 });
  });
  it("workspace is created before the first ledger write when missing (B2)", async () => {
    const e = makeEnv();
    await drive(e.clock, e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 1 } }));
    expect(e.fs.log[0]!.segs).toEqual(["workspaces", "u1"]);
    expect(e.fs.committedTo("ledger")).toHaveLength(1);
  });
  it.each([
    ["negative delta", { p1: { in_cloud: -1 } }],
    ["unknown key", { p1: { bogus: 1 } }],
    ["non-integer", { p1: { in_cloud: 1.5 } }],
    ["unsafe integer", { p1: { in_cloud: 2 ** 53 } }],
    ["NaN", { p1: { in_cloud: Number.NaN } }],
  ])("%s -> rejects Error('SYNC_BAD_DELTA'), 0 writes", async (_n, deltas) => {
    const e = makeEnv(); seed(e);
    await expect(drive(e.clock, e.sync.ledger.applyDeltas(DAY, deltas))).rejects.toThrow("SYNC_BAD_DELTA");
    expect(e.fs.attempted).toHaveLength(0);
  });
  it("one bad delta among valid ones rejects the whole batch", async () => {
    const e = makeEnv(); seed(e);
    await expect(drive(e.clock, e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 2 }, p2: { on_device: -3 } }))).rejects.toThrow("SYNC_BAD_DELTA");
    expect(e.fs.attempted).toHaveLength(0);
  });
  it.each([
    ["no user", { user: null }], ["disabled", { enabled: false }], ["fs:null", { fsNull: true }],
  ] as const)("local_only (%s) -> rejects Error('SYNC_LOCAL_ONLY'), 0 calls", async (_n, o) => {
    const e = makeEnv(o);
    await expect(drive(e.clock, e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 1 } }))).rejects.toThrow("SYNC_LOCAL_ONLY");
    expect(e.fs.calls()).toBe(0);
  });
});

const dig = (over: Partial<DigestIn> = {}): DigestIn => ({
  revVector: { p1: 4 }, needs_you: [{ projectId: "p1" }], brief: "Two things need you.",
  origin: "ON_DEVICE", prompt_version: "v1", builtAt: 1_700_000_000_000, ...over,
});

describe("S12 digest_filter (B15)", () => {
  it("LOCAL_RULES, private in needs_you, unknown tier, oversize -> refusals, no writes", async () => {
    const e = makeEnv({ tiers: { p1: "standard", p2: "private" } });
    expect(e.sync.putDigest(dig({ origin: "LOCAL_RULES" }))).toEqual({ ok: false, code: "DIGEST_LOCAL_ORIGIN" });
    expect(e.sync.putDigest(dig({ revVector: { p1: 1, p2: 2 }, needs_you: [{ projectId: "p2" }] }))).toEqual({ ok: false, code: "DIGEST_HAS_PRIVATE" });
    expect(e.sync.putDigest(dig({ needs_you: [{ projectId: "ghost" }] }))).toEqual({ ok: false, code: "DIGEST_HAS_PRIVATE" });
    expect(e.sync.putDigest(dig({ brief: "x".repeat(601) }))).toEqual({ ok: false, code: "DIGEST_OVERSIZE" });
    await drain(e);
    expect(e.fs.attempted).toHaveLength(0);
  });
  it("fail-closed also when the private project only appears in the rev vector (oracle decision Q3)", async () => {
    const e = makeEnv({ tiers: { p1: "standard", p2: "private" } });
    expect(e.sync.putDigest(dig({ revVector: { p1: 1, p2: 2 } }))).toEqual({ ok: false, code: "DIGEST_HAS_PRIVATE" });
  });
  it("valid digest x2 -> exactly one create; second writes nothing; doc has the 5 rule keys, keyed by rid", async () => {
    const e = makeEnv({ tiers: { "acme-secret": "standard" } });
    const d = dig({ revVector: { "acme-secret": 4 }, needs_you: [{ projectId: "acme-secret" }], brief: "x".repeat(600) });
    expect(e.sync.putDigest(d)).toMatchObject({ ok: true });
    await drain(e);
    expect(e.sync.putDigest(d)).toMatchObject({ ok: true });
    await e.clock.advance(2100);
    await drain(e);
    const w = e.fs.committedTo("digests");
    expect(w).toHaveLength(1);
    expect(e.fs.attemptedTo("digests")).toHaveLength(1);
    const r = w[0]!;
    expect(r.segs[3]).toMatch(/^d_[0-9a-f]{8}$/);
    expect(Object.keys(r.data).sort()).toEqual(["brief", "created_at", "inference_source", "needs_you", "rev_vector"]);
    expect(r.data.inference_source).toBe("ON_DEVICE");
    expect(isTs(r.data.created_at)).toBe(true);
    expect(r.data.rev_vector).toEqual({ [e.ridOf("acme-secret")]: 4 });
    expect(JSON.stringify(r.data.needs_you)).toContain(e.ridOf("acme-secret"));
    expect(textLeaks(e.fs, ["acme-secret"])).toEqual([]);
    expect(assertB4Paths(e.fs, ["u1"])).toEqual([]);
  });
  it("id depends on {rev_vector, prompt_version}: new prompt_version -> a second doc", async () => {
    const e = makeEnv();
    e.sync.putDigest(dig()); await drain(e);
    await e.clock.advance(2100);
    e.sync.putDigest(dig({ prompt_version: "v2" })); await drain(e);
    const ids = e.fs.committedTo("digests").map((r) => r.segs[3]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
  it("IN_CLOUD origin is written as inference_source IN_CLOUD", async () => {
    const e = makeEnv();
    e.sync.putDigest(dig({ origin: "IN_CLOUD" })); await drain(e);
    expect(e.fs.committedTo("digests")[0]!.data.inference_source).toBe("IN_CLOUD");
  });
});
