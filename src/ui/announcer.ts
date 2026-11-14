import type { Announcer, Clock, Politeness } from "./types";
import { UI_LIMITS } from "./limits";

interface Queued {
  key: string;
  text: string;
  politeness: Politeness;
}

function truncate(s: string): string {
  return s.length > UI_LIMITS.LIVE_MAX_CHARS ? s.slice(0, UI_LIMITS.LIVE_MAX_CHARS) : s;
}

export function createAnnouncer(region: HTMLElement, clock: Clock): Announcer & { dispose: () => void } {
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");

  let count = 0;
  let lastFlushMs: number | null = null;
  let lastFlushedText = "";
  let hasFlushed = false;
  let timer: (() => void) | null = null;
  let disposed = false;
  const queue: Queued[] = [];

  function flushNow(): void {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      if (hasFlushed && item.text === lastFlushedText) continue;
      region.setAttribute("aria-live", item.politeness);
      region.textContent = item.text;
      count += 1;
      lastFlushMs = clock.nowMs();
      lastFlushedText = item.text;
      hasFlushed = true;
      break;
    }
    if (queue.length > 0) scheduleNext();
  }

  function scheduleNext(): void {
    if (timer !== null) return;
    if (queue.length === 0) return;
    const earliest = (lastFlushMs ?? clock.nowMs()) + UI_LIMITS.LIVE_MIN_INTERVAL_MS;
    const delay = Math.max(0, earliest - clock.nowMs());
    timer = clock.setTimer(delay, () => {
      timer = null;
      flushNow();
    });
  }

  function say(key: string, text: string, p: Politeness): void {
    if (disposed) return;
    const t = truncate(text);
    if (t === "") return;
    const existing = queue.find((q) => q.key === key);
    if (existing !== undefined) {
      existing.text = t;
      existing.politeness = p;
    } else {
      if (hasFlushed && t === lastFlushedText && queue.length === 0) return;
      queue.push({ key, text: t, politeness: p });
      while (queue.length > UI_LIMITS.LIVE_QUEUE_MAX) queue.shift();
    }
    if (lastFlushMs === null || clock.nowMs() >= lastFlushMs + UI_LIMITS.LIVE_MIN_INTERVAL_MS) {
      if (timer !== null) {
        timer();
        timer = null;
      }
      flushNow();
    } else {
      scheduleNext();
    }
  }

  function dispose(): void {
    disposed = true;
    if (timer !== null) {
      timer();
      timer = null;
    }
    queue.length = 0;
  }

  return { say, flushedCount: () => count, dispose };
}
