import { describe, expect, it } from "vitest";
import { bootReady, gen, mkPort, post, frames, nackOf, hResult } from "../u49/harness";

describe("U80 A5 extension room validation and forwarding", () => {
  it.each(["demo", "a", "a".repeat(48), "room-9"])("A5 accepts and keeps room %s", room => {
    const h = bootReady(); const p = mkPort();
    const frame = gen("request", { room });
    post(h, p, frame);
    const sent = h.native.ofType("model_generate");
    expect(sent, "valid room must pass structural validation").toHaveLength(1);
    expect(sent[0]).toEqual({ ...frame, rid: sent[0]?.["rid"] });
    h.native.emit(hResult(sent[0]?.["rid"]));
    expect(frames(p)).toContainEqual({ t: "model_result", v: 1, rid: "request", text: "ok" });
  });
  it.each(["../x", 7, null, "", "A", "-x", "a".repeat(49), "demo\n", [], {}])(
    "A5 rejects malformed room %j without forwarding", room => {
      const h = bootReady(); const p = mkPort();
      post(h, p, gen("request", { room }));
      expect(frames(p)).toEqual([nackOf("request", "bad_request")]);
      expect(h.native.sent).toEqual([]);
    });
  it.each([{}, { room: "demo" }])("A5 unknown extra keys stay rejected %j", room => {
    const h = bootReady(); const p = mkPort();
    post(h, p, gen("request", { ...room, surprise: true }));
    expect(frames(p)).toEqual([nackOf("request", "bad_request")]);
    expect(h.native.sent).toEqual([]);
  });
  it("M1 room remains optional on legacy frames", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("request"));
    expect(h.native.ofType("model_generate")).toHaveLength(1);
    expect(h.native.last()).not.toHaveProperty("room");
    h.native.emit(hResult(h.native.last()["rid"]));
  });
  it("M1 room and schema coexist at rung one", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, gen("request", { room: "demo", rung: 1, schema: { type: "object" } }));
    expect(h.native.ofType("model_generate")).toHaveLength(1);
    expect(h.native.last()).toMatchObject({ room: "demo", rung: 1, schema: { type: "object" } });
    h.native.emit(hResult(h.native.last()["rid"]));
  });
});
