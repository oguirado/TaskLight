import type { DeviceAvailability } from "./types";

/** Bound for the availability probe; a pending LanguageModel.availability() resolves as unknown. */
const PROBE_TIMEOUT_MS = 10_000;

export async function probeAvailability(): Promise<DeviceAvailability> {
  const g = globalThis as Record<string, unknown>;
  const lm = g["LanguageModel"];
  if (lm === null || lm === undefined) return "unavailable";
  try {
    const rec = lm as { availability?: unknown };
    if (typeof rec.availability !== "function") return "unknown";
    const fn = rec.availability as () => Promise<unknown>;
    const v = await new Promise<unknown>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("availability probe timed out"));
      }, PROBE_TIMEOUT_MS);
      void fn.call(rec).then(
        (r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    if (v === "available" || v === "downloadable" || v === "unavailable") return v;
    return "unknown";
  } catch {
    return "unknown";
  }
}
