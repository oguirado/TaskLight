// S1, S2, S3, S10, S13 (+B2, B5-B8, B14): what is written and how it is shaped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYNC_KEYS, SYNC_LIMITS } from "../../../src/sync";
import { makeEnv, cap, drain, isTs, assertB4Paths, textLeaks, TEXT_MARKERS, fnv1a32 } from "./harness";

const keysOf = (d: Record<string, unknown>): string[] => Object.keys(d).sort();
const sorted = (a: readonly string[]): string[] => [...a].sort();

describe("S1 private_no_text (STRATEGY)", () => {
  it("private tier: keys == CAPSULE_PRIVATE, no text value anywhere in the write log", async () => {
    const e = makeEnv({ tiers: { p1: "private" } });
    expect(e.sync.putCapsule("p1", cap())).toEqual({ ok: true, outcome: "queued" });
    await drain(e);
    const w = e.fs.committedTo("capsules");
    expect(w).toHaveLength(1);
    expect(keysOf(w[0]!.data)).toEqual(sorted(SYNC_KEYS.CAPSULE_PRIVATE));
    expect(textLeaks(e.fs, TEXT_MARKERS)).toEqual([]);
    for (const k of ["headline", "summary", "next_action", "steps", "progress", "lens_id", "inference_source"]) {
      expect(w[0]!.data).not.toHaveProperty(k);
    }
    // project doc of a private project hides the name behind the rid (B8)
    const p = e.fs.committedTo("projects")[0]!;
    expect(p.data.name).toBe(e.ridOf("p1"));
    expect(p.data.privacy_tier).toBe("private");
  });
  it.each(["standard", "shared"] as const)("control: %s tier writes headline/summary/next_action but never lens_id/steps/progress", async (tier) => {
    const e = makeEnv({ tiers: { p1: tier } });
    e.sync.putCapsule("p1", cap());
    await drain(e);
    const d = e.fs.committedTo("capsules")[0]!.data;
    expect(d.headline).toBe("HDLN_SECRET");
    expect(d.summary).toBe("SUMM_SECRET");
    expect(d.next_action).toBe("NEXT_SECRET");
    expect(keysOf(d)).toEqual(sorted(SYNC_KEYS.CAPSULE_FULL));
    for (const k of ["lens_id", "steps", "progress"]) expect(d).not.toHaveProperty(k);
    expect(textLeaks(e.fs, ["STEP_SECRET"])).toEqual([]);
  });
  it("U14 allowlists even when the (leaky) privacy port hands over text for a private project", async () => {
    const e = makeEnv({ tiers: { p1: "private" } });
    e.sync.putCapsule("p1", cap({ headline: "HDLN_SECRET" }));
    await drain(e);
    expect(e.privacyLog.slice(0, 2)).toEqual(["project:private", "guard:private"]);
    expect(textLeaks(e.fs, TEXT_MARKERS)).toEqual([]);
  });
});

describe("S2 no_raw_events", () => {
  it("extra raw/diff/events keys -> GUARD_REJECT, 0 writes", async () => {
    const e = makeEnv();
    const bad = cap({ raw: "RAW_EVENT", diff: "@@ -1 +1", events: [{ k: 1 }] });
    expect(e.sync.putCapsule("p1", bad)).toEqual({ ok: false, code: "GUARD_REJECT" });
    await drain(e);
    expect(e.fs.attempted).toHaveLength(0);
    expect(e.fs.txnCalls).toBe(0);
    expect(e.sync.status().pending).toBe(0);
  });
  it("guard says no -> GUARD_REJECT even for a clean state; project() runs before guard() with the tier", async () => {
    const e = makeEnv({ guardReject: true });
    expect(e.sync.putCapsule("p1", cap())).toEqual({ ok: false, code: "GUARD_REJECT" });
    expect(e.privacyLog).toEqual(["project:standard", "guard:standard"]);
    expect(e.fs.attempted).toHaveLength(0);
  });
  it("no meta -> NO_META, nothing written, privacy never consulted", async () => {
    const e = makeEnv({ tiers: {} });
    expect(e.sync.putCapsule("zz", cap())).toEqual({ ok: false, code: "NO_META" });
    expect(e.privacyLog).toEqual([]);
    expect(e.fs.attempted).toHaveLength(0);
  });
  it("B4: every logged path is workspaces/{uid} or one of projects|capsules|digests|ledger", async () => {
    const e = makeEnv({ tiers: { p1: "standard", p2: "private" } });
    e.sync.putCapsule("p1", cap()); e.sync.putCapsule("p2", cap());
    await drain(e);
    expect(e.fs.attempted.length).toBeGreaterThan(0);
    expect(assertB4Paths(e.fs, ["u1"])).toEqual([]);
  });
});

