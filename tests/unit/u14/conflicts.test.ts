// S4, S5, S6, S7 (+B9-B12): rev guard, denial cap, outbox.
import { describe, it, expect } from "vitest";
import { SYNC_LIMITS } from "../../../src/sync";
import { makeEnv, cap, drain, FakeFs } from "./harness";

function seeded(over: Record<string, unknown>, tier: "standard" | "private" = "standard") {
  const e = makeEnv();
  const rid = e.ridOf("p1");
  e.fs.seedWorkspace("u1"); e.fs.seedProject("u1", rid, tier);
  e.fs.seedCapsule("u1", rid, { rev: 3, observed_rev: 1, status: "idle", attention: "none", writer_uid: "u1", updated_at: { __ts: 1 }, ...over });
  return { e, rid, path: `workspaces/u1/capsules/${rid}` };
}

describe("S4 rebase_once", () => {
  it("rev bumped by another writer after the read: one retry, rev = remote+1, denied stays 0", async () => {
    const { e, path } = seeded({});
    e.fs.onGet = (k, n, store) => { if (k === path && n === 1) store.set(k, { ...store.get(k)!, rev: 4 }); };
    e.sync.putCapsule("p1", cap({ observed_rev: 5 }));
    const st = await e.sync.flush();
    expect(e.fs.capsuleCommits).toBe(2);
    expect(e.fs.store.get(path)!.rev).toBe(5);
    expect(e.fs.committedTo("capsules")).toHaveLength(1);
    expect(st.counters.denied).toBe(0);
    expect(st.pending).toBe(0);
  });
});

describe("S5 deny_cap", () => {
  it("every capsule commit denied: exactly 2 attempts, denied 1, entry dropped, same rev never retried", async () => {
    const { e } = seeded({});
    e.fs.denyCapsule = Infinity;
    e.sync.putCapsule("p1", cap({ observed_rev: 5 }));
    const st = await e.sync.flush();
    expect(e.fs.capsuleCommits).toBe(2);
    expect(st.counters.denied).toBe(1);
    expect(st.pending).toBe(0);
    await e.clock.advance(60_000);
    await e.sync.flush();
    expect(e.fs.capsuleCommits).toBe(2);
    expect(e.sync.status().counters.written).toBe(0);
  });
});

describe("S6 remote_newer", () => {
  it("remote observed_rev 9 vs local 7: no capsule write, conflicts 1, entry dropped, remote untouched", async () => {
    const { e, path } = seeded({ observed_rev: 9 });
    e.sync.putCapsule("p1", cap({ observed_rev: 7 }));
    const st = await e.sync.flush();
    expect(e.fs.attemptedTo("capsules")).toHaveLength(0);
    expect(st.counters.conflicts).toBe(1);
    expect(st.pending).toBe(0);
    expect(e.fs.store.get(path)!.rev).toBe(3);
    await e.clock.advance(60_000); await e.sync.flush();
    expect(e.fs.attemptedTo("capsules")).toHaveLength(0);
  });
  it("control: equal observed_rev is not 'newer' and is written with rev remote+1", async () => {
    const { e, path } = seeded({ observed_rev: 9 });
    e.sync.putCapsule("p1", cap({ observed_rev: 9 }));
    const st = await e.sync.flush();
    expect(st.counters.conflicts).toBe(0);
    expect(e.fs.store.get(path)!.rev).toBe(4);
  });
  it("private downgrade writes a full set with no merge, so stored text disappears (U15 E4)", async () => {
    const { e, path } = seeded({ headline: "OLD_TEXT", summary: "OLD_SUM", next_action: "OLD_NEXT", inference_source: "IN_CLOUD" }, "private");
    e.tiers.p1 = "private";
    e.sync.putCapsule("p1", cap({ observed_rev: 5 }));
    await e.sync.flush();
    const d = e.fs.store.get(path)!;
    expect(d.rev).toBe(4);
    for (const k of ["headline", "summary", "next_action", "inference_source"]) expect(d).not.toHaveProperty(k);
  });
});

describe("S7 outbox (B12)", () => {
  it("offline: 5 puts on p1 -> 1 entry; 65th project -> OUTBOX_FULL; online: latest only, serial", async () => {
    const tiers: Record<string, "standard"> = {};
    for (let i = 1; i <= 65; i++) tiers["p" + i] = "standard";
    const e = makeEnv({ tiers });
    e.fs.mode = "offline";
    const acks = [1, 2, 3, 4, 5].map((i) => e.sync.putCapsule("p1", cap({ headline: "v" + i, observed_rev: i })));
    expect(acks[0]).toEqual({ ok: true, outcome: "queued" });
    expect(acks.slice(1)).toEqual(Array(4).fill({ ok: true, outcome: "coalesced" }));
    expect(e.sync.status().pending).toBe(1);
    for (let i = 2; i <= 64; i++) expect(e.sync.putCapsule("p" + i, cap())).toMatchObject({ ok: true });
    expect(e.sync.putCapsule("p65", cap())).toEqual({ ok: false, code: "OUTBOX_FULL" });
    expect(SYNC_LIMITS.OUTBOX_MAX).toBe(64);
    expect(e.sync.status().pending).toBe(64);
    // an existing path still coalesces when the outbox is full
    expect(e.sync.putCapsule("p1", cap({ headline: "v6", observed_rev: 6 }))).toEqual({ ok: true, outcome: "coalesced" });
    const off = await e.sync.flush();
    expect(off.state).toBe("pending");
    expect(["OFFLINE", "BACKOFF"]).toContain(off.detail);
    expect(off.pending).toBe(64);
    expect(e.fs.log).toHaveLength(0);

    e.fs.mode = "ok";
    await drain(e, 8);
    expect(e.sync.status().pending).toBe(0);
    const p1 = e.fs.committedTo("capsules").filter((r) => r.segs[3] === e.ridOf("p1"));
    expect(p1).toHaveLength(1);
    expect(p1[0]!.data.headline).toBe("v6");
    expect(p1[0]!.data.rev).toBe(1);
    expect(e.fs.committedTo("capsules")).toHaveLength(64);
    expect(e.fs.maxActive).toBe(1);
  });
  it("B11: transient errors keep the entry (no 'denied'), flush recovers after backoff", async () => {
    const e = makeEnv();
    e.fs.mode = "offline";
    e.sync.putCapsule("p1", cap());
    await e.sync.flush();
    expect(e.sync.status().counters.denied).toBe(0);
    expect(e.sync.status().pending).toBe(1);
    e.fs.mode = "ok";
    await drain(e);
    expect(e.fs.committedTo("capsules")).toHaveLength(1);
    expect(e.sync.status().state).toBe("synced");
  });
  it("onStatus notifies on change and stops after unsubscribe", async () => {
    const e = makeEnv();
    const seen: string[] = [];
    const off = e.sync.onStatus((s) => seen.push(s.state));
    e.sync.putCapsule("p1", cap());
    await drain(e);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe("synced");
    off();
    const n = seen.length;
    await e.clock.advance(2100);
    e.sync.putCapsule("p1", cap({ headline: "again" }));
    await drain(e);
    expect(seen).toHaveLength(n);
  });
});
void FakeFs;
