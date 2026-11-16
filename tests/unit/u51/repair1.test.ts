// U51 repair loop 1: callback containment (finding 1) and model trigger identity (finding 2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelSheet } from "../../../src/ui/model_selector";
import type { ModelSheetIntent } from "../../../src/ui/model_selector";
import type { Announcer } from "../../../src/ui/types";
import { mountWall } from "../../../src/views";
import { toWallVM } from "../../../src/app/agent_store";
import type { WallVM } from "../../../src/views/types";
import { mkState } from "../u38/helpers";
import { FakeAnnouncer, buttonByText, cleanup, rowByText, radioOf, snap } from "./helpers";

afterEach(() => cleanup());

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function mk(onIntent: (i: ModelSheetIntent) => unknown, announcer: Announcer = new FakeAnnouncer()) {
  const mount = document.createElement("div");
  const trigger = document.createElement("button"); trigger.type = "button";
  document.body.append(trigger, mount);
  const sheet = createModelSheet({ doc: document, mount, announcer, onIntent: onIntent as (i: ModelSheetIntent) => void });
  sheet.render(snap());
  const el = () => mount.querySelector<HTMLElement>("#model-sheet") as HTMLElement;
  return { mount, trigger, sheet, el };
}

/** Collects unhandled rejections (process) and listener errors reported by jsdom (window "error"). */
async function withRejections(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const h = (e: unknown): void => { seen.push(e); };
  const w = (e: ErrorEvent): void => { seen.push(e.error); e.preventDefault(); };
  process.on("unhandledRejection", h);
  window.addEventListener("error", w);
  try { await fn(); await settle(); } finally { process.off("unhandledRejection", h); window.removeEventListener("error", w); }
  return seen;
}

describe("R1 onIntent containment", () => {
  const throwing = () => { throw new Error("boom-sync"); };
  const rejecting = async () => { throw new Error("boom-async"); };

  for (const [name, cb] of [["throwing", throwing], ["rejecting", rejecting]] as const) {
    it(`${name} onIntent: open() does not escape and state is consistent`, async () => {
      const seen = await withRejections(async () => {
        const r = mk(cb);
        expect(() => r.sheet.open(r.trigger)).not.toThrow();
        expect(r.trigger.getAttribute("aria-expanded")).toBe("true");
        expect(r.el().getAttribute("data-open")).toBe("true");
      });
      expect(seen).toEqual([]);
    });
    it(`${name} onIntent: select via radio does not escape`, async () => {
      const seen = await withRejections(async () => {
        const r = mk(cb);
        r.sheet.open(r.trigger);
        const radio = radioOf(rowByText({ el: r.el } as never, "Studio box"));
        expect(() => radio.click()).not.toThrow();
      });
      expect(seen).toEqual([]);
    });
    it(`${name} onIntent: reset does not escape`, async () => {
      const seen = await withRejections(async () => {
        const r = mk(cb);
        r.sheet.open(r.trigger);
        expect(() => buttonByText({ el: r.el } as never, "Reset to Firebase hybrid").click()).not.toThrow();
      });
      expect(seen).toEqual([]);
    });
  }
});

describe("R1 announcer containment", () => {
  it("throwing announcer.say on open: open() does not throw and refresh is still emitted", () => {
    const intents: ModelSheetIntent[] = [];
    const ann: Announcer = { say: () => { throw new Error("say-boom"); }, flushedCount: () => 0 };
    const r = mk((i) => { intents.push(i); }, ann);
    expect(() => r.sheet.open(r.trigger)).not.toThrow();
    expect(intents).toContainEqual({ t: "refresh" });
    expect(r.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(r.el().getAttribute("data-open")).toBe("true");
  });
});

describe("R1 model trigger independent of sanitized state", () => {
  const vm = (state: string): WallVM =>
    toWallVM([mkState({ steps: 2, done: 1 })], new Map(), { nowMs: Date.now(), model: { state, label: "Model" } as never, network: "online" });
  for (const state of ["needs_gesture", "unknown-state", ""]) {
    it(`state ${JSON.stringify(state)}: click calls onOpenModels`, () => {
      const host = document.createElement("div"); document.body.append(host);
      const spy = vi.fn();
      mountWall(host, vm(state), { onOpenModels: spy });
      const btn = host.querySelector<HTMLButtonElement>('button[aria-controls="model-sheet"]');
      expect(btn).not.toBeNull();
      btn!.click();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(btn);
      const net = host.querySelector<HTMLElement>("[data-network]");
      expect(net?.tagName).toBe("DIV");
      net?.click();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  }
});
