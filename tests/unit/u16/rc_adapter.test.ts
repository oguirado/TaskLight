import { beforeEach, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const state = {
    rc: { defaultConfig: {} as Record<string, string>, settings: { minimumFetchIntervalMillis: 0 } },
    getRemoteConfig: 0, unsub: 0, observer: null as null | { next(u: { getUpdatedKeys(): Set<string> }): void; error(e: unknown): void; complete(): void },
    values: {} as Record<string, string>,
  };
  return state;
});
vi.mock("firebase/remote-config", () => ({
  getRemoteConfig: vi.fn(() => { sdk.getRemoteConfig++; return sdk.rc; }),
  fetchAndActivate: vi.fn(async () => true),
  activate: vi.fn(async () => false),
  getValue: vi.fn((_rc: unknown, k: string) => ({ asString: () => sdk.values[k] ?? "" })),
  onConfigUpdate: vi.fn((_rc: unknown, o: never) => { sdk.observer = o; return () => { sdk.unsub++; }; }),
}));

import { firebaseRemoteConfigPort } from "../../../src/config/firebase_rc";

const app = { name: "[DEFAULT]" } as unknown as import("firebase/app").FirebaseApp;
beforeEach(() => { sdk.getRemoteConfig = 0; sdk.unsub = 0; sdk.observer = null; sdk.values = {}; sdk.rc.defaultConfig = {}; sdk.rc.settings.minimumFetchIntervalMillis = 0; });

describe("firebase_rc adapter (B1, B2, B4)", () => {
  test("getRemoteConfig is called exactly once per port", async () => {
    const p = firebaseRemoteConfigPort(app);
    p.setDefaults({ a: "1" }); await p.fetchAndActivate(); p.getString("a");
    expect(sdk.getRemoteConfig).toBe(1);
  });
  test("setDefaults and setMinimumFetchIntervalMillis write the SDK settings", () => {
    const p = firebaseRemoteConfigPort(app);
    p.setDefaults({ kill_switch_cloud: "false" });
    p.setMinimumFetchIntervalMillis(43200000);
    expect(sdk.rc.defaultConfig).toEqual({ kill_switch_cloud: "false" });
    expect(sdk.rc.settings.minimumFetchIntervalMillis).toBe(43200000);
  });
  test("getString reads through getValue(...).asString(); fetchAndActivate/activate return the SDK booleans", async () => {
    const p = firebaseRemoteConfigPort(app);
    sdk.values["model_name"] = "gemini-z";
    expect(p.getString("model_name")).toBe("gemini-z");
    expect(await p.fetchAndActivate()).toBe(true);
    expect(await p.activate()).toBe(false);
  });
  test("onConfigUpdate maps getUpdatedKeys() to a ReadonlySet, forwards error/complete, and returns the unsubscribe", () => {
    const p = firebaseRemoteConfigPort(app);
    const got: string[][] = []; const errs: unknown[] = []; let done = 0;
    const off = p.onConfigUpdate({ next: (k) => got.push([...k]), error: (e) => errs.push(e), complete: () => { done++; } });
    sdk.observer!.next({ getUpdatedKeys: () => new Set(["kill_switch_cloud", "x"]) });
    sdk.observer!.error(new Error("e")); sdk.observer!.complete();
    expect(got).toEqual([["kill_switch_cloud", "x"]]);
    expect(errs).toHaveLength(1); expect(done).toBe(1);
    off(); expect(sdk.unsub).toBe(1);
  });
  test("a throwing getUpdatedKeys is routed to error(), not thrown into the SDK", () => {
    const p = firebaseRemoteConfigPort(app);
    const errs: unknown[] = []; const got: unknown[] = [];
    p.onConfigUpdate({ next: (k) => got.push(k), error: (e) => errs.push(e), complete: () => undefined });
    expect(() => sdk.observer!.next({ getUpdatedKeys: () => { throw new Error("bad"); } })).not.toThrow();
    expect(got).toEqual([]);
    expect(errs).toHaveLength(1);
  });
});
