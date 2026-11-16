// Oracles 14, 15 (+ local store, O13 "local only"): startSwMain with a fake chrome. sw_main.ts is wired by the author.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSwMain } from "../../../extension/src/sw_main";
import { createLocalStore } from "../../../extension/src/chrome_ports";
import type { ModelRelay } from "../../../extension/src/model_relay";
import { FakeChrome, FakeClock, HOST, settle } from "../u13/harness";
import { ENDPOINTS, SEL_KEY, RELAY_RID } from "./harness";

const gate = { allowedOrigins: ["https://site.test/*", "http://localhost/*"] } as const;
const OK = "https://site.test";
async function boot() {
  const chrome = new FakeChrome(); const clock = new FakeClock();
  const main = await startSwMain({ chrome: chrome.api, clock, gate, nativeHostName: HOST, maxFrameChars: 65536 });
  return { chrome, main, models: (main as unknown as { models: ModelRelay }).models };
}
const nativeSent = (c: FakeChrome, t: string) => (c.nativePorts[0]?.sent as Array<Record<string, unknown>>).filter((f) => f["t"] === t);
afterEach(() => { vi.restoreAllMocks(); });

describe("O14 origin", () => {
  it("startSwMain returns { sw, agent, models }", async () => {
    const { main, models } = await boot();
    expect(main.sw).toBeDefined(); expect(main.agent).toBeDefined();
    expect(typeof models.onPortMessage).toBe("function"); expect(typeof models.onPortClosed).toBe("function"); expect(typeof models.stats).toBe("function");
  });
  it("disallowed origin: disconnected, its model_* messages never reach the model relay, host sees nothing", async () => {
    const { chrome, models } = await boot();
    const spy = vi.spyOn(models, "onPortMessage");
    const evil = chrome.connectExternal("https://evil.test");
    expect(evil.disconnected).toBe(true);
    evil.emit({ t: "model_list", v: 1, rid: "x" }); evil.emit({ t: "model_generate", v: 1, rid: "y" });
    expect(spy).not.toHaveBeenCalled(); expect(models.stats().ports).toBe(0); expect(models.stats().dropped).toBe(0);
    expect(evil.sent).toEqual([]);
    const none = chrome.connectExternal(undefined); none.emit({ t: "model_list", v: 1, rid: "x" });
    expect(spy).not.toHaveBeenCalled(); expect(nativeSent(chrome, "model_list")).toEqual([]);
  });
  it("allowed origin: model_list is answered by the model relay (not ready -> endpoints []), then the host hello is pushed and requests are forwarded", async () => {
    const { chrome, models } = await boot();
    const p = chrome.connectExternal(OK);
    p.emit({ t: "model_list", v: 1, rid: "r1" }); await settle();
    expect(p.ofType("model_hello")).toEqual([{ t: "model_hello", v: 1, rid: "r1", endpoints: [] }]);
    chrome.nativeEmit({ t: "model_hello", v: 1, endpoints: ENDPOINTS }); await settle();
    expect(p.ofType("model_hello")[1]).toEqual({ t: "model_hello", v: 1, endpoints: ENDPOINTS });
    p.emit({ t: "model_list", v: 1, rid: "r2" }); await settle();
    const fwd = nativeSent(chrome, "model_list");
    expect(fwd).toHaveLength(1); expect(String(fwd[0]!["rid"])).toMatch(RELAY_RID);
    expect(models.stats().forwarded).toBe(1);
  });
  it("end to end: generate result returns to the page with its own rid", async () => {
    const { chrome } = await boot(); const p = chrome.connectExternal(OK);
    chrome.nativeEmit({ t: "model_hello", v: 1, endpoints: ENDPOINTS });
    p.emit({ t: "model_generate", v: 1, rid: "g", id: "local1", tier: "standard", messages: [{ role: "user", content: "hi" }], max_tokens: 8, rung: 3 }); await settle();
    const rid = nativeSent(chrome, "model_generate")[0]!["rid"];
    chrome.nativeEmit({ t: "model_result", v: 1, rid, text: "yo" }); await settle();
    expect(p.ofType("model_result")).toEqual([{ t: "model_result", v: 1, rid: "g", text: "yo" }]);
  });
});

