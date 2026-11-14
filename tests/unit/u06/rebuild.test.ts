import { describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import { makeFake, modeNameOf, OK_ORIGIN, req, TASKS } from "./harness";

vi.mock("../../../src/schema", () => import("./schemaMock"));

const mk = () => {
  const fake = makeFake();
  const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
  return { fake, h };
};

describe("O14 rebuild on applyConfig (B3)", () => {
  it("5 new create calls with the new max_output_tokens; configGen 0 -> 1; later runs use the new handles", async () => {
    const { fake, h } = mk();
    const r0 = await h.run(req("summary"));
    expect(r0.meta.configGen).toBe(0);
    expect(fake.handles).toHaveLength(5);
    const oldSummary = fake.last("summary");
    const res = h.applyConfig({ max_output_tokens: 120 });
    expect(res.configGen).toBe(1);
    expect(res.warnings).toEqual([]);
    expect(fake.handles).toHaveLength(10);
    const fresh = fake.handles.slice(5);
    expect([...fresh.map((x) => x.task)].sort()).toEqual([...TASKS].sort());
    for (const x of fresh) expect(x.params.inCloudParams.generationConfig.maxOutputTokens).toBe(120);
    const r1 = await h.run(req("summary"));
    expect(r1.meta.configGen).toBe(1);
    expect(fake.last("summary")).not.toBe(oldSummary);
    expect(oldSummary.calls).toHaveLength(1); // only the pre-rebuild run
    expect(fake.last("summary").calls).toHaveLength(1);
  });

  it("configGen increments by exactly 1 on every applyConfig, even an empty one", () => {
    const { fake, h } = mk();
    expect(h.applyConfig({}).configGen).toBe(1);
    expect(h.applyConfig({ model_name: "m2" }).configGen).toBe(2);
    expect(h.applyConfig({ model_name: "m2" }).configGen).toBe(3);
    expect(fake.handles).toHaveLength(20);
  });

  it("applyConfig merges onto the current config (a partial does not reset earlier keys)", () => {
    const { fake, h } = mk();
    h.applyConfig({ mode_digest: "ONLY_IN_CLOUD" });
    h.applyConfig({ max_output_tokens: 150 });
    const p = fake.last("digest").params;
    expect(modeNameOf(p)).toBe("ONLY_IN_CLOUD");
    expect(p.inCloudParams.generationConfig.maxOutputTokens).toBe(150);
  });

  it("new instances keep schema reference parity (constraint === schema) after a rebuild", () => {
    const { fake, h } = mk();
    h.applyConfig({ model_name: "other" });
    expect(fake.handles).toHaveLength(10);
    for (const hd of fake.handles.slice(5)) {
      expect(hd.params.onDeviceParams.promptOptions.responseConstraint).toBe(hd.params.inCloudParams.generationConfig.responseSchema);
      expect(hd.params.inCloudParams.model).toBe("other");
    }
  });

  it("invalid keys warn by name and still rebuild with defaults", () => {
    const { fake, h } = mk();
    const r = h.applyConfig({ mode_digest: "weird" as never, max_output_tokens: "x" as never });
    expect(r.warnings.join("|")).toContain("mode_digest");
    expect(r.warnings.join("|")).toContain("max_output_tokens");
    expect(r.configGen).toBe(1);
    const p = fake.last("digest").params;
    expect(modeNameOf(p)).toBe("PREFER_IN_CLOUD");
    expect(p.inCloudParams.generationConfig.maxOutputTokens).toBe(200);
  });

  it("kill switch flipped by applyConfig re-pins every model to ONLY_ON_DEVICE", () => {
    const { fake, h } = mk();
    h.applyConfig({ kill_switch_cloud: true });
    for (const t of TASKS) expect(modeNameOf(fake.last(t).params), t).toBe("ONLY_ON_DEVICE");
  });
});
