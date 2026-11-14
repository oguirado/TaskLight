// S9 auth_switch + B1 local_only + B3 generation counter.
import { describe, it, expect } from "vitest";
import { makeEnv, cap, drain, assertB4Paths, settle } from "./harness";

describe("B1 local_only: zero Firestore calls", () => {
  it.each([
    ["no user", { user: null }, "NO_USER"],
    ["enabled:false", { enabled: false }, "DISABLED"],
    ["fs:null", { fsNull: true }, "NO_FIREBASE"],
  ] as const)("%s -> local_only/%s, refusals, no calls", async (_n, o, detail) => {
    const e = makeEnv(o);
    expect(e.sync.putCapsule("p1", cap())).toEqual({ ok: false, code: "LOCAL_ONLY" });
    expect(e.sync.setTier("p1", cap())).toEqual({ ok: false, code: "LOCAL_ONLY" });
    expect(e.sync.putDigest({ revVector: {}, needs_you: [], brief: "b", origin: "ON_DEVICE", prompt_version: "v1", builtAt: 1 }))
      .toEqual({ ok: false, code: "LOCAL_ONLY" });
    const st = await e.sync.flush();
    await e.clock.advance(60_000);
    expect(st).toMatchObject({ state: "local_only", detail, pending: 0 });
    expect(e.fs.calls()).toBe(0);
    expect(e.clock.timerCount()).toBe(0);
  });
});

describe("S9 auth_switch (B2, B3)", () => {
  it("no user: 0 calls; u1: workspace {u1:'owner'} + capsule; u2: no write carries u1 afterwards", async () => {
    const e = makeEnv({ user: null });
    e.sync.putCapsule("p1", cap({ headline: "latest" }));
    await drain(e);
    expect(e.fs.calls()).toBe(0);

    e.auth.emit({ uid: "u1" });
    expect(e.sync.putCapsule("p1", cap({ headline: "for-u1" }))).toMatchObject({ ok: true });
    await drain(e);
    const ws = e.fs.committedTo("workspaces");
    expect(ws).toHaveLength(1);
    expect(ws[0]!.data).toEqual({ name: "personal", members: { u1: "owner" } });
    const rid = e.ridOf("p1");
    expect(e.fs.store.get(`workspaces/u1/capsules/${rid}`)).toMatchObject({ writer_uid: "u1", rev: 1, headline: "for-u1" });

    const mark = e.fs.attempted.length;
    e.auth.emit({ uid: "u2" });
    await e.clock.advance(2100);
    await drain(e);
    const post = e.fs.attempted.slice(mark);
    expect(post.length).toBeGreaterThan(0);
    for (const r of post) {
      expect(r.path).not.toContain("u1");
      // A1-U14: the old uid must not appear as a value or key ("u1"); content such as headline "for-u1" carried over by B3 is allowed
      expect(JSON.stringify(r.data)).not.toMatch(/"u1"/);
    }
    // B3: latest state is re-queued under the new writer_uid without a new put
    expect(e.fs.store.get("workspaces/u2")).toEqual({ name: "personal", members: { u2: "owner" } });
    expect(e.fs.store.get(`workspaces/u2/capsules/${rid}`)).toMatchObject({ writer_uid: "u2", rev: 1, headline: "for-u1" });
    expect(assertB4Paths(e.fs, ["u1", "u2"])).toEqual([]);
  });
  it("sign-out (null) clears the outbox and cancels timers; nothing is written afterwards", async () => {
    const e = makeEnv();
    e.fs.mode = "offline";
    e.sync.putCapsule("p1", cap());
    await e.sync.flush();
    expect(e.sync.status().pending).toBe(1);
    e.auth.emit(null);
    expect(e.sync.status()).toMatchObject({ state: "local_only", detail: "NO_USER", pending: 0 });
    expect(e.clock.timerCount()).toBe(0);
    e.fs.mode = "ok";
    const n = e.fs.txnCalls;
    await e.clock.advance(60_000); await e.sync.flush();
    expect(e.fs.txnCalls).toBe(n);
    expect(e.fs.log).toHaveLength(0);
  });
  it("late settle from a pre-switch flight is dropped (generation counter)", async () => {
    const e = makeEnv();
    let release!: () => void;
    e.fs.gate = new Promise<void>((r) => { release = r; });
    e.sync.putCapsule("p1", cap());
    void e.sync.flush();                       // u1 flight parks on the gate
    await settle();
    e.auth.emit({ uid: "u2" });
    await settle();
    await drain(e);                            // u2 flight (gate already consumed)
    const before = e.sync.status();
    release(); await settle(4);
    const after = e.sync.status();
    expect(after.counters).toEqual(before.counters);
    expect(after.pending).toBe(before.pending);
    expect(after.state).toBe("synced");
  });
  it("dispose unsubscribes from auth", async () => {
    const e = makeEnv();
    expect(e.auth.listeners()).toBe(1);
    await e.sync.dispose();
    expect(e.auth.listeners()).toBe(0);
  });
});
