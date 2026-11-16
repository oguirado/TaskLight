import { describe, expect, it } from "vitest";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import { createModelServices } from "../../../src/app/model_services";
import { Channel, factory, REMOTE, remoteConfig, store, flush, ORIGIN } from "../u52/wire/fixtures";
import { fakeClock, snapshot, task } from "../u64/helpers";

describe("U80 A7 real plan review to model frame", () => {
  it.each(["demo", "work"])("A7 binds task review and brief to room %s", async room => {
    const ch = new Channel(); const time = fakeClock();
    const rc = remoteConfig({ external_providers_enabled: "true", remote_providers_enabled: "true" });
    const services = createModelServices({ factory: factory().f, origin: ORIGIN,
      clock: time.clock, channel: ch, rc: rc.rc, selectionStore: store({ all: REMOTE.id }).value });
    ch.host([REMOTE], "ok", '{"verdict":"on_track","reason":"Checked","brief":"Continue"}');
    await flush(); await services.registry.refresh(); services.registry.select({ all: REMOTE.id });
    services.registry.applyRemoteConfig({}, { externalEnabled: true, remoteEnabled: true, killSwitchCloud: false });
    const wiring = createPlanWiring({ clock: time.clock, getServices: () => services,
      getDriftFactory: () => null, driftPortFromFactory: () => { throw new Error("unexpected fallback"); },
      adaptDriftPort: port => port, getTier: () => "standard",
      getSnapshots: () => [snapshot([task()], room)], onUpdate: () => undefined });
    try {
      wiring.notifyChange(); await time.advance(); await flush();
      const frames = ch.of("model_generate");
      expect(frames.length, "task review and plan brief must reach the fake model port").toBeGreaterThanOrEqual(2);
      for (const frame of frames) expect(frame).toHaveProperty("room", room);
    } finally { wiring.dispose(); services.dispose(); }
  });
});