describe("O15 dispatch", () => {
  it("model_* never reaches the agent relay; room_* still does and never reaches the model relay", async () => {
    const { chrome, main, models } = await boot(); const p = chrome.connectExternal(OK);
    chrome.nativeEmit({ t: "model_hello", v: 1, endpoints: ENDPOINTS });
    const a0 = { ...main.agent.stats() }; const m0 = { ...models.stats() };
    const agentSpy = vi.spyOn(main.agent, "onPortMessage"); const modelSpy = vi.spyOn(models, "onPortMessage");
    p.emit({ t: "model_list", v: 1, rid: "m1" }); p.emit({ t: "model_zzz", v: 1, rid: "m2" }); p.emit({ t: "model_", v: 1 }); await settle();
    expect(agentSpy).not.toHaveBeenCalled(); expect(modelSpy).toHaveBeenCalledTimes(3);
    expect(main.agent.stats()).toEqual(a0);
    agentSpy.mockClear(); modelSpy.mockClear();
    const f0 = models.stats().forwarded;
    p.emit({ t: "room_sync", v: 1, rid: "rs", since: {} }); await settle();
    expect(agentSpy).toHaveBeenCalledTimes(1); expect(modelSpy).not.toHaveBeenCalled();
    expect(main.agent.stats().forwarded).toBe(a0.forwarded + 1); expect(models.stats().forwarded).toBe(f0);
    expect(models.stats().dropped).toBe(m0.dropped + 1); // model_ with no rid
  });
  it("existing wall hello/ping keep working next to model frames", async () => {
    const { chrome } = await boot(); const p = chrome.connectExternal(OK);
    p.emit({ t: "hello", v: 1, nonce: "n" }); p.emit({ t: "ping", v: 1 }); p.emit({ t: "model_list", v: 1, rid: "r" }); await settle();
    expect(p.ofType("snapshot")).toHaveLength(1); expect(p.ofType("pong")).toHaveLength(1); expect(p.ofType("model_hello")).toHaveLength(1);
  });
  it("onDisconnect is hooked once per port and fed to both relays", async () => {
    const { chrome, main, models } = await boot(); const p = chrome.connectExternal(OK);
    chrome.nativeEmit({ t: "model_hello", v: 1, endpoints: ENDPOINTS });
    const aClose = vi.spyOn(main.agent, "onPortClosed"); const mClose = vi.spyOn(models, "onPortClosed");
    p.emit({ t: "model_generate", v: 1, rid: "g", id: "local1", tier: "standard", messages: [{ role: "user", content: "hi" }], max_tokens: 8, rung: 3 });
    p.emit({ t: "model_list", v: 1, rid: "l" }); p.emit({ t: "room_sync", v: 1, rid: "s", since: {} }); p.emit({ t: "model_list", v: 1, rid: "l2" }); await settle();
    const rid = nativeSent(chrome, "model_generate")[0]!["rid"];
    p.peerClose();
    expect(aClose).toHaveBeenCalledTimes(1); expect(mClose).toHaveBeenCalledTimes(1);
    expect(nativeSent(chrome, "model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
  });
});

describe("selection goes to storage.local only", () => {
  it("sel_set via the real stack writes one storage.local entry and nothing to session/other", async () => {
    const { chrome } = await boot(); const p = chrome.connectExternal(OK);
    const sessionBefore = chrome.sessionSets; const keysBefore = [...chrome.session.keys()];
    p.emit({ t: "model_sel_set", v: 1, rid: "s", selection: { all: "cloud1" } }); await settle();
    expect(chrome.local.writes).toBe(1);
    expect(chrome.sessionSets).toBe(sessionBefore); expect([...chrome.session.keys()]).toEqual(keysBefore);
    expect(p.ofType("model_sel")).toEqual([{ t: "model_sel", v: 1, rid: "s", selection: { all: "cloud1" } }]);
  });
});

describe("createLocalStore (chrome_ports.ts)", () => {
  function fakeChrome() {
    const calls = { localGet: [] as string[], localSet: [] as Array<Record<string, unknown>>, sessionTouched: 0 };
    const local = new Map<string, unknown>();
    const c = {
      storage: {
        local: { get: async (k: string) => { calls.localGet.push(k); return local.has(k) ? { [k]: local.get(k) } : {}; }, set: async (o: Record<string, unknown>) => { calls.localSet.push(structuredClone(o)); for (const [k, v] of Object.entries(o)) local.set(k, v); } },
        session: { get: async () => { calls.sessionTouched++; return {}; }, set: async () => { calls.sessionTouched++; } },
      },
    };
    return { c: c as unknown as Parameters<typeof createLocalStore>[0], calls };
  }
  it("get/set map to storage.local {[key]: value}; session area untouched", async () => {
    const { c, calls } = fakeChrome(); const s = createLocalStore(c);
    expect(await s.get(SEL_KEY)).toBeUndefined();
    await s.set(SEL_KEY, { v: 1, all: "a" });
    expect(calls.localSet).toEqual([{ [SEL_KEY]: { v: 1, all: "a" } }]);
    expect(await s.get(SEL_KEY)).toEqual({ v: 1, all: "a" });
    expect(calls.sessionTouched).toBe(0);
  });
  it("storage failures propagate as rejections (the relay maps them to store_failed)", async () => {
    const { c } = fakeChrome(); (c.storage.local as { set: unknown }).set = async () => { throw new Error("quota"); };
    await expect(createLocalStore(c).set("k", 1)).rejects.toThrow();
  });
});
