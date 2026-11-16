// U51 repair loop 2: onOpenModels containment (B1) and cross-document element checks (B2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelSheet } from "../../../src/ui/model_selector";
import type { ModelSheetIntent } from "../../../src/ui/model_selector";
import { mountWall } from "../../../src/views";
import { toWallVM } from "../../../src/app/agent_store";
import type { WallVM } from "../../../src/views/types";
import { mkState } from "../u38/helpers";
import { FakeAnnouncer, cleanup, rowByText, radioOf, snap } from "./helpers";

const frames: HTMLIFrameElement[] = [];
afterEach(() => { cleanup(); for (const f of frames.splice(0)) f.remove(); });

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const vm = (): WallVM =>
  toWallVM([mkState({ steps: 2, done: 1 })], new Map(), { nowMs: Date.now(), model: { state: "ready", label: "Model" } as never, network: "online" });

function frameDoc(): Document {
  const f = document.createElement("iframe");
  document.body.append(f); frames.push(f);
  const d = f.contentDocument as Document;
  expect(d).not.toBeNull();
  expect(d).not.toBe(document);
  return d;
}

async function withEscapes(wins: Window[], fn: () => Promise<void> | void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const h = (e: unknown): void => { seen.push(e); };
  const w = (e: ErrorEvent): void => { seen.push(e.error); e.preventDefault(); };
  process.on("unhandledRejection", h);
  for (const x of wins) x.addEventListener("error", w);
  try { await fn(); await settle(); } finally { process.off("unhandledRejection", h); for (const x of wins) x.removeEventListener("error", w); }
  return seen;
}

describe("R2 B1 onOpenModels containment", () => {
  const cases: Array<[string, () => unknown]> = [
    ["throwing", () => { throw new Error("open-sync"); }],
    ["rejecting", async () => { throw new Error("open-async"); }],
  ];
  for (const [name, cb] of cases) {
    it(`${name} onOpenModels: status-line click does not escape`, async () => {
      const host = document.createElement("div"); document.body.append(host);
      // Plain counter, not vi.fn: a spy observes returned promises and would mask the rejection.
      let calls = 0;
      mountWall(host, vm(), { onOpenModels: ((b: HTMLElement) => { calls++; void b; return cb(); }) as never });
      const btn = host.querySelector<HTMLButtonElement>('button[aria-controls="model-sheet"]');
      expect(btn).not.toBeNull();
      const seen = await withEscapes([window], () => { btn!.click(); });
      expect(calls).toBe(1);
      expect(seen).toEqual([]);
    });
  }
});

describe("R2 B2 iframe document", () => {
  it("model sheet in an iframe document: radio click emits select", () => {
    const d = frameDoc();
    const mount = d.createElement("div"); d.body.append(mount);
    const intents: ModelSheetIntent[] = [];
    const sheet = createModelSheet({ doc: d, mount, announcer: new FakeAnnouncer(), onIntent: (i) => { intents.push(i); } });
    sheet.render(snap());
    const el = () => mount.querySelector<HTMLElement>("#model-sheet") as HTMLElement;
    const radio = radioOf(rowByText({ el } as never, "Studio box"));
    expect(radio).not.toBeNull();
    radio.click();
    expect(intents.filter((i) => i.t === "select")).toHaveLength(1);
    sheet.dispose();
  });

  it("wall in an iframe document: status-line is a typed popup button and opens", () => {
    const d = frameDoc();
    const host = d.createElement("div"); d.body.append(host);
    const spy = vi.fn();
    mountWall(host, vm(), { onOpenModels: spy });
    const btn = host.querySelector<HTMLButtonElement>('.status-line[data-model]');
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn!.getAttribute("type")).toBe("button");
    expect(btn!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn!.getAttribute("aria-controls")).toBe("model-sheet");
    expect(btn!.getAttribute("aria-expanded")).toBe("false");
    btn!.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(btn);
  });
});