describe("S3 rev_create_update (B2, B6, B8, B9)", () => {
  it("two puts 2.1 s apart -> remote revs 1, 2; never merge; local rev ignored; project doc once", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap({ rev: 77, observed_rev: 5, headline: "v1" }));
    await e.sync.flush();
    await e.clock.advance(2100);
    e.sync.putCapsule("p1", cap({ rev: 78, observed_rev: 6, headline: "v2" }));
    const st = await e.sync.flush();
    const w = e.fs.committedTo("capsules");
    expect(w.map((r) => r.data.rev)).toEqual([1, 2]);
    expect(w.map((r) => r.data.headline)).toEqual(["v1", "v2"]);
    expect(w.map((r) => r.data.observed_rev)).toEqual([5, 6]);
    expect(e.fs.attempted.every((r) => r.extraArgs === 0)).toBe(true);
    expect(e.fs.committedTo("projects")).toHaveLength(1);
    expect(st.state).toBe("synced"); expect(st.pending).toBe(0); expect(st.detail).toBeNull();
    expect(st.counters.written).toBeGreaterThanOrEqual(2);
  });
  it("doc fields: writer_uid is the auth uid, updated_at comes from fs.timestamp, path uses the hashed rid", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap({ writer_uid: "local-x" }));
    await drain(e);
    const r = e.fs.committedTo("capsules")[0]!;
    expect(r.segs).toEqual(["workspaces", "u1", "capsules", "p_" + fnv1a32("p1")]);
    expect(r.data.writer_uid).toBe("u1");
    expect(isTs(r.data.updated_at)).toBe(true);
    expect(r.data.status).toBe("running");
    expect(r.data.attention).toBe("low");
    expect(r.data.inference_source).toBe("ON_DEVICE");
  });
  it("rate limit: second put inside 2000 ms is held; written once the interval has passed", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap({ headline: "v1" }));
    await e.sync.flush();
    e.sync.putCapsule("p1", cap({ headline: "v2" }));
    await e.clock.advance(1000);
    const st = await e.sync.flush();
    expect(e.fs.committedTo("capsules")).toHaveLength(1);
    expect(st.pending).toBe(1);
    await e.clock.advance(1000);
    await e.sync.flush();
    expect(e.fs.committedTo("capsules").map((r) => r.data.rev)).toEqual([1, 2]);
  });
  it("B2: workspace {name:'personal', members:{uid:'owner'}} is created first, once", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap());
    await drain(e);
    const first = e.fs.log[0]!;
    expect(first.segs).toEqual(["workspaces", "u1"]);
    expect(first.data).toEqual({ name: "personal", members: { u1: "owner" } });
    expect(e.fs.committedTo("workspaces")).toHaveLength(1);
  });
  it("B2: an existing workspace is never re-created or overwritten", async () => {
    const e = makeEnv();
    e.fs.seedWorkspace("u1", { u1: "owner", u9: "editor" });
    e.sync.putCapsule("p1", cap());
    await drain(e);
    expect(e.fs.attempted.filter((r) => r.segs.length === 2)).toEqual([]);
    expect(e.fs.committedTo("capsules")).toHaveLength(1);
  });
  it("B8: project doc has exactly the ProjectDoc keys and precedes the first capsule", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap());
    await drain(e);
    const pi = e.fs.log.findIndex((r) => r.segs[2] === "projects");
    const ci = e.fs.log.findIndex((r) => r.segs[2] === "capsules");
    expect(pi).toBeGreaterThanOrEqual(0); expect(pi).toBeLessThan(ci);
    const d = e.fs.log[pi]!.data;
    expect(keysOf(d)).toEqual(["created_at", "name", "privacy_tier", "source_kind", "template_hash"]);
    expect(d).toMatchObject({ name: "Display Name", privacy_tier: "standard", source_kind: "claude_code", template_hash: "th0" });
    expect(isTs(d.created_at)).toBe(true);
  });
});

describe("S10 tier_downgrade (B8, B9, B14)", () => {
  it("synced standard p1 -> setTier private: project doc first, then text-free full set, stored text removed", async () => {
    const e = makeEnv();
    const s = cap();
    e.sync.putCapsule("p1", s);
    await drain(e);
    const rid = e.ridOf("p1");
    const created = e.fs.store.get(`workspaces/u1/projects/${rid}`)!.created_at;
    const before = e.fs.log.length;
    await e.clock.advance(2100);
    e.tiers.p1 = "private";
    expect(e.sync.setTier("p1", s)).toMatchObject({ ok: true });
    await drain(e);
    const after = e.fs.log.slice(before);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after[0]!.segs).toEqual(["workspaces", "u1", "projects", rid]);
    expect(after[0]!.data).toMatchObject({ privacy_tier: "private", name: rid, created_at: created });
    const capW = after.find((r) => r.segs[2] === "capsules")!;
    expect(after.indexOf(capW)).toBeGreaterThan(0);
    expect(keysOf(capW.data)).toEqual(sorted(SYNC_KEYS.CAPSULE_PRIVATE));
    expect(capW.data.rev).toBe(2);
    expect(capW.extraArgs).toBe(0);
    expect(textLeaks({ attempted: after } as never, TEXT_MARKERS)).toEqual([]);
    const stored = e.fs.store.get(`workspaces/u1/capsules/${rid}`)!;
    expect(stored).not.toHaveProperty("headline");
    expect(stored).not.toHaveProperty("summary");
    expect(stored).not.toHaveProperty("next_action");
  });
  it("setTier(p, null) writes only the project doc with the new tier", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap());
    await drain(e);
    const nCaps = e.fs.committedTo("capsules").length;
    await e.clock.advance(2100);
    e.tiers.p1 = "private";
    expect(e.sync.setTier("p1", null)).toMatchObject({ ok: true });
    await drain(e);
    expect(e.fs.committedTo("capsules")).toHaveLength(nCaps);
    expect(e.fs.store.get(`workspaces/u1/projects/${e.ridOf("p1")}`)!.privacy_tier).toBe("private");
  });
});

