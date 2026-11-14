import type { WallInputs, WallMode, WallView } from "./types";

/** Fixed banner text per mode (B8). `blocked` appends the reason verbatim at render time. */
export const BANNER_TEXT: Readonly<Record<WallMode, string>> = {
  booting: "Starting the wall",
  blocked: "Wall blocked",
  offline: "You are offline",
  kill_switch: "Cloud disabled",
  no_model: "No on-device model yet",
  needs_gesture: "Activate the on-device model",
  downloading: "Downloading the on-device model",
  cloud_fallback: "Running in the cloud",
  on_device: "Running on this device",
};

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function progressOf(i: WallInputs, mode: WallMode): number | null {
  if (mode !== "downloading") return null;
  if (i.device.state === "downloading") return clamp01(i.device.progress);
  return null;
}

export function resolveWallMode(i: WallInputs): WallView {
  let mode: WallMode;
  if (i.host.kind === "booting") mode = "booting";
  else if (i.host.kind === "blocked") mode = "blocked";
  else if (!i.online) mode = "offline";
  else if (i.killSwitchCloud) mode = "kill_switch";
  else if (i.device.state === "downloading") mode = "downloading";
  else if (i.device.state === "needs_gesture") mode = "needs_gesture";
  else if (
    i.device.state === "not_initialised" ||
    i.device.state === "failed" ||
    i.availability === "unavailable"
  ) mode = "no_model";
  else if (i.lastRun?.fallback === true) mode = "cloud_fallback";
  else mode = "on_device";

  const p = progressOf(i, mode);
  const progressPct = p === null ? null : Math.round(p * 100);
  const showEnableCta =
    (i.device.state === "not_initialised" || i.device.state === "needs_gesture") &&
    i.availability !== "unavailable" &&
    i.host.kind === "ready";
  const privateAvailable = i.device.state === "ready";
  return { mode, progressPct, showEnableCta, privateAvailable };
}
