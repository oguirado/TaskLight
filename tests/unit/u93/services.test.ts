import { describe, expect, it, vi } from "vitest";
import type { LiaisonProviderPort } from "../../../src/app/liaison";
import { Channel, services } from "../u52/wire/fixtures";
import { ALL_ON, LOCAL, OUTPUT, REMOTE, boot, expectSuccess, input } from "./helpers";

describe("U93 public model-services composition", () => {
  it("A1/M2 public registry preserves independent liaison and drift selections", async () => {
    const channel = new Channel(); const w = services({ channel }, JSON.stringify(OUTPUT));
    try {
      channel.host([REMOTE, LOCAL], "ok", JSON.stringify(OUTPUT));
      await w.service.registry.refresh();
      w.service.registry.applyRemoteConfig({}, ALL_ON);
      const registry = w.service.registry as unknown as LiaisonProviderPort;
      const c = boot({ registry, storage: { setItem: vi.fn() } });
      const selection = { groups: { liaison: REMOTE.id, drift: LOCAL.id } };
      w.service.sheet().select(selection);
      expect(w.service.sheet().selection()).toMatchObject(selection);
      expect(registry.resolve("liaison", "standard").primary).toBe(REMOTE.id);
      expect(w.service.registry.resolve("drift", "standard").primary).toBe(LOCAL.id);
      expectSuccess(await c.generate(input()));
      expect(channel.of("model_generate")).toHaveLength(1);
      expect(channel.of("model_generate")[0]).toMatchObject({ id: REMOTE.id, room: "demo", tier: "standard" });
    } finally { w.service.dispose(); }
  });

  it("A1/M2 composed Firebase text passes the same closed-output schema to both model channels", async () => {
    const w = services({}, JSON.stringify(OUTPUT));
    try {
      const c = boot({ registry: w.service.registry as unknown as LiaisonProviderPort, storage: { setItem: vi.fn() } });
      expectSuccess(await c.generate(input()));
      const params = w.sdk.calls.at(-1)!;
      expect(params.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
      const schema = params.inCloudParams.generationConfig.responseSchema;
      expect(params.onDeviceParams.promptOptions.responseConstraint).toEqual(schema);
      for (const key of ["kind", "text", "refs"]) expect(JSON.stringify(schema)).toContain(key);
      expect(w.sdk.prompts).toHaveLength(1);
    } finally { w.service.dispose(); }
  });
});
