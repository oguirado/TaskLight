import type { FirebaseApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource,
  type SchemaRequest } from "firebase/ai";
import type { ModelFactory, ModelHandle, ModeName } from "./types";

export function firebaseFactory(app: FirebaseApp): ModelFactory {
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  return {
    modeConst: (m: ModeName): unknown => {
      switch (m) {
        case "PREFER_ON_DEVICE": return InferenceMode.PREFER_ON_DEVICE;
        case "ONLY_ON_DEVICE": return InferenceMode.ONLY_ON_DEVICE;
        case "PREFER_IN_CLOUD": return InferenceMode.PREFER_IN_CLOUD;
        case "ONLY_IN_CLOUD": return InferenceMode.ONLY_IN_CLOUD;
      }
    },
    sourceConst: { ON_DEVICE: InferenceSource.ON_DEVICE, IN_CLOUD: InferenceSource.IN_CLOUD },
    create(params): ModelHandle {
      const model = getGenerativeModel(ai, {
        mode: params.mode as InferenceMode,
        inCloudParams: {
          model: params.inCloudParams.model,
          generationConfig: {
            responseMimeType: params.inCloudParams.generationConfig.responseMimeType,
            responseSchema: params.inCloudParams.generationConfig.responseSchema as SchemaRequest,
            maxOutputTokens: params.inCloudParams.generationConfig.maxOutputTokens,
          },
        },
        onDeviceParams: {
          promptOptions: {
            responseConstraint: params.onDeviceParams.promptOptions.responseConstraint,
          },
        },
      });
      return {
        generateContent: (req) => model.generateContent(typeof req === "string" ? req
          : req.map((x) => (typeof x === "string" ? x : { type: "inlineData" as const, inlineData: x.inlineData }))),
        initializeDeviceModel: (p) => model.initializeDeviceModel(p),
      };
    },
  };
}
