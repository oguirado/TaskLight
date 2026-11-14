// Repair loop 1 (REVIEW_1, DISP_03-blocking findings only). See ORACLE.md "Repair loop 1".
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRouter } from "../../../extension/src/router";
import { createWallClient } from "../../../extension/src/client";
import { createServiceWorker } from "../../../extension/src/sw";
import { EXT_LIMITS } from "../../../extension/src/limits";
import type { RouterPort } from "../../../extension/src/types";
import type { ConnectorMsg } from "../../../src/app/types";
import { FakeChrome, FakeClock, FakeSessionStore, GATE, HOST, EXT_ID, SITE, evt, settle } from "./harness";

const EXT = resolve(__dirname, "../../../extension");
const KEY = "u13.queue";

async function routerOf(seed?: unknown) {
  const store = new FakeSessionStore(); const clock = new FakeClock();
  if (seed !== undefined) store.data.set(KEY, seed);
  const router = createRouter({ store, clock, notify: () => {} });
  await router.load();
  return { store, clock, router };
}
const qe = (id: number, n = id) => ({ id, projectId: "p", payload: { n }, chars: 10, receivedAt: 0 });

/** Collects unhandled rejections raised while `fn` runs. */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const h = (r: unknown) => { seen.push(r); };
  process.on("unhandledRejection", h);
  try { await fn(); await settle(15); await new Promise((r) => setTimeout(r, 20)); } finally { process.off("unhandledRejection", h); }
  return seen;
}

describe("R1-F1 manifest (SPEC DRIFT: spikes S4/S5 require nativeMessaging + externally_connectable; B1 text is stale)", () => {
  const m = (): Record<string, any> => JSON.parse(readFileSync(resolve(EXT, "manifest.json"), "utf8"));
  const REQUIRED = ["nativeMessaging", "sidePanel", "storage"];
  const ALLOWED = [...REQUIRED, "tabs", "scripting"];
  it("permissions: contains what the spikes need, nothing outside the spike-backed set", () => {
    const p: string[] = m().permissions ?? [];
    for (const r of REQUIRED) expect(p).toContain(r);
    expect(p.filter((x) => !ALLOWED.includes(x))).toEqual([]);
  });
  it("nothing broader: no <all_urls>, host_permissions, content_scripts; externally_connectable is narrow", () => {
    const x = m();
    expect(JSON.stringify(x)).not.toContain("<all_urls>");
    expect(x.host_permissions ?? []).toEqual([]);
    expect(x.content_scripts).toBeUndefined();
    const matches: string[] = x.externally_connectable?.matches ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const s of matches) expect(s).not.toMatch(/^(\*|https?|\*:)(:\/\/)?\*?\/?\*?$|:\/\/\*\/|\*\.\*/);
    expect(x.externally_connectable?.ids).toBeUndefined();
  });
});

