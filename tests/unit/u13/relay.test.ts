import { describe, it, expect, vi } from "vitest";
import { createNativeRelay } from "../../../extension/native/relay";
import { NATIVE_HOST_TO_EXT_MAX_BYTES } from "../../../extension/src/limits";
import { FakePort, HOST, evtOfChars } from "./harness";

const MAX = 65536;
function mk(maxFrameChars = MAX, acceptImpl?: (raw: unknown) => Promise<unknown>) {
  const port = new FakePort(); const hosts: string[] = [];
  const accept = vi.fn(acceptImpl ?? (async () => ({ ok: true as const, id: 1, evictedIds: [] })));
  const relay = createNativeRelay({ hostName: HOST, maxFrameChars }, {
    connectNative: (h) => { hosts.push(h); return port; }, router: { accept: accept as never },
  });
  return { port, hosts, accept, relay };
}

describe("native relay (B22)", () => {
  it("frame limit must be within the measured 1 MiB host->extension cap (S5)", () => {
    expect(NATIVE_HOST_TO_EXT_MAX_BYTES).toBe(1_048_576);
    for (const bad of [0, -1, NaN, 1.5, NATIVE_HOST_TO_EXT_MAX_BYTES + 1]) expect(() => mk(bad), String(bad)).toThrow(RangeError);
    expect(() => mk(MAX)).not.toThrow();
    expect(() => mk(NATIVE_HOST_TO_EXT_MAX_BYTES)).not.toThrow();
  });
  it("start() opens exactly one port, to cfg.hostName", () => {
    const t = mk(); t.relay.start(); t.relay.start();
    expect(t.hosts).toEqual([HOST]);
  });
  it("frames reach Router.accept unchanged", () => {
    const t = mk(); t.relay.start();
    const f = { t: "event", v: 1, projectId: "p1", payload: { a: 1 } };
    t.port.emit(f);
    expect(t.accept).toHaveBeenCalledTimes(1);
    expect(t.accept.mock.calls[0]![0]).toEqual(f);
    expect(t.relay.stats()).toMatchObject({ frames: 1, dropped: 0 });
  });
  it("frame boundary: 65536 serialized chars pass; 65537 are dropped before accept", () => {
    const t = mk(); t.relay.start();
    const ok = { t: "event", v: 1, projectId: "p", payload: { pad: "x".repeat(MAX - JSON.stringify({ t: "event", v: 1, projectId: "p", payload: { pad: "" } }).length) } };
    const big = { t: "event", v: 1, projectId: "p", payload: { pad: "x".repeat(MAX + 1 - JSON.stringify({ t: "event", v: 1, projectId: "p", payload: { pad: "" } }).length) } };
    expect(JSON.stringify(ok)).toHaveLength(MAX); expect(JSON.stringify(big)).toHaveLength(MAX + 1);
    t.port.emit(big);
    expect(t.accept).not.toHaveBeenCalled();
    expect(t.relay.stats().dropped).toBe(1);
    t.port.emit(ok);
    expect(t.accept).toHaveBeenCalledTimes(1);
  });
  it("frames of hundreds of KiB (under the 1 MiB transport cap) are dropped when over maxFrameChars", () => {
    const t = mk(); t.relay.start();
    t.port.emit({ t: "event", v: 1, projectId: "p", payload: "y".repeat(900_000) });
    expect(t.accept).not.toHaveBeenCalled();
  });
  it("custom maxFrameChars is honoured (1 MiB config accepts a 200k frame)", () => {
    const t = mk(NATIVE_HOST_TO_EXT_MAX_BYTES); t.relay.start();
    t.port.emit({ t: "event", v: 1, projectId: "p", payload: "y".repeat(200_000) });
    expect(t.accept).toHaveBeenCalledTimes(1);
  });
  it("unserializable frames (cycle) are dropped, never thrown", () => {
    const t = mk(); t.relay.start();
    const c: Record<string, unknown> = {}; c["c"] = c;
    expect(() => t.port.emit(c)).not.toThrow();
    expect(t.accept).not.toHaveBeenCalled();
    expect(t.relay.stats().dropped).toBe(1);
  });
  it("accept rejection / thrown error is swallowed and counted as rejected", async () => {
    const t = mk(MAX, async () => ({ ok: false, code: "BAD_SHAPE" })); t.relay.start();
    t.port.emit({ t: "event", v: 1, x: 1 }); await new Promise((r) => setTimeout(r, 0));
    expect(t.relay.stats()).toMatchObject({ frames: 1, rejected: 1, accepted: 0 });
    const u = mk(MAX, async () => { throw new Error("boom"); }); u.relay.start();
    u.port.emit({ t: "event", v: 1, x: 1 }); await new Promise((r) => setTimeout(r, 0));
    expect(u.relay.stats().rejected).toBe(1);
  });
  it("accepted frames are counted", async () => {
    const t = mk(); t.relay.start(); t.port.emit({ t: "event", v: 1, projectId: "p", payload: 1 }); await new Promise((r) => setTimeout(r, 0));
    expect(t.relay.stats().accepted).toBe(1);
  });
  it("stop() disconnects the port and later frames are ignored", () => {
    const t = mk(); t.relay.start(); t.relay.stop();
    expect(t.port.disconnected).toBe(true);
    t.port.emit({ t: "event", v: 1, projectId: "p", payload: 1 });
    expect(t.accept).not.toHaveBeenCalled();
  });
  it("relay never writes to the port (read-only)", () => {
    const t = mk(); t.relay.start(); t.port.emit({ t: "event", v: 1, projectId: "p", payload: 1 });
    expect(t.port.sent).toEqual([]);
  });
  it("evtOfChars helper sanity", () => { expect(JSON.stringify(evtOfChars(70000)).length).toBeGreaterThan(65536); });
});
