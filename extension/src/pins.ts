import type { PinRegistry } from "./types";
import { SOURCE_LIMITS } from "./types";
/** Pin registry. Tabs are pinned only with a user gesture (D-7(a)); at most `max` (default SOURCE_LIMITS.PINS_MAX). */
export function createPinRegistry(opts?: { max?: number }): PinRegistry {
  const max = opts?.max ?? SOURCE_LIMITS.PINS_MAX;
  const map = new Map<number, string>();
  return {
    pin(tabId: number, projectId: string, gesture: boolean) {
      if (gesture !== true) return { ok: false as const, code: "NO_GESTURE" as const };
      if (map.has(tabId)) {
        map.set(tabId, projectId);
        return { ok: true as const };
      }
      if (map.size >= max) return { ok: false as const, code: "PINS_FULL" as const };
      map.set(tabId, projectId);
      return { ok: true as const };
    },
    unpin(tabId: number): void {
      map.delete(tabId);
    },
    projectOf(tabId: number): string | undefined {
      return map.get(tabId);
    },
  };
}
/** origin + path of an http(s) URL; query, fragment and userinfo dropped. null for any other scheme or unparsable input. */
export function toOriginPath(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.origin + u.pathname;
}
