// U38 V3: source chip truth. Nano/cloud chips only when a model ran (source + ms > 0); otherwise "Rules" and no latency.
import { afterEach, describe, expect, it } from "vitest";
import { toWallVM } from "../../../src/app/agent_store";
import { mountWall } from "../../../src/views";
import type { WallVM } from "../../../src/views/types";
import { mkState } from "./helpers";

afterEach(() => { document.body.replaceChildren(); });
const base = (): WallVM => toWallVM([mkState({ steps: 2, done: 1 })], new Map(), { nowMs: Date.now(), model: { state: "ready", label: "ready" }, network: "online" });
function chipFor(source: unknown): HTMLElement {
  const vm = base();
  const host = document.createElement("div"); document.body.append(host);
  mountWall(host, { ...vm, tasks: vm.tasks.map((t) => ({ ...t, source } as never)) }, {});
  const chip = host.querySelector<HTMLElement>(".provenance .source");
  if (chip === null) throw new Error("no provenance chip");
  return chip;
}

describe("V3 source chip", () => {
  it("no inference ({device, 0 ms}): 'Rules', no latency, no Gemini wording", () => {
    const c = chipFor({ kind: "device", ms: 0 });
    expect(c.textContent).toContain("Rules");
    expect(c.textContent).not.toMatch(/Gemini|Nano|cloud|on device|\bms\b/);
    expect(c.querySelector(".source-ms")).toBeNull();
  });
  it("no inference ({cloud, 0 ms}) is also Rules", () => {
    const c = chipFor({ kind: "cloud", ms: 0 });
    expect(c.textContent).toContain("Rules");
    expect(c.textContent).not.toMatch(/Gemini|\bms\b/);
  });
  it("an explicit 'rules' source (new SourceKind) renders Rules without latency", () => {
    const c = chipFor({ kind: "rules", ms: 0 });
    expect(c.textContent).toContain("Rules");
    expect(c.textContent).not.toMatch(/Gemini|\bms\b/);
  });
  it("a model really ran on device (ms > 0): 'Gemini Nano · on device' + the latency", () => {
    const c = chipFor({ kind: "device", ms: 142 });
    expect(c.textContent).toContain("Gemini Nano · on device");
    expect(c.textContent).toContain("142 ms");
    expect(c.textContent).not.toContain("Rules");
  });
  it("a model really ran in the cloud (ms > 0): 'Gemini · cloud fallback' + the latency", () => {
    const c = chipFor({ kind: "cloud", ms: 1180 });
    expect(c.textContent).toContain("Gemini · cloud fallback");
    expect(c.textContent).toContain("1180 ms");
  });
  it("agent tasks built from room events (no model involved) never claim a model anywhere in the wall (provenance + step details)", () => {
    const vm = base();
    const host = document.createElement("div"); document.body.append(host);
    mountWall(host, vm, {});
    const chips = [...host.querySelectorAll(".source")];
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) { expect(c.textContent).toContain("Rules"); expect(c.textContent).not.toMatch(/Gemini|\bms\b/); }
  });
});
