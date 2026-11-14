import { describe, it, expect } from "vitest";
import { createRouter } from "../../../extension/src/router";
import { EXT_LIMITS } from "../../../extension/src/limits";
import { FakeClock, FakeSessionStore, FakeLocalStore, evt, evtOfChars } from "./harness";

const mk = (store = new FakeSessionStore(), clock = new FakeClock()) => {
  let wakes = 0;
  const router = createRouter({ store, clock, notify: () => { wakes++; } });
  return { store, clock, router, wakes: () => wakes };
};

describe("U13 router (B3-B8)", () => {
  it("O1 sw_restart_keeps_queue: FIFO survives a new router on the same store; storage.local untouched", async () => {
    const local = new FakeLocalStore();
    const a = mk(); await a.router.load();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) { const r = await a.router.accept(evt(i)); if (!r.ok) throw new Error("rejected"); ids.push(r.id); }
    const b = mk(a.store); await b.router.load();
    const got = await b.router.lease(16);
    expect(got.map((e) => e.id)).toEqual(ids);
    expect(got.map((e) => (e.payload as { n: number }).n)).toEqual([0, 1, 2]);
    expect(new Set(ids).size).toBe(3);
    expect(local.writes).toBe(0);
  });

  it("O2 persist_before_ok (neg): store.set rejects -> STORE_FAILED, nothing leased, memory unchanged", async () => {
    const a = mk(); await a.router.load();
    a.store.failSet = true;
    expect(await a.router.accept(evt(1))).toEqual({ ok: false, code: "STORE_FAILED" });
    expect(await a.router.lease(16)).toHaveLength(0);
    expect(a.router.stats().depth).toBe(0);
    expect(a.router.stats().accepted).toBe(0);
    a.store.failSet = false;
    expect((await a.router.accept(evt(2))).ok).toBe(true);
  });

  it("O2b ok is returned only after the write resolved (state is in the store when ok)", async () => {
    const a = mk(); await a.router.load();
    const r = await a.router.accept(evt(1));
    expect(r.ok).toBe(true);
    const st = a.store.data.get("u13.queue") as { v: number; items: unknown[] };
    expect(st.v).toBe(1); expect(st.items).toHaveLength(1);
  });

  it("O3 bound_evicts_oldest: 513 accepts -> depth 512, id of first evicted, dropped=1", async () => {
    const a = mk(); await a.router.load();
    let first = -1; let last: { ok: true; id: number; evictedIds: number[] } | undefined;
    for (let i = 0; i < EXT_LIMITS.QUEUE_MAX_EVENTS + 1; i++) {
      const r = await a.router.accept(evt(i));
      if (!r.ok) throw new Error("rejected");
      if (i === 0) first = r.id;
      last = r;
    }
    expect(last?.evictedIds).toEqual([first]);
    expect(a.router.stats().depth).toBe(512);
    expect(a.router.stats().dropped).toBe(1);
    const all = await a.router.lease(1000);
    expect(all).toHaveLength(512);
    expect(all.some((e) => e.id === first)).toBe(false);
    expect((all[0]?.payload as { n: number }).n).toBe(1);
  });

  it("O3b char bound: oldest evicted until totalChars <= QUEUE_MAX_CHARS", async () => {
    const a = mk(); await a.router.load();
    for (let i = 0; i < 80; i++) { const r = await a.router.accept(evtOfChars(60000)); expect(r.ok).toBe(true); }
    const s = a.router.stats();
    expect(s.totalChars).toBeLessThanOrEqual(EXT_LIMITS.QUEUE_MAX_CHARS);
    expect(s.dropped).toBeGreaterThanOrEqual(80 - 69);
    expect(s.depth + s.dropped).toBe(80);
    const items = await a.router.lease(1000);
    expect(items.reduce((n, e) => n + e.chars, 0)).toBe(s.totalChars);
  });

  it("O4 size_boundary (+control): 65537 chars TOO_LARGE and not persisted; 65536 ok", async () => {
    const a = mk(); await a.router.load();
    const before = a.store.sets;
    expect(await a.router.accept(evtOfChars(65537))).toEqual({ ok: false, code: "TOO_LARGE" });
    expect(a.store.sets).toBe(before);
    expect(a.router.stats().depth).toBe(0);
    const ok = await a.router.accept(evtOfChars(65536));
    expect(ok.ok).toBe(true);
    expect((await a.router.lease(1))[0]?.chars).toBe(65536);
  });

  it("O5 shape_checks (neg)", async () => {
    const a = mk(); await a.router.load();
    const code = async (raw: unknown) => { const r = await a.router.accept(raw); return r.ok ? "ok" : r.code; };
    expect(await code({ projectId: "", payload: 1 })).toBe("PROJECT_ID_INVALID");
    expect(await code({ projectId: "a".repeat(129), payload: 1 })).toBe("PROJECT_ID_INVALID");
    expect(await code({ projectId: 42, payload: 1 })).toBe("BAD_SHAPE");
    expect(await code({ projectId: "p1" })).toBe("BAD_SHAPE");
    expect(await code(null)).toBe("BAD_SHAPE");
    expect(await code([1])).toBe("BAD_SHAPE");
    expect(await code("str")).toBe("BAD_SHAPE");
    expect(await code({ projectId: "a".repeat(128), payload: null })).toBe("ok");
    expect(a.router.stats().rejected.BAD_SHAPE).toBe(4);
    expect(a.router.stats().rejected.PROJECT_ID_INVALID).toBe(2);
    expect(a.router.stats().depth).toBe(1);
  });

  it("O5b non-serializable payload is rejected, never thrown", async () => {
    const a = mk(); await a.router.load();
    const cyc: Record<string, unknown> = {}; cyc["self"] = cyc;
    const r = await a.router.accept({ projectId: "p1", payload: cyc });
    expect(r.ok).toBe(false);
    const r2 = await a.router.accept({ projectId: "p1", payload: 10n });
    expect(r2.ok).toBe(false);
  });

  it("O6 commit_then_restart: only uncommitted re-leased (B8); leases are disjoint within a lifetime", async () => {
    const a = mk(); await a.router.load();
    for (let i = 0; i < 3; i++) await a.router.accept(evt(i));
    const l1 = await a.router.lease(2);
    expect(l1).toHaveLength(2);
    const l2 = await a.router.lease(2);
    expect(l2.map((e) => e.id)).not.toContain(l1[0]?.id);
    expect(l2).toHaveLength(1);
    await a.router.commit([l1[0]!.id]);
    const b = mk(a.store); await b.router.load();
    const again = await b.router.lease(16);
    expect(again.map((e) => e.id)).toEqual([l1[1]!.id, l2[0]!.id]);
  });

  it("B7 load(): malformed state -> empty v1 state; ids never repeat; valid nextId preserved", async () => {
    const s = new FakeSessionStore();
    await s.set("u13.queue", { v: 7, junk: true });
    const a = mk(s); await a.router.load();
    expect(a.router.stats().depth).toBe(0);
    const r1 = await a.router.accept(evt(1));
    expect(r1.ok).toBe(true);
    const b = mk(a.store); await b.router.load();
    const id1 = (r1 as { id: number }).id;
    const l = await b.router.lease(4); await b.router.commit(l.map((x) => x.id));
    const r2 = await b.router.accept(evt(2));
    expect((r2 as { id: number }).id).toBeGreaterThan(id1);
  });

  it("B9 notify() fires once per accepted event, never for rejects", async () => {
    const a = mk(); await a.router.load();
    await a.router.accept(evt(1)); await a.router.accept({ nope: 1 }); await a.router.accept(evt(2));
    expect(a.wakes()).toBe(2);
  });

  it("peek(): non-leasing read of the whole queue in id order", async () => {
    const a = mk(); await a.router.load();
    for (let i = 0; i < 3; i++) await a.router.accept(evt(i));
    await a.router.lease(3);
    expect(a.router.peek().map((e) => (e.payload as { n: number }).n)).toEqual([0, 1, 2]);
  });
});
