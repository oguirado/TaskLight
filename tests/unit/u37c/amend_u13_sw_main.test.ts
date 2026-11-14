// U37c AMEND_W (U13): extension/src/sw_main.ts bootstrap (startSwMain) + dev manifest + manifest unchanged.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSwMain } from "../../../extension/src/sw_main";
import { FakeChrome, FakeClock, HOST } from "../u13/harness";
import { ROOM, idOf, roomEvent, settle, type NativeRelayAmended } from "./harness";

const ORIGIN = "http://localhost:5173";
const gate = { allowedOrigins: ["https://site.test/*", "http://localhost/*"] } as const;
async function boot() {
  const chrome = new FakeChrome(); const clock = new FakeClock();
  const main = await startSwMain({ chrome: chrome.api, clock, gate, nativeHostName: HOST, maxFrameChars: 65536 });
  return { chrome, main };
}
function linked(chrome: FakeChrome, origin = ORIGIN) {
  const p = chrome.connectExternal(origin); p.emit({ t: "hello", v: 1, nonce: "n" }); return p;
}
afterEach(() => { vi.restoreAllMocks(); });

describe("sw_main bootstrap", () => {
  it("importing the module with no `chrome` global is inert (no throw, no side effects)", async () => {
    expect((globalThis as Record<string, unknown>)["chrome"]).toBeUndefined();
    await expect(import("../../../extension/src/sw_main")).resolves.toBeDefined();
  });
  it("returns { sw, agent }: the service worker (router/pins/sources/relay) and the agent relay; one native port to the host", async () => {
    const { chrome, main } = await boot();
    expect(main.sw.router).toBeDefined();
    expect((main.sw as unknown as { relay: NativeRelayAmended }).relay.connected()).toBe(true);
    expect(typeof main.agent.onPortMessage).toBe("function");
    expect(typeof main.agent.onPortClosed).toBe("function");
    expect(chrome.nativeHosts).toEqual([HOST]);
    expect(chrome.externalL).toHaveLength(1);
  });
  it("page room_sync -> native room_sync with a rewritten rid; replay + synced come back to that page only, rid restored", async () => {
    const { chrome } = await boot();
    const a = linked(chrome); const b = linked(chrome);
    a.emit({ t: "room_sync", v: 1, rid: "pg1", since: { [ROOM]: 4 } });
    await settle();
    const [sent] = chrome.nativePorts[0]!.sent as Array<Record<string, unknown>>;
    expect(sent).toMatchObject({ t: "room_sync", v: 1, since: { [ROOM]: 4 } });
    expect(sent!["rid"]).not.toBe("pg1");
    chrome.nativeEmit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(5), rid: sent!["rid"] });
    chrome.nativeEmit({ t: "room_synced", v: 1, rid: sent!["rid"], room: ROOM, upto: 5, more: false });
    await settle();
    expect(a.ofType("room_event")).toEqual([{ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(5), rid: "pg1" }]);
    expect(a.ofType("room_synced")).toHaveLength(1);
    expect(b.ofType("room_event")).toEqual([]);
  });
  it("live room_event fans out to every page that has synced; unsynced and closed ports get nothing and nothing throws", async () => {
    const { chrome } = await boot();
    const a = linked(chrome); const b = linked(chrome); const c = linked(chrome);
    a.emit({ t: "room_sync", v: 1, rid: "x", since: {} }); b.emit({ t: "room_sync", v: 1, rid: "x", since: {} });
    await settle();
    a.peerClose();
    const live = { t: "room_event", v: 1, room: ROOM, floor: "PREFER_ON_DEVICE", event: roomEvent(6) };
    expect(() => { chrome.nativeEmit(live); }).not.toThrow();
    await settle();
    expect(b.ofType("room_event")).toEqual([live]);
    expect(c.ofType("room_event")).toEqual([]);
    expect(a.ofType("room_event")).toEqual([]);
  });
  it("closing a page port frees its pending rids (a new port gets a full 32-post budget)", async () => {
    const { chrome } = await boot();
    const a = linked(chrome);
    for (let i = 0; i < 32; i++) a.emit({ t: "room_post", v: 1, rid: `p${i}`, room: ROOM, act: "question", text: "x" });
    a.peerClose();
    const b = linked(chrome);
    for (let i = 0; i < 32; i++) b.emit({ t: "room_post", v: 1, rid: `q${i}`, room: ROOM, act: "question", text: "x" });
    await settle();
    expect(b.ofType("room_nack")).toEqual([]);
    expect(chrome.nativePorts[0]!.sent).toHaveLength(64);
  });
  it("room_post ack travels back; native down -> host_unavailable nack to the page", async () => {
    const { chrome } = await boot();
    const a = linked(chrome);
    a.emit({ t: "room_post", v: 1, rid: "pp", room: ROOM, act: "question", text: "hello" });
    await settle();
    const rid = (chrome.nativePorts[0]!.sent[0] as Record<string, unknown>)["rid"];
    chrome.nativeEmit({ t: "room_ack", v: 1, rid, id: idOf(8), lamport: 8 }); await settle();
    expect(a.ofType("room_ack")).toEqual([{ t: "room_ack", v: 1, rid: "pp", id: idOf(8), lamport: 8 }]);
    chrome.nativePorts[0]!.peerClose();
    a.emit({ t: "room_post", v: 1, rid: "pp2", room: ROOM, act: "question", text: "again" }); await settle();
    expect(a.ofType("room_nack")).toEqual([{ t: "room_nack", v: 1, rid: "pp2", code: "host_unavailable" }]);
  });
  it("existing wall protocol is unchanged: hello -> snapshot, event frames from native still reach Router + wall; room traffic never touches storage or console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const { chrome, main } = await boot();
    const a = linked(chrome);
    expect(a.ofType("snapshot")).toHaveLength(1);
    a.emit({ t: "room_sync", v: 1, rid: "s", since: {} });
    a.emit({ t: "room_post", v: 1, rid: "p", room: ROOM, act: "question", text: "SECRET-ROOM-TEXT" });
    chrome.nativeEmit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(1) });
    chrome.nativeEmit({ t: "event", v: 1, projectId: "p1", payload: { n: 1 } }); await settle();
    expect(a.ofType("event")).toHaveLength(1);
    expect(main.sw.router.peek()).toHaveLength(1);
    expect(chrome.local.writes).toBe(0);
    expect(JSON.stringify([...chrome.session.entries()])).not.toContain("SECRET-ROOM-TEXT");
    expect(JSON.stringify([...chrome.session.entries()])).not.toContain(idOf(1));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

