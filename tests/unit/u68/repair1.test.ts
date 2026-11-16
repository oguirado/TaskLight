import { afterEach, describe, expect, it } from "vitest";
import { createAgentLink, type AgentLink } from "../../../src/app/agent_link";
import { EXT_ID, FakeAppClock, pageRuntime } from "../u37c/harness";

const links: AgentLink[] = [];
afterEach(() => { for (const link of links.splice(0)) link.stop(); });

function rig() {
  const clock = new FakeAppClock();
  const rt = pageRuntime();
  const cursors = { demo: 0, other: 0 };
  const link = createAgentLink({
    extId: EXT_ID, connect: rt.connect, clock, nonce: () => "u68-repair",
    since: () => ({ ...cursors }), onRoomEvent: () => {}, onRoomHello: () => {},
  });
  links.push(link);
  link.start();
  const p = rt.last();
  const snapshot = () => {
    p.emit({ t: "snapshot", v: 1, nonce: "u68-repair", items: [] });
    clock.advance(1);
  };
  snapshot();
  const hello = () => p.emit({ t: "room_hello", v: 1, agent: "wall-user", rooms: [
    { room: "demo", floor: "ONLY_ON_DEVICE" },
    { room: "other", floor: "PREFER_ON_DEVICE" },
  ] });
  hello();
  const syncs = (room = "demo") => p.ofType("room_sync").filter(frame =>
    Object.hasOwn(frame["since"] as object, room));
  const complete = (rid: unknown, upto: number, more: boolean, room = "demo") =>
    p.emit({ t: "room_synced", v: 1, rid, room, upto, more });
  return { cursors, snapshot, hello, syncs, complete };
}

describe("U68 repair: serialize snapshots and continuations", () => {
  it("coalesces snapshots until the in-flight replay completes and uses the current cursor", () => {
    const r = rig();
    const initial = r.syncs().at(-1)!["rid"];
    r.complete(initial, 500, true);
    const continuation = r.syncs().at(-1)!["rid"];
    const before = r.syncs().length;
    r.snapshot();
    r.snapshot();
    expect(r.syncs()).toHaveLength(before);

    // The original continuation must still be honoured after the snapshots.
    r.complete(continuation, 1000, true);
    expect(r.syncs()).toHaveLength(before + 1);
    expect(r.syncs().at(-1)).toMatchObject({ since: { demo: 1000 } });
    const lastPage = r.syncs().at(-1)!["rid"];
    r.complete(continuation, 1000, true);
    expect(r.syncs()).toHaveLength(before + 1);

    r.cursors.demo = 1500;
    r.complete(lastPage, 1500, false);
    expect(r.syncs()).toHaveLength(before + 2);
    expect(r.syncs().at(-1)).toMatchObject({ since: { demo: 1500 } });
    const pending = r.syncs().at(-1)!["rid"];
    r.complete(lastPage, 1500, false);
    expect(r.syncs()).toHaveLength(before + 2);
    r.complete(pending, 1500, false);
    expect(r.syncs()).toHaveLength(before + 2);
  });

  it("lets another room finish while demo remains in flight", () => {
    const r = rig();
    const initial = r.syncs().at(-1)!["rid"];
    r.complete(initial, 500, true);
    const demoBefore = r.syncs().length;
    const otherBefore = r.syncs("other").length;
    r.snapshot();
    r.cursors.other = 42;
    r.complete(initial, 42, false, "other");
    expect(r.syncs()).toHaveLength(demoBefore);
    expect(r.syncs("other")).toHaveLength(otherBefore + 1);
    expect(r.syncs("other").at(-1)).toMatchObject({ since: { other: 42 } });
  });

  it("abandons the old request on hello without sending the pending sync twice", () => {
    const r = rig();
    r.complete(r.syncs().at(-1)!["rid"], 500, true);
    const abandoned = r.syncs().at(-1)!["rid"];
    r.snapshot();
    const before = r.syncs().length;
    r.cursors.demo = 700;
    r.hello();
    expect(r.syncs()).toHaveLength(before + 1);
    expect(r.syncs().at(-1)).toMatchObject({ since: { demo: 700, other: 0 } });
    const current = r.syncs().at(-1)!["rid"];
    r.complete(abandoned, 1000, false);
    expect(r.syncs()).toHaveLength(before + 1);
    r.complete(current, 700, false);
    expect(r.syncs()).toHaveLength(before + 1);
  });
});
