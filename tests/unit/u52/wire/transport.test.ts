import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelChannel, createPageModelTransport } from "../../../../src/app/model_port";
import { createAgentLink } from "../../../../src/app/agent_link";
import { Channel, FakeClock, FakePort, LOCAL, signal, settled, flush } from "./fixtures";
import { FakeClock as LinkClock, EXT_ID } from "../../u22/harness";
import { track } from "../../u47/fixtures";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const request = (id = LOCAL.id, rung: 1 | 2 | 3 = 1) => ({ id, rung, tier: "standard" as const,
  messages: [{ role: "user" as const, content: "untrusted fixture prompt" }], maxTokens: 123,
  schema: { type: "object" }, signal: signal() });
function setup() {
  const ch = new Channel(); const clock = new FakeClock(); const hello = vi.fn();
  const tr = createPageModelTransport(ch, clock, hello);
  return { ch, clock, hello, tr };
}

describe("W2 transport handshake, correlation and lifetime", () => {
  it("W2 no hello: list/probe/generate/cancel emit nothing and return needs_setup", async () => {
    const { ch, tr } = setup();
    expect(tr.helloSeen()).toBe(false);
    expect(await settled(tr.list())).toEqual([]);
    expect(await settled(tr.probe(LOCAL.id, signal()))).toMatchObject({ state: "needs_setup" });
    expect(await settled(tr.generate(request()))).toEqual({ ok: false, nack: "needs_setup" });
    tr.cancel(LOCAL.id);
    expect(ch.sent).toEqual([]); tr.dispose();
  });
  it("W2 unsolicited model_hello enables sending and invokes onHello", () => {
    const { ch, hello, tr } = setup(); ch.hello();
    expect(tr.helloSeen()).toBe(true); expect(hello).toHaveBeenCalledWith([LOCAL]); tr.dispose();
  });
  it("W2 list expires at 1500ms, not 1499ms, on the injected clock", async () => {
    const { ch, clock, tr } = setup(); ch.hello(); const p = tr.list(); const box = track(p);
    await clock.advance(1499); expect(box.done).toBe(false);
    await clock.advance(1); expect(await settled(p)).toEqual([]);
    expect(clock.pending).toBe(0); tr.dispose();
  });
  it("W2 list matches the requested rid and ignores unknown replies", async () => {
    const { ch, tr } = setup(); ch.hello(); const p = tr.list(); const box = track(p);
    const frame = ch.of("model_list")[0]!; expect(frame["rid"]).toMatch(/^m[0-9]+$/);
    ch.emit({ t: "model_hello", v: 1, rid: "m999999", endpoints: [] });
    await flush(); expect(box.done).toBe(false);
    ch.emit({ t: "model_hello", v: 1, rid: frame["rid"], endpoints: [LOCAL] });
    expect(await settled(p)).toEqual([LOCAL]); tr.dispose();
  });
  it.each([1, 2, 3] as const)("W4 rung %s sends only protocol keys, schema only at rung 1", async rung => {
    const { ch, tr } = setup(); ch.hello(); const req = request(LOCAL.id, rung); const p = tr.generate(req);
    const f = ch.of("model_generate")[0]!;
    const expected: Record<string, unknown> = { t: "model_generate", v: 1, rid: f["rid"], id: LOCAL.id,
      tier: "standard", messages: req.messages, max_tokens: 123, rung };
    if (rung === 1) expected["schema"] = req.schema;
    expect(f).toEqual(expected); expect(f["rid"]).toMatch(/^m[0-9]+$/);
    ch.emit({ t: "model_result", v: 1, rid: f["rid"], text: "answer" });
    expect(await settled(p)).toEqual({ ok: true, text: "answer" }); tr.dispose();
  });
  it("W2 reverse-order generate replies settle only their own rid; duplicate replies are ignored", async () => {
    const { ch, tr } = setup(); ch.hello();
    const a = tr.generate(request()); const b = tr.generate(request()); const box = track(a);
    const [fa, fb] = ch.of("model_generate"); expect(fa!["rid"]).not.toBe(fb!["rid"]);
    ch.emit({ t: "model_result", v: 1, rid: "m999999", text: "intruder" });
    ch.emit({ t: "model_result", v: 1, rid: fb!["rid"], text: "B" });
    expect(await settled(b)).toEqual({ ok: true, text: "B" }); expect(box.done).toBe(false);
    ch.emit({ t: "model_result", v: 1, rid: fb!["rid"], text: "duplicate" });
    ch.emit({ t: "model_result", v: 1, rid: fa!["rid"], text: "A" });
    expect(await settled(a)).toEqual({ ok: true, text: "A" }); tr.dispose();
  });
  it("W2 probe consumes matching model_health", async () => {
    const { ch, tr } = setup(); ch.hello(); const p = tr.probe(LOCAL.id, signal());
    const f = ch.of("model_probe")[0]!;
    ch.emit({ t: "model_health", v: 1, rid: f["rid"], id: LOCAL.id, state: "available", rung: 2 });
    expect(await settled(p)).toEqual({ state: "available", rung: 2 }); tr.dispose();
  });
  it("W2 abort sends model_cancel with page rid and settles cancelled", async () => {
    const { ch, tr } = setup(); ch.hello(); const ac = new AbortController();
    const p = tr.generate({ ...request(), signal: ac.signal }); const rid = ch.of("model_generate")[0]!["rid"];
    ac.abort(); expect(await settled(p)).toEqual({ ok: false, nack: "cancelled" });
    expect(ch.of("model_cancel")).toContainEqual({ t: "model_cancel", v: 1, rid }); tr.dispose();
  });
  it("W2 cancel(endpoint) cancels every matching rid and leaves other endpoints pending", async () => {
    const { ch, tr } = setup(); ch.hello();
    const a = tr.generate(request()); const b = tr.generate(request()); const c = tr.generate(request("other"));
    const box = track(c); const [fa, fb, fc] = ch.of("model_generate"); tr.cancel(LOCAL.id);
    expect(await settled(a)).toEqual({ ok: false, nack: "cancelled" });
    expect(await settled(b)).toEqual({ ok: false, nack: "cancelled" }); expect(box.done).toBe(false);
    expect(ch.of("model_cancel").map(f => f["rid"]).sort()).toEqual([fa!["rid"], fb!["rid"]].sort());
    ch.emit({ t: "model_result", v: 1, rid: fc!["rid"], text: "other" });
    expect(await settled(c)).toEqual({ ok: true, text: "other" }); tr.dispose();
  });
  it("W2 reset clears hello, settles pending offline and restores silence", async () => {
    const { ch, tr } = setup(); ch.hello(); const p = tr.generate(request());
    ch.reset(); expect(await settled(p)).toEqual({ ok: false, nack: "offline" });
    expect(tr.helloSeen()).toBe(false); const n = ch.sent.length;
    expect(await settled(tr.generate(request()))).toEqual({ ok: false, nack: "needs_setup" });
    expect(ch.sent).toHaveLength(n); tr.dispose();
  });
  it("W2 host_absent nack clears host presence without throwing", async () => {
    const { ch, tr } = setup(); ch.hello(); const p = tr.generate(request());
    ch.emit({ t: "model_nack", v: 1, rid: ch.of("model_generate")[0]!["rid"], code: "host_absent" });
    expect((await settled(p)).ok).toBe(false); expect(tr.helloSeen()).toBe(false); tr.dispose();
  });
  it("W2 hostile unrelated frames do not unlock or send model traffic", async () => {
    const { ch, tr } = setup();
    for (const f of [null, [], "model_hello", { t: "room_hello", v: 1 }, { t: "model_result", v: 1, rid: "m1", text: "x" }]) ch.emit(f);
    expect(tr.helloSeen()).toBe(false); expect(await settled(tr.list())).toEqual([]); expect(ch.sent).toEqual([]); tr.dispose();
  });
  it("W2 attachModelChannel adds a listener without disrupting existing agent listeners", () => {
    const port = new FakePort(); const old = vi.fn(); port.onMessage.addListener(old);
    const ch = attachModelChannel(port); const cb = vi.fn(); const reset = vi.fn();
    const off = ch.onFrame(cb); ch.onReset(reset);
    const frame = { t: "model_hello", v: 1, endpoints: [LOCAL] }; port.emit(frame);
    expect(old).toHaveBeenCalledWith(frame); expect(cb).toHaveBeenCalledWith(frame);
    off(); cb.mockClear(); port.emit(frame); expect(cb).not.toHaveBeenCalled();
    port.drop(); expect(reset).toHaveBeenCalled();
  });
  it("W2 attach plus services leaves the no-host agent_link frame stream unchanged", async () => {
    // Compare actual agent_link sessions with identical nonce, room traffic and clocks.
    const run = (model: boolean) => {
      const port = new FakePort(); const clock = new LinkClock();
      const tr = model ? createPageModelTransport(attachModelChannel(port), clock) : undefined;
      const link = createAgentLink({ extId: EXT_ID, connect: () => port, clock, nonce: () => "fixed-nonce",
        since: () => ({}), onRoomHello: () => undefined, onRoomEvent: () => undefined });
      link.start();
      port.emit({ t: "hello", v: 1, nonce: "fixed-nonce" });
      port.emit({ t: "room_hello", v: 1, rooms: [], agent: "fixture" });
      const sent = structuredClone(port.sent); link.stop(); tr?.dispose(); return sent;
    };
    // Start with the model-enabled path so the current failure identifies the missing U52 export.
    expect(run(true)).toEqual(run(false));
  });
});