const ROOT = resolve(__dirname, "../../../extension");
const read = (f: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(ROOT, f), "utf8")) as Record<string, unknown>;

describe("manifests", () => {
  it("manifest.json stays as is (spike permissions, https://site.test only, no localhost)", () => {
    const m = read("manifest.json");
    expect(m["manifest_version"]).toBe(3);
    expect(m["permissions"]).toEqual(["storage", "sidePanel", "tabs", "scripting", "nativeMessaging"]);
    expect(m["optional_host_permissions"]).toEqual(["https://*/*"]);
    expect(m["externally_connectable"]).toEqual({ matches: ["https://site.test/*"] });
    expect(m["background"]).toEqual({ service_worker: "src/sw.js" });
    expect(JSON.stringify(m)).not.toContain("localhost");
  });
  it("manifest.dev.json exists, is identical to manifest.json except key (U38 G6: valid public SPKI) and externally_connectable (gains http://localhost/*)", () => {
    expect(existsSync(resolve(ROOT, "manifest.dev.json"))).toBe(true);
    const base = read("manifest.json"); const dev = read("manifest.dev.json");
    const ec = dev["externally_connectable"] as { matches: string[] };
    expect(ec.matches).toContain("http://localhost/*");
    expect(ec.matches).toContain("https://site.test/*");
    expect(Object.keys(ec)).toEqual(["matches"]);
    const { externally_connectable: _a, key: _ka, ...restBase } = base; const { externally_connectable: _b, key: _kb, ...restDev } = dev;
    expect(restDev).toEqual(restBase);
    // U38 G6: dev key is a valid base64 DER SubjectPublicKeyInfo (never a private key / PEM).
    const key = dev["key"] as string;
    expect(typeof key).toBe("string");
    expect(key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const der = Buffer.from(key, "base64");
    expect(der[0]).toBe(0x30); // DER SEQUENCE
    expect(der.length).toBeGreaterThan(90);
    expect(der.toString("latin1")).not.toContain("PRIVATE");
    expect(dev["permissions"]).toEqual(base["permissions"]);
  });
});
