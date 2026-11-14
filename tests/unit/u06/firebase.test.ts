import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirebaseApp } from "firebase/app";

const sdk = vi.hoisted(() => ({
  getAI: vi.fn(() => ({ ai: true })),
  getGenerativeModel: vi.fn(),
}));
vi.mock("firebase/ai", async (orig) => {
  const real = await orig<typeof import("firebase/ai")>();
  return { ...real, getAI: sdk.getAI, getGenerativeModel: sdk.getGenerativeModel };
});
vi.mock("../../../src/schema", () => import("./schemaMock"));

import { GoogleAIBackend, InferenceMode, InferenceSource } from "firebase/ai";
import { firebaseFactory } from "../../../src/ai/firebase";
import type { HybridParamsShape } from "../../../src/ai/types";
import { TASK_SCHEMAS } from "./schemaMock";

const app = { name: "[DEFAULT]" } as unknown as FirebaseApp;
const params = (mode: unknown): HybridParamsShape => ({
  mode,
  inCloudParams: { model: "gemini-3.5-flash-lite", generationConfig: {
    responseMimeType: "application/json", responseSchema: TASK_SCHEMAS["summary"]!.schema, maxOutputTokens: 200 } },
  onDeviceParams: { promptOptions: { responseConstraint: TASK_SCHEMAS["summary"]!.schema } },
});
let fakeModel: { generateContent: ReturnType<typeof vi.fn>; initializeDeviceModel: ReturnType<typeof vi.fn> };
beforeEach(() => {
  sdk.getAI.mockClear(); sdk.getGenerativeModel.mockReset();
  fakeModel = { generateContent: vi.fn(async () => ({ response: { text: () => "x" } })), initializeDeviceModel: vi.fn(async () => undefined) };
  sdk.getGenerativeModel.mockReturnValue(fakeModel);
});

describe("firebaseFactory (B2) against a mocked firebase/ai", () => {
  it("modeConst returns the SDK InferenceMode constant for every name (SDK values are lowercase strings)", () => {
    const f = firebaseFactory(app);
    expect(f.modeConst("PREFER_ON_DEVICE")).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(f.modeConst("ONLY_ON_DEVICE")).toBe(InferenceMode.ONLY_ON_DEVICE);
    expect(f.modeConst("PREFER_IN_CLOUD")).toBe(InferenceMode.PREFER_IN_CLOUD);
    expect(f.modeConst("ONLY_IN_CLOUD")).toBe(InferenceMode.ONLY_IN_CLOUD);
  });
  it("sourceConst is the SDK InferenceSource constants", () => {
    const f = firebaseFactory(app);
    expect(f.sourceConst.ON_DEVICE).toBe(InferenceSource.ON_DEVICE);
    expect(f.sourceConst.IN_CLOUD).toBe(InferenceSource.IN_CLOUD);
  });
  it("getAI is called exactly once (app + GoogleAIBackend, no useLimitedUseAppCheckTokens), however many models are created", () => {
    const f = firebaseFactory(app);
    f.create(params(InferenceMode.PREFER_ON_DEVICE)); f.create(params(InferenceMode.ONLY_ON_DEVICE)); f.create(params(InferenceMode.ONLY_IN_CLOUD));
    expect(sdk.getAI).toHaveBeenCalledTimes(1);
    const call = sdk.getAI.mock.calls[0] as unknown as [unknown, { backend: unknown } & Record<string, unknown>];
    expect(call[0]).toBe(app);
    expect(call[1].backend).toBeInstanceOf(GoogleAIBackend);
    expect(call[1]).not.toHaveProperty("useLimitedUseAppCheckTokens");
  });
  it("getGenerativeModel is called once per create with the hybrid params shape (mode, inCloudParams, onDeviceParams) passed through", () => {
    const f = firebaseFactory(app);
    f.create(params(InferenceMode.PREFER_ON_DEVICE)); f.create(params(InferenceMode.PREFER_IN_CLOUD));
    expect(sdk.getGenerativeModel).toHaveBeenCalledTimes(2);
    const [ai, p] = sdk.getGenerativeModel.mock.calls[0] as unknown as [unknown, Record<string, any>];
    expect(ai).toEqual({ ai: true });
    expect(p["mode"]).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(p["inCloudParams"].model).toBe("gemini-3.5-flash-lite");
    expect(p["inCloudParams"].generationConfig.responseMimeType).toBe("application/json");
    expect(p["inCloudParams"].generationConfig.maxOutputTokens).toBe(200);
    expect(p["inCloudParams"].generationConfig.responseSchema).toBe(TASK_SCHEMAS["summary"]!.schema);
    expect(p["onDeviceParams"].promptOptions.responseConstraint).toBe(TASK_SCHEMAS["summary"]!.schema);
    expect(Object.keys(p).sort()).toEqual(["inCloudParams", "mode", "onDeviceParams"]);
  });
  it("handle delegates generateContent (string and parts) and initializeDeviceModel (callback passed through)", async () => {
    const f = firebaseFactory(app);
    const h = f.create(params(InferenceMode.PREFER_ON_DEVICE));
    await h.generateContent("hi");
    expect(fakeModel.generateContent).toHaveBeenCalledWith("hi");
    await h.generateContent(["look", { inlineData: { data: "QQ==", mimeType: "image/png" } }]);
    const sent = fakeModel.generateContent.mock.calls[1]![0] as unknown[];
    expect(sent[0]).toBe("look");
    expect(sent[1]).toMatchObject({ inlineData: { data: "QQ==", mimeType: "image/png" } });
    const cb = vi.fn();
    await h.initializeDeviceModel(cb);
    expect(fakeModel.initializeDeviceModel).toHaveBeenCalledWith(cb);
  });
  it("never calls initializeDeviceModel or generateContent by itself", () => {
    const f = firebaseFactory(app);
    f.create(params(InferenceMode.PREFER_ON_DEVICE));
    expect(fakeModel.initializeDeviceModel).not.toHaveBeenCalled();
    expect(fakeModel.generateContent).not.toHaveBeenCalled();
  });
});
