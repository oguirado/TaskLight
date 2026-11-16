// U38 V2: the progress fill reflects done/total; a task with no steps shows no fill; the track keeps its token colour in the hosted cascade.
import { afterEach, describe, expect, it } from "vitest";
import { toWallVM } from "../../../src/app/agent_store";
import { mountWall } from "../../../src/views";
import { hostedRules, mkState, winning } from "./helpers";

afterEach(() => { document.body.replaceChildren(); });
function mountFor(steps: number, done: number) {
  const vm = toWallVM([mkState({ steps, done })], new Map(), { nowMs: Date.now(), model: { state: "unavailable", label: "x" }, network: "online" });
  const host = document.createElement("div"); document.body.append(host);
  mountWall(host, vm, {});
  return host;
}
const fill = (h: HTMLElement) => h.querySelector<HTMLElement>(".progress-fill");
const track = (h: HTMLElement) => h.querySelector<HTMLElement>(".progress-track");

describe("V2 progress bar", () => {
  it("0 of 3 done: label '0 of 3 steps', aria-valuenow 0, fill --p equals 0%", () => {
    const h = mountFor(3, 0);
    expect(h.querySelector(".progress-label")?.textContent).toBe("0 of 3 steps");
    expect(track(h)?.getAttribute("aria-valuenow")).toBe("0");
    expect(fill(h)?.style.getPropertyValue("--p")).toBe("0%");
  });
  it("1 of 3 -> 33%, 3 of 3 -> 100%", () => {
    expect(fill(mountFor(3, 1))?.style.getPropertyValue("--p")).toBe("33%");
    expect(fill(mountFor(3, 3))?.style.getPropertyValue("--p")).toBe("100%");
  });
  it("a task with no steps renders no fill element at all (no bar fill)", () => {
    const h = mountFor(0, 0);
    expect(h.querySelector(".task")).not.toBeNull();
    expect(fill(h)).toBeNull();
  });
  it("hosted cascade: the progress track keeps the token track colour (wall.css [role=progressbar] must not paint it)", () => {
    const sheets = hostedRules();
    expect(sheets.length, "no hosted stylesheets (G4)").toBeGreaterThanOrEqual(4); // A-U52c: U52 adds model_selector.css, U64 adds plan.css
    const h = mountFor(3, 0);
    const bg = winning(track(h) as HTMLElement, "background-color", sheets);
    expect(bg).toBeDefined();
    expect(bg).toContain("--c-progress-track");
    expect(bg).not.toContain("--color-ok");
  });
});