describe("R1-F3 router restore keeps ids unique and nextId above every restored id (B7)", () => {
  it("nextId=1 with a restored id 1: a new event never reuses id 1; committing it leaves the restored one", async () => {
    const { router } = await routerOf({ v: 1, nextId: 1, items: [qe(1, 100)], totalChars: 10, dropped: 0 });
    const r = await router.accept(evt(7));
    expect(r.ok).toBe(true);
    const ids = router.peek().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    if (r.ok) {
      expect(r.id).not.toBe(1);
      await router.commit([r.id]);
    }
    expect(router.peek().map((e) => (e.payload as any).n)).toEqual([100]);
  });
  it("nextId below the max restored id: new ids are greater than every restored id", async () => {
    const { router } = await routerOf({ v: 1, nextId: 2, items: [qe(5), qe(9)], totalChars: 20, dropped: 0 });
    const r = await router.accept(evt(1));
    expect(r.ok && r.id > 9).toBe(true);
  });
  it("duplicate ids inside the restored items: ids are unique after load", async () => {
    const { router } = await routerOf({ v: 1, nextId: 3, items: [qe(1, 1), qe(1, 2)], totalChars: 20, dropped: 0 });
    const ids = router.peek().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("R1-F4 commit never updates memory when persistence rejects (B4/B8)", () => {
  it("failed commit leaves memory == storage, the event is not lost, and a retry succeeds", async () => {
    const { store, router } = await routerOf();
    const r = await router.accept(evt(1)); expect(r.ok).toBe(true);
    const [leased] = await router.lease(1);
    store.failSet = true;
    let threw = false;
    try { await router.commit([leased!.id]); } catch { threw = true; }
    const stored = (store.data.get(KEY) as { items: Array<{ id: number }> }).items.map((e) => e.id);
    expect(router.peek().map((e) => e.id)).toEqual(stored);        // memory never ahead of storage
    expect(stored).toEqual([leased!.id]);
    expect(router.stats().depth).toBe(1);
    expect(threw).toBe(true);                                        // caller must not see success
    store.failSet = false;
    await router.commit([leased!.id]);
    expect(router.peek()).toEqual([]);
    expect((store.data.get(KEY) as { items: unknown[] }).items).toEqual([]);
  });
  it("after a failed commit the event can be leased again (recoverable ownership)", async () => {
    const { store, router } = await routerOf();
    await router.accept(evt(1));
    const [l] = await router.lease(1);
    store.failSet = true;
    await router.commit([l!.id]).catch(() => {});
    store.failSet = false;
    const again = await router.lease(16);
    expect(again.map((e) => e.id)).toContain(l!.id);
  });
});

describe("R1-F5 startup entry points actually wire the pieces (B9/B10/B16)", () => {
  afterEach(() => { vi.resetModules(); delete (globalThis as any).chrome; document.documentElement.innerHTML = "<head></head><body></body>"; });

  it("loading sw_main.ts as the service-worker entry starts a ServiceWorker (T1 listener, native port, runtime listener)", async () => {
    const fc = new FakeChrome();
    (globalThis as any).chrome = fc.api;
    vi.resetModules();
    await import("../../../extension/src/sw_main"); // U38 G2: sw_main.ts is the only entry that starts the SW
    await settle(20);
    expect(fc.externalL).toHaveLength(1);
    expect(fc.nativePorts).toHaveLength(1);
    expect(fc.messageL.length).toBeGreaterThan(0);
  });

  function panelEnv() {
    const html = readFileSync(resolve(EXT, "src/panel/panel.html"), "utf8");
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>[\s\S]*$/i, "");
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const posts: Array<{ m: any; o: string }> = [];
    const cw = { postMessage: (m: unknown, o: string) => { posts.push({ m: structuredClone(m), o }); } };
    Object.defineProperty(iframe, "contentWindow", { value: cw, configurable: true });
    const sent: unknown[] = [];
    const ports: any[] = [];
    (globalThis as any).chrome = {
      runtime: {
        id: EXT_ID,
        sendMessage: vi.fn(async (m: unknown) => { sent.push(m); return undefined; }),
        onMessage: { addListener: () => {}, removeListener: () => {} },
        connect: vi.fn(() => { const p = { postMessage: (m: unknown) => { sent.push(m); }, disconnect: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }; ports.push(p); return p; }),
      },
    };
    return { cw, posts, sent };
  }

  it("loading panel.ts posts a hello to the iframe with targetOrigin === siteOrigin (never '*')", async () => {
    const { posts } = panelEnv();
    vi.resetModules();
    await import("../../../extension/src/panel/panel");
    await settle(20);
    const hellos = posts.filter((p) => p.m?.t === "hello");
    expect(hellos).toHaveLength(1);
    expect(hellos[0]!.o).toBe(SITE);
    expect(hellos[0]!.m).toMatchObject({ v: 1 });
  });

  it("panel handles the host ack (replies are consumed) and then reaches the SW through a RouterPort", async () => {
    const { cw, posts, sent } = panelEnv();
    vi.resetModules();
    await import("../../../extension/src/panel/panel");
    await settle(20);
    const nonce = posts.find((p) => p.m?.t === "hello")!.m.nonce as string;
    const ev = new MessageEvent("message", { data: { t: "ack", v: 1, nonce }, origin: SITE });
    Object.defineProperty(ev, "source", { value: cw });
    window.dispatchEvent(ev);
    await settle(20);
    expect(sent.length).toBeGreaterThan(0);      // lease request went out over runtime messaging
  });

  it("panel posts bye on page unload (B16)", async () => {
    const { posts } = panelEnv();
    vi.resetModules();
    await import("../../../extension/src/panel/panel");
    await settle(20);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("unload"));
    expect(posts.some((p) => p.m?.t === "bye" && p.o === SITE)).toBe(true);
  });
});

describe("R1-F8 failures of our own ports must not become unhandled rejections", () => {
  it("sidePanel.open() rejecting on a valid open_panel request", async () => {
    const fc = new FakeChrome(); const clock = new FakeClock();
    const api = { ...fc.api, sidePanel: { open: async () => { throw new Error("no window"); } } };
    const sw = createServiceWorker({ chrome: api, clock, gate: GATE, nativeHostName: HOST, maxFrameChars: 65536 });
    await sw.start();
    const seen = await unhandledDuring(async () => {
      await fc.sendMessage({ t: "open_panel", userGesture: true }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/panel/panel.html` });
    });
    expect(seen).toEqual([]);
  });
  it("router.lease() rejecting inside the client pump", async () => {
    const clock = new FakeClock();
    const wakers = new Set<() => void>();
    const port: RouterPort = {
      lease: async () => { throw new Error("sw gone"); },
      commit: async () => {},
      onWake: (cb) => { wakers.add(cb); return () => { wakers.delete(cb); }; },
    };
    const SRC = {}; let k = 0;
    const client = createWallClient({ ext: { siteOrigin: SITE, wallUrl: SITE + "/" }, frame: { postMessage: () => {} }, frameSource: SRC, router: port, clock, newNonce: () => `n${++k}` });
    const seen = await unhandledDuring(async () => {
      client.start();
      client.onMessage({ origin: SITE, data: { t: "ack", v: 1, nonce: "n1" }, source: SRC });
      wakers.forEach((f) => f());
    });
    expect(seen).toEqual([]);
  });
});

async function clientSetup(opts: { deferFirstCommit?: boolean; queued: number }) {
  const clock = new FakeClock(); const store = new FakeSessionStore();
  const wakers = new Set<() => void>();
  const router = createRouter({ store, clock, notify: () => wakers.forEach((f) => f()) });
  await router.load();
  for (let i = 1; i <= opts.queued; i++) await router.accept(evt(i));
  let release: (() => void) | null = null; let first = true;
  const port: RouterPort = {
    lease: (m) => router.lease(m),
    commit: async (ids) => {
      if (opts.deferFirstCommit && first) { first = false; await new Promise<void>((r) => { release = r; }); }
      await router.commit(ids);
    },
    onWake: (cb) => { wakers.add(cb); return () => { wakers.delete(cb); }; },
  };
  const posts: ConnectorMsg[] = []; const SRC = { s: 1 }; let k = 0;
  const client = createWallClient({
    ext: { siteOrigin: SITE, wallUrl: SITE + "/" }, frame: { postMessage: (m) => { posts.push(m); } },
    frameSource: SRC, router: port, clock, newNonce: () => `n${++k}`,
  });
  const ack = (n: string) => client.onMessage({ origin: SITE, data: { t: "ack", v: 1, nonce: n }, source: SRC });
  const nack = (code: string, seq?: number) => client.onMessage({ origin: SITE, data: seq === undefined ? { t: "nack", v: 1, code } : { t: "nack", v: 1, code, seq }, source: SRC });
  const events = () => posts.filter((p): p is Extract<ConnectorMsg, { t: "event" }> => p.t === "event");
  const ns = () => events().map((e) => (e.payload as { n: number }).n);
  return { clock, router, client, ack, nack, events, ns, release: () => release?.() };
}

describe("R1-F6 leases are not stranded by async transitions (B14/B15)", () => {
  it("NO_HANDSHAKE during a deferred commit: after re-link every queued event is still delivered", async () => {
    const t = await clientSetup({ deferFirstCommit: true, queued: 3 });
    t.client.start(); t.ack("n1"); await settle(10);
    expect(t.ns()).toEqual([1]);                 // first event posted, its commit is pending
    t.nack("NO_HANDSHAKE"); await settle(3);     // re-handshake begins (n2)
    t.release(); await settle(10);               // pending commit resolves mid-handshake
    t.ack("n2"); await clock10(t.clock);
    const got = new Set(t.ns());
    expect(got.has(1) && got.has(2) && got.has(3)).toBe(true);
    // nothing may stay leased-but-unsent: the router must be able to hand out whatever is left
    const left = await t.router.lease(16);
    expect(left.filter((e) => !got.has((e.payload as { n: number }).n))).toEqual([]);
  });
  it("stop() while a batch is staged does not leave events unleasable for the next client", async () => {
    const t = await clientSetup({ deferFirstCommit: true, queued: 3 });
    t.client.start(); t.ack("n1"); await settle(10);
    t.client.stop(); t.release(); await settle(10);
    const sent = new Set(t.ns());
    const left = await t.router.lease(16);                       // un-sent events must remain obtainable
    const unsentRemaining = [1, 2, 3].filter((n) => !sent.has(n));
    expect(left.map((e) => (e.payload as { n: number }).n).sort()).toEqual(unsentRemaining);
  });
});
async function clock10(c: FakeClock) { await c.advance(5000); await settle(10); }

describe("R1-F7 THROTTLED retry is once per event, not once per sequence (B15)", () => {
  it("throttle -> resend with new seq -> throttle again: no third transmission", async () => {
    const t = await clientSetup({ queued: 1 });
    t.client.start(); t.ack("n1"); await settle(10);
    const s1 = t.events()[0]!.seq;
    t.nack("THROTTLED", s1); await t.clock.advance(EXT_LIMITS.THROTTLE_RETRY_MS + 10);
    expect(t.ns()).toEqual([1, 1]);
    const s2 = t.events()[1]!.seq; expect(s2).not.toBe(s1);
    t.nack("THROTTLED", s2); await t.clock.advance(EXT_LIMITS.THROTTLE_RETRY_MS * 5);
    expect(t.ns()).toEqual([1, 1]);
  });
  it("a different event still gets its own single retry", async () => {
    const t = await clientSetup({ queued: 2 });
    t.client.start(); t.ack("n1"); await settle(10);
    const [a, b] = t.events();
    t.nack("THROTTLED", a!.seq); t.nack("THROTTLED", b!.seq);
    await t.clock.advance(EXT_LIMITS.THROTTLE_RETRY_MS + 10);
    expect(t.ns().sort()).toEqual([1, 1, 2, 2]);
  });
});
