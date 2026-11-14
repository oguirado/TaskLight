import { describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import { AI_DEFAULTS } from "../../../src/ai/types";
import { makeFake, modeNameOf, OK_ORIGIN, TASKS } from "./harness";
import { TASK_SCHEMAS } from "./schemaMock";

vi.mock("../../../src/schema", () => import("./schemaMock"));

const build = (config?: Parameters<typeof createHybrid>[0]["config"]) => {
  const fake = makeFake();
  const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true, ...(config ? { config } : {}) });
  return { fake, h };
};

describe("U06 params (O1, O2, B3, B4)", () => {
  it("O1 summary params: constraint === schema === TASK_SCHEMAS.summary.schema, json mime, 200 tokens, explicit model", () => {
    const { fake } = build();
    const p = fake.last("summary").params;
    const schema = TASK_SCHEMAS["summary"]!.schema;
    expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(schema);
    expect(p.inCloudParams.generationConfig.responseSchema).toBe(schema);
    expect(p.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
    expect(p.inCloudParams.generationConfig.maxOutputTokens).toBe(200);
    expect(p.inCloudParams.model).toBe("gemini-3.5-flash-lite");
  });

  it("O1 positive control of the oracle: responseConstraint must be present for every task (red if absent)", () => {
    const { fake } = build();
    for (const t of TASKS) {
      const c = fake.last(t).params.onDeviceParams?.promptOptions?.responseConstraint;
      expect(c, `${t} responseConstraint`).toBeTypeOf("object");
      expect(c).not.toBeNull();
    }
  });

  it("O2 status params use text/x.enum with the same schema reference", () => {
    const { fake } = build();
    const p = fake.last("status").params;
    expect(p.inCloudParams.generationConfig.responseMimeType).toBe("text/x.enum");
    expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(TASK_SCHEMAS["status"]!.schema);
    expect(p.inCloudParams.generationConfig.responseSchema).toBe(TASK_SCHEMAS["status"]!.schema);
  });

  it("B3 builds exactly one instance per TaskId at creation, none before", () => {
    const fake = makeFake();
    expect(fake.handles).toHaveLength(0);
    createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    expect(fake.handles).toHaveLength(5);
    expect([...fake.handles.map((h) => h.task)].sort()).toEqual([...TASKS].sort());
  });

  it("B4 every task: same reference both sides, mime from TASK_SCHEMAS, tokens from config, model explicit", () => {
    const { fake } = build({ max_output_tokens: 77, model_name: "custom-model-x" });
    for (const t of TASKS) {
      const p = fake.last(t).params;
      expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(p.inCloudParams.generationConfig.responseSchema);
      expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(TASK_SCHEMAS[t]!.schema);
      expect(p.inCloudParams.generationConfig.responseMimeType).toBe(TASK_SCHEMAS[t]!.mimeType);
      expect(p.inCloudParams.generationConfig.maxOutputTokens).toBe(77);
      expect(p.inCloudParams.model).toBe("custom-model-x");
    }
  });

  it("B4 params carry only mode/inCloudParams/onDeviceParams at top level (the SDK warns and ignores others)", () => {
    const { fake } = build();
    expect(fake.handles).toHaveLength(5);
    for (const h of fake.handles) expect(Object.keys(h.params).sort()).toEqual(["inCloudParams", "mode", "onDeviceParams"]);
  });

  it("B4 on-device params carry no cloud-only knobs and cloud generationConfig is exactly mime+schema+tokens", () => {
    const { fake } = build();
    const p = fake.last("digest").params;
    expect(Object.keys(p.onDeviceParams.promptOptions)).toEqual(["responseConstraint"]);
    expect(Object.keys(p.inCloudParams.generationConfig).sort()).toEqual(["maxOutputTokens", "responseMimeType", "responseSchema"]);
  });

  it("params mode is the factory's modeConst of the resolved config mode, per task (defaults, B6)", () => {
    const { fake } = build();
    expect(modeNameOf(fake.last("status").params)).toBe("PREFER_ON_DEVICE");
    expect(modeNameOf(fake.last("summary").params)).toBe("PREFER_ON_DEVICE");
    expect(modeNameOf(fake.last("next_action").params)).toBe("PREFER_ON_DEVICE");
    expect(modeNameOf(fake.last("screenshot").params)).toBe("ONLY_ON_DEVICE");
    expect(modeNameOf(fake.last("digest").params)).toBe("PREFER_IN_CLOUD");
  });

  it("O6 Remote Config mode keys drive params mode; invalid falls back to default with a warning naming the key", () => {
    const { fake, h } = build({ mode_status: "ONLY_IN_CLOUD" });
    expect(modeNameOf(fake.last("status").params)).toBe("ONLY_IN_CLOUD");
    const r = h.applyConfig({ mode_status: "bogus" as never });
    expect(modeNameOf(fake.last("status").params)).toBe("PREFER_ON_DEVICE");
    expect(r.warnings.join(" ")).toContain("mode_status");
  });

  it("AI_DEFAULTS values (spec section 2)", () => {
    expect(AI_DEFAULTS).toEqual({
      mode_status: "PREFER_ON_DEVICE", mode_summary: "PREFER_ON_DEVICE", mode_next_action: "PREFER_ON_DEVICE",
      mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD", max_output_tokens: 200,
      ondevice_max_input_tokens: 7300, prompt_version: "v1", model_name: "gemini-3.5-flash-lite", kill_switch_cloud: false,
    });
  });
});