describe("S13 rules_parity (B5, B6)", () => {
  it("140-char next_action is omitted (not truncated), droppedFields 1; 120 kept; 121 omitted", async () => {
    const e = makeEnv();
    e.sync.putCapsule("p1", cap({ next_action: "x".repeat(140) }));
    await drain(e);
    const d = e.fs.committedTo("capsules")[0]!.data;
    expect(d).not.toHaveProperty("next_action");
    expect(d.headline).toBe("HDLN_SECRET");
    expect(e.sync.status().counters.droppedFields).toBe(1);
    await e.clock.advance(2100);
    e.sync.putCapsule("p1", cap({ next_action: "y".repeat(SYNC_LIMITS.NEXT_ACTION_MAX) }));
    await drain(e);
    expect(e.fs.committedTo("capsules")[1]!.data.next_action).toBe("y".repeat(120));
    await e.clock.advance(2100);
    e.sync.putCapsule("p1", cap({ next_action: "z".repeat(121) }));
    await drain(e);
    expect(e.fs.committedTo("capsules")[2]!.data).not.toHaveProperty("next_action");
    expect(e.sync.status().counters.droppedFields).toBe(2);
  });
  it("status outside RULES_STATUS (e.g. 'reading') -> STATUS_NOT_SYNCABLE, 0 writes; all 6 rule statuses accepted", async () => {
    const e = makeEnv();
    expect(e.sync.putCapsule("p1", cap({ status: "reading" }))).toEqual({ ok: false, code: "STATUS_NOT_SYNCABLE" });
    await drain(e);
    expect(e.fs.attempted).toHaveLength(0);
    for (const st of SYNC_KEYS.RULES_STATUS) {
      const x = makeEnv();
      expect(x.sync.putCapsule("p1", cap({ status: st }))).toMatchObject({ ok: true });
    }
  });
  it("SYNC_KEYS / SYNC_LIMITS equal repo/firebase/firestore.rules", () => {
    const rules = readFileSync(resolve(__dirname, "../../../firebase/firestore.rules"), "utf8");
    const lists = [...rules.matchAll(/hasOnly\(\[([^\]]*)\]\)/g)].map((m) =>
      [...(m[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort().join(","));
    expect(lists).toContain(sorted(SYNC_KEYS.CAPSULE_FULL).join(","));
    expect(lists).toContain(sorted(SYNC_KEYS.CAPSULE_PRIVATE).join(","));
    expect(lists).toContain(sorted(SYNC_KEYS.LEDGER).join(","));
    const st = /request\.resource\.data\.status in \[([^\]]*)\]/.exec(rules)!;
    expect([...st[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1])).toEqual([...SYNC_KEYS.RULES_STATUS]);
    expect(/get\('next_action', ''\)\.size\(\) <= (\d+)/.exec(rules)![1]).toBe(String(SYNC_LIMITS.NEXT_ACTION_MAX));
    expect(/brief\.size\(\) <= (\d+)/.exec(rules)![1]).toBe(String(SYNC_LIMITS.BRIEF_MAX));
    expect(SYNC_LIMITS).toMatchObject({ OUTBOX_MAX: 64, MIN_INTERVAL_MS: 2000, TXN_TIMEOUT_MS: 10000, BACKOFF_MIN_MS: 1000, BACKOFF_MAX_MS: 30000 });
  });
});

describe("B7 ids", () => {
  it("rid = p_ + hash32(projectId); a second projectId on the same rid -> ID_COLLISION", async () => {
    const e = makeEnv({ tiers: { colA: "standard", colB: "standard" }, hash32: (s) => (s.startsWith("col") ? "deadbeef" : fnv1a32(s)) });
    expect(e.sync.putCapsule("colA", cap())).toMatchObject({ ok: true });
    expect(e.sync.putCapsule("colB", cap())).toEqual({ ok: false, code: "ID_COLLISION" });
    await drain(e);
    expect(e.fs.committedTo("capsules").map((r) => r.segs[3])).toEqual(["p_deadbeef"]);
  });
});
