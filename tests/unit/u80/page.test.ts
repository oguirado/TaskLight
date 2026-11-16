import { describe, expect, it } from "vitest";
import { createPageModelTransport } from "../../../src/app/model_port";
import { Channel, FakeClock, signal, settled } from "../u52/wire/fixtures";
import { REM, LOCP, world, schemaFor } from "../u47/fixtures";

describe("U80 page and provider propagation", () => {
  it.each([1, 2, 3] as const)("A6 model_port carries room at rung %s", async rung => {
    const ch = new Channel(); const tr = createPageModelTransport(ch, new FakeClock());
    ch.hello();
    // Structural extension of the existing request keeps this fail-first test type-safe.
    const req = { id: "fixture", rung, tier: "standard" as const, room: "demo",
      messages: [{ role: "user" as const, content: "Fixture" }], maxTokens: 32,
      schema: { type: "object" }, signal: signal() };
    const pending = tr.generate(req);
    const frame = ch.of("model_generate")[0];
    tr.dispose(); await settled(pending);
    expect(frame).toHaveProperty("room", "demo");
  });
  it("A6 no room means no room key", async () => {
    const ch = new Channel(); const tr = createPageModelTransport(ch, new FakeClock()); ch.hello();
    const pending = tr.generate({ id: "fixture", rung: 2, tier: "standard", messages: [
      { role: "user", content: "Fixture" }], maxTokens: 32, signal: signal() });
    const frame = ch.of("model_generate")[0]; tr.dispose(); await settled(pending);
    expect(frame).toBeDefined(); expect(frame).not.toHaveProperty("room");
  });
  it("M6 registry carries known room into external transport", async () => {
    const w = await world({ endpoints: [REM], selection: { all: REM.id } });
    const req = { task: "summary" as const, tier: "standard" as const, prompt: "Fixture",
      schema: schemaFor("summary"), signal: signal(), room: "demo" };
    await settled(w.reg.generate(req));
    expect(w.tr.genCalls).toHaveLength(1);
    expect(w.tr.genCalls[0]).toHaveProperty("room", "demo");
  });
  it("M6 registry preserves absence of room", async () => {
    const w = await world({ endpoints: [REM], selection: { all: REM.id } });
    await settled(w.call("summary", "standard"));
    expect(w.tr.genCalls).toHaveLength(1); expect(w.tr.genCalls[0]).not.toHaveProperty("room");
  });
  it.each([REM, LOCP])("M3 screenshot still never reaches external transport $id", async endpoint => {
    const w = await world({ endpoints: [endpoint], selection: { all: endpoint.id } });
    const req = { task: "screenshot" as const, tier: "standard" as const, prompt: "Fixture",
      schema: schemaFor("screenshot"), signal: signal(), room: "work" };
    await settled(w.reg.generate(req));
    expect(w.tr.genCalls).toEqual([]);
  });
});
