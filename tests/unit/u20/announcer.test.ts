import { describe, it, expect, beforeEach } from "vitest";
import { createAnnouncer } from "../../../src/ui/announcer";
import { UI_LIMITS } from "../../../src/ui/limits";
import { FakeClock } from "./helpers";

let region: HTMLElement; let clock: FakeClock;
beforeEach(() => { document.body.replaceChildren(); region = document.createElement("div"); document.body.appendChild(region); clock = new FakeClock(); });

describe("U20 limits [TARGET-spec]", () => {
  it("constants", () => {
    expect(UI_LIMITS).toEqual({ LIVE_MIN_INTERVAL_MS: 5000, LIVE_MAX_CHARS: 160, LIVE_QUEUE_MAX: 12, PROGRESS_ANNOUNCE_STEP: 25, GRID_COLUMNS_MAX: 4 });
  });
});

describe("U20 announcer (B14, B15)", () => {
  it("region is a live region (polite by default, atomic)", () => {
    createAnnouncer(region, clock);
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });
  it("O10 control: one update flushes exactly once", () => {
    const a = createAnnouncer(region, clock);
    a.say("p1", "hello", "polite");
    expect(a.flushedCount()).toBe(1);
    expect(region.textContent).toBe("hello");
    clock.advance(10000);
    expect(a.flushedCount()).toBe(1);
  });
  it("O10 throttle: 20 updates inside 1000 ms -> <=1 flush; latest text after the interval", () => {
    const a = createAnnouncer(region, clock);
    for (let i = 1; i <= 20; i++) { a.say("p1", `t${i}`, "polite"); clock.advance(50); }
    expect(a.flushedCount()).toBeLessThanOrEqual(1);
    clock.advance(5000);
    expect(a.flushedCount()).toBe(2);
    expect(region.textContent).toBe("t20");
  });
  it("never more than 1 flush in any 1 s window (<=1 announcement/s)", () => {
    const a = createAnnouncer(region, clock);
    const counts: number[] = [];
    for (let i = 0; i < 100; i++) { a.say(`k${i % 3}`, `x${i}`, "polite"); clock.advance(100); counts.push(a.flushedCount()); }
    for (let i = 10; i < counts.length; i++) expect(counts[i]! - counts[i - 10]!).toBeLessThanOrEqual(1);
    expect(counts.at(-1)!).toBeGreaterThan(1);
  });
  it("identical consecutive text suppressed", () => {
    const a = createAnnouncer(region, clock);
    a.say("p1", "same", "polite"); clock.advance(6000);
    a.say("p1", "same", "polite"); clock.advance(6000);
    expect(a.flushedCount()).toBe(1);
    a.say("p1", "other", "polite");
    expect(a.flushedCount()).toBe(2);
  });
  it("text truncated to LIVE_MAX_CHARS", () => {
    const a = createAnnouncer(region, clock);
    a.say("p1", "a".repeat(500), "polite");
    expect(region.textContent!.length).toBeLessThanOrEqual(160);
    expect(region.textContent!.length).toBeGreaterThan(0);
  });
  it("O11 politeness is reflected on the region at flush", () => {
    const a = createAnnouncer(region, clock);
    a.say("p1", "low change", "polite");
    expect(region.getAttribute("aria-live")).toBe("polite");
    clock.advance(6000);
    a.say("p1", "now!", "assertive");
    expect(region.getAttribute("aria-live")).toBe("assertive");
    expect(region.textContent).toBe("now!");
  });
  it("O14 queue bound: 14 distinct keys in one window; oldest queued key dropped, FIFO flush", () => {
    const a = createAnnouncer(region, clock);
    for (let i = 1; i <= 14; i++) a.say(`k${i}`, `t${i}`, "polite");
    const seen = [region.textContent];
    for (let i = 0; i < 14; i++) { clock.advance(5000); seen.push(region.textContent); }
    const distinct = [...new Set(seen)];
    expect(distinct).toEqual(["t1", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13", "t14"]);
    expect(distinct).not.toContain("t2");
    expect(a.flushedCount()).toBe(13);
  });
  it("latest text wins per key inside the queue", () => {
    const a = createAnnouncer(region, clock);
    a.say("p0", "first", "polite");
    a.say("p1", "v1", "polite"); a.say("p1", "v2", "polite");
    clock.advance(5000);
    expect(region.textContent).toBe("v2");
    expect(a.flushedCount()).toBe(2);
  });
  it("uses textContent only (hostile text stays literal)", () => {
    const a = createAnnouncer(region, clock);
    a.say("p1", "<img src=x onerror=alert(1)>", "polite");
    expect(region.querySelectorAll("img")).toHaveLength(0);
    expect(region.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
