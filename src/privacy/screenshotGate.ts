import type { MultimodalState, ScreenshotGate } from "./types";

export function gateScreenshot(input: {
  multimodal: MultimodalState;
  deviceReady: boolean;
  mimeType?: string;
}): ScreenshotGate {
  if (input === null || typeof input !== "object") {
    return { allow: false, reason: "MULTIMODAL_UNAVAILABLE" };
  }
  const mm = input.multimodal as string;
  if (mm !== "available") {
    return { allow: false, reason: "MULTIMODAL_UNAVAILABLE" };
  }
  if (input.deviceReady !== true) {
    return { allow: false, reason: "DEVICE_NOT_READY" };
  }
  const mt = input.mimeType;
  if (mt !== "image/png" && mt !== "image/jpeg") {
    return { allow: false, reason: "INPUT_REJECTED" };
  }
  return { allow: true, mode: "ONLY_ON_DEVICE" };
}
