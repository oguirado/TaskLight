import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameSelectionStore, createPageModelTransport } from "../../../../src/app/model_port";
import type { SelectionStore } from "../../../../src/app/model_port";
import type { LiveConfig } from "../../../../src/config/types";
import { Channel, LOCAL, factory, services, deferred, settled, flush, signal, FakeClock } from "../wire/fixtures";
import { track } from "../../u47/fixtures";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const request = (id = LOCAL.id, rung: 1 | 2 | 3 = 1) => ({
  id, rung, tier: "standard" as const,
  messages: [{ role: "user" as const, content: "fixture prompt" }],
  maxTokens: 10, schema: { type: "object" }, signal: signal(),
});

describe("U52 repair R1-R4 (blocking items)", () => {
  it("R1 rc.activate resolves before refreshFlags reads the new value", async () => {
    const sdk = factory();
    const clockValues = { external_providers_enabled: "" };
    let observer: Parameters<import("../../../../src/config/types").RemoteConfigPort["onConfigUpdate"]>[0] | undefined;
    let flip: (() => void) | undefined;
    const getString = vi.fn((k: string) => clockValues[k as keyof typeof clockValues] ?? "");
    const rc = {
      setDefaults: () => undefined, setMinimumFetchIntervalMillis: () => undefined,
      fetchAndActivate: async () => true,
      activate: vi.fn(() => new Promise<boolean>((resolve) => {
        flip = () => { clockValues.external_providers_enabled = "false"; resolve(true); };
      })),
      getString,
      onConfigUpdate(o: Parameters<import("../../../../src/config/types").RemoteConfigPort["onConfigUpdate"]>[0]) { observer = o; return () => undefined; },
    };
    const ch = new Channel();
    const { service } = services({ channel: ch, rc });
    ch.host([LOCAL]); await flush(); await settled(service.registry.refresh());
    service.registry.select({ all: LOCAL.id });
    expect(service.registry.list().find((p) => p.id === LOCAL.id)?.blockedReason).toBeUndefined();
    observer!.next(new Set(["external_providers_enabled"]));
    await flush();
    // Activation still pending: the new value must not have been read yet.
    expect(service.registry.list().find((p) => p.id === LOCAL.id)?.blockedReason).toBeUndefined();
    flip!(); await flush();
    expect(service.registry.list().find((p) => p.id === LOCAL.id)).toMatchObject({ health: "blocked", blockedReason: "remote_config" });
    service.dispose();
  });

  it("R2 injected rejections are contained and disposed late completions do not apply", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const failingStore: SelectionStore = {
        get: () => Promise.reject(new Error("read failed")),
        set: () => Promise.reject(new Error("write failed")),
        onChange: () => () => undefined,
      };
      const failingLive: LiveConfig = {
        start: () => Promise.reject(new Error("live failed")),
        current: () => ({ cfg: {} as never, gen: 1, hash: "00000000", activatedAt: null }),
        badge: () => ({ text: "", gen: 1, hash: "00000000", promptVersion: "v1", cloudOff: false, live: "defaults" }),
        subscribe: () => () => undefined,
        onVisibility: () => undefined,
        dispose: () => undefined,
      };
      let rcObserver: Parameters<import("../../../../src/config/types").RemoteConfigPort["onConfigUpdate"]>[0] | undefined;
      const failingRc = {
        setDefaults: () => undefined, setMinimumFetchIntervalMillis: () => undefined,
        fetchAndActivate: async () => true,
        activate: () => Promise.reject(new Error("rc fail")),
        getString: () => "",
        onConfigUpdate(o: Parameters<import("../../../../src/config/types").RemoteConfigPort["onConfigUpdate"]>[0]) { rcObserver = o; return () => undefined; },
      };
      const ch = new Channel();
      const w = services({ channel: ch, selectionStore: failingStore, live: failingLive, rc: failingRc });
      w.service.sheet().select({ all: "firebase-cloud" });
      rcObserver!.next(new Set(["external_providers_enabled"]));
      await flush();
      expect(unhandled).toEqual([]);
      w.service.dispose();

      // Late start completion after dispose must not read flags anymore.
      const late = deferred<import("../../../../src/config/types").ConfigSnapshot>();
      const snapshot = { cfg: {} as never, gen: 1, hash: "00000000", activatedAt: null } as import("../../../../src/config/types").ConfigSnapshot;
      const getString = vi.fn(() => "");
      const quietRc = {
        setDefaults: () => undefined, setMinimumFetchIntervalMillis: () => undefined,
        fetchAndActivate: async () => true, activate: async () => true, getString,
        onConfigUpdate: () => () => undefined,
      };
      const quietLive: LiveConfig = {
        start: () => late.promise,
        current: () => snapshot,
        badge: () => ({ text: "", gen: 1, hash: "00000000", promptVersion: "v1", cloudOff: false, live: "defaults" }),
        subscribe: () => () => undefined,
        onVisibility: () => undefined,
        dispose: () => undefined,
      };
      const w2 = services({ rc: quietRc, live: quietLive });
      getString.mockClear();
      w2.service.dispose();
      late.resolve(snapshot); await flush();
      expect(getString).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("R3 transport settles immediately when send returns false and drops abort listeners", async () => {
    const clock = new FakeClock();
    const ch = new Channel();
    const tr = createPageModelTransport(ch, clock);
    ch.hello();
    ch.send = () => false;
    const listBox = track(tr.list());
    const probeBox = track(tr.probe(LOCAL.id, signal()));
    const genBox = track(tr.generate(request()));
    await flush();
    expect(listBox).toMatchObject({ done: true, val: [] });
    expect(probeBox).toMatchObject({ done: true, val: { state: "offline", rung: null } });
    expect(genBox).toMatchObject({ done: true, val: { ok: false, nack: "offline" } });
    expect(clock.pending).toBe(0);
    tr.dispose();

    const ch2 = new Channel();
    const clock2 = new FakeClock();
    const tr2 = createPageModelTransport(ch2, clock2);
    ch2.hello();
    const ac = new AbortController();
    const p = tr2.generate({ ...request(), signal: ac.signal });
    const frame = ch2.of("model_generate")[0]!;
    ch2.emit({ t: "model_result", v: 1, rid: frame["rid"], text: "ok" });
    expect(await settled(p)).toEqual({ ok: true, text: "ok" });
    expect(getEventListeners(ac.signal, "abort")).toEqual([]);
    tr2.dispose();
  });

  it("R4 selection reads settle on dispose/reset/false-send and stale reads do not overwrite", async () => {
    {
      const ch = new Channel();
      const store = createFrameSelectionStore(ch);
      const box = track(store.get());
      store.dispose(); await flush();
      expect(box).toMatchObject({ done: true, val: {} });
    }
    {
      const ch = new Channel();
      const store = createFrameSelectionStore(ch);
      ch.hello();
      ch.send = () => false;
      const box = track(store.get());
      await flush();
      expect(box).toMatchObject({ done: true, val: {} });
      store.dispose();
    }
    {
      const ch = new Channel();
      const store = createFrameSelectionStore(ch);
      ch.hello();
      const box = track(store.get());
      await flush();
      expect(ch.of("model_sel_get")).toHaveLength(1);
      ch.reset(); await flush();
      expect(box).toMatchObject({ done: true, val: {} });
      store.dispose();
    }
    {
      const d = deferred<import("../../../../src/providers/types").ModelSelection>();
      const storeVal: SelectionStore = {
        get: () => d.promise, set: () => Promise.resolve(), onChange: () => () => undefined,
      };
      const { service } = services({ selectionStore: storeVal });
      service.sheet().select({ all: "firebase-cloud" });
      d.resolve({ all: "firebase-ondevice" });
      await flush();
      expect(service.sheet().selection()).toEqual({ all: "firebase-cloud" });
      service.dispose();
    }
  });
});
