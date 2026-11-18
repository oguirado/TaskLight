import { beforeEach, describe, expect, it } from "vitest";
import { createAgentRelay, type AgentRelay } from "../../../extension/src/agent_relay";
import { ExtPort, FakeExtClock, FakeNative } from "../u37c/harness";

const readError = { t: "room_sync_error", v: 1, room: "demo", code: "room_read_failed" };
const otherTerminal = { t: "room_synced", v: 1, room: "other", upto: 0, more: false };
let native: FakeNative;
let relay: AgentRelay;

beforeEach(() => {
  native = new FakeNative();
  relay = createAgentRelay({ native, clock: new FakeExtClock() });
});

function subscribe(port: ExtPort, rid: string, since = { demo: 0, other: 0 }): unknown {
  relay.onPortMessage(port, { t: "room_sync", v: 1, rid, since });
  const forwarded = native.ofType("room_sync").at(-1);
  expect(forwarded, "subscribe must reach the fake native port").toBeDefined();
  return forwarded?.["rid"];
}

describe("C5b extension fault forwarding", () => {
  it.each(["room_read_failed", "room_sync_failed"])("M2 forwards live %s unmodified to subscribers", code => {
    const page = new ExtPort();
    const second = new ExtPort();
    subscribe(page, "page-one");
    subscribe(second, "page-two");
    const frame = { ...readError, code };
    native.emit(frame);
    expect(page.ofType("room_sync_error")).toEqual([frame]);
    expect(second.ofType("room_sync_error")).toEqual([frame]);
  });

  it("M2 restores the requester rid without suppressing another room's completion", () => {
    const page = new ExtPort();
    const second = new ExtPort();
    const nativeRid = subscribe(page, "page-one");
    subscribe(second, "page-two");
    native.emit({ ...readError, rid: nativeRid });
    native.emit({ ...otherTerminal, rid: nativeRid });
    expect(page.sent).toEqual([
      { ...readError, rid: "page-one" },
      { ...otherTerminal, rid: "page-one" },
    ]);
    expect(second.sent).toEqual([]);
  });

  it.each([false, true])("M2/M6 normalizes an unknown hostile code (correlated=%s)", correlated => {
    const page = new ExtPort();
    const rid = subscribe(page, "page-one");
    native.emit({ ...readError, code: "<img src=x onerror=private_marker()>",
      ...(correlated ? { rid } : {}) });
    expect(page.ofType("room_sync_error")).toEqual([{ ...readError, code: "room_sync_failed",
      ...(correlated ? { rid: "page-one" } : {}) }]);
  });

  it("M2 ignores malformed, unknown, and unowned fault frames", () => {
    const page = new ExtPort();
    const rid = subscribe(page, "page-one");
    const { code: _code, ...missingCode } = readError;
    const bad = [
      { ...readError, t: "room_sync_errored" },
      { ...readError, v: 2 },
      { ...readError, room: { room: "demo" } },
      { ...readError, rid: 7 },
      { ...readError, rid: "obsolete" },
      { ...readError, room: "foreign", rid },
      missingCode,
    ];
    for (const frame of bad) native.emit(frame);
    expect(page.sent).toEqual([]);
    native.emit({ ...readError, rid });
    expect(page.ofType("room_sync_error"), "rejection must leave the valid response routable")
      .toEqual([{ ...readError, rid: "page-one" }]);
  });
});
