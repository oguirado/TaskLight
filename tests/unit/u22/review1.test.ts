// Repair loop 1 (REVIEW_1.md). Only DISP_03-blocking findings (categories 1-5). See ORACLE.md "Repair loop 1".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, onGoogleSignIn, onUserActivation, resetBootStateForTests } from "../../../src/app/boot";
import { probeAvailability } from "../../../src/app/availability";
import { createConnector } from "../../../src/app/connector";
import { renderHostState } from "../../../src/app/ui";
import { createWallPort } from "../../../src/app/wall_port";
import type { HostReply, HostState, ReplyTarget } from "../../../src/app/types";
import { EXT_ID, EXT_ORIGIN, FakeClock, FakePort, env, fakeRuntime, fakes } from "./harness";

// ---------------------------------------------------------------------------------------------
// Module fakes (firebase SDK + config + boot spies) shared by the main.ts wiring tests.
// ---------------------------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const s: { user: { uid: string; isAnonymous: boolean } | null; listeners: Array<(u: unknown) => void> } =
    { user: null, listeners: [] };
  const notify = (): void => { for (const l of [...s.listeners]) l(s.user); };
  const app = { name: "real-app" };
  return {
    s, app,
    initializeApp: vi.fn((_cfg: unknown) => app),
    initializeAppCheck: vi.fn((_a: unknown, _o: unknown) => ({})),
    ReCaptchaEnterpriseProvider: vi.fn(function (this: { siteKey: string }, k: string) { this.siteKey = k; }),
    CustomProvider: vi.fn(function () { /* debug provider */ }),
    getAuth: vi.fn((_a: unknown) => ({ auth: true })),
    onAuthStateChanged: vi.fn((_auth: unknown, cb: (u: unknown) => void) => {
      s.listeners.push(cb);
      queueMicrotask(() => { cb(s.user); });
      return () => { s.listeners = s.listeners.filter((x) => x !== cb); };
    }),
    signInAnonymously: vi.fn((_auth: unknown) => {
      s.user = { uid: "anon-1", isAnonymous: true }; notify(); return Promise.resolve({ user: s.user });
    }),
    GoogleAuthProvider: vi.fn(function () { /* provider */ }),
    signInWithPopup: vi.fn((_auth: unknown, _p: unknown) => {
      s.user = { uid: "g-1", isAnonymous: false }; notify(); return Promise.resolve({ user: s.user });
    }),
    getAI: vi.fn((_app: unknown, _o: unknown) => ({ ai: true })),
    onGoogleSignIn: vi.fn(),
    onUserActivation: vi.fn(),
  };
});
vi.mock("firebase/app", () => ({ initializeApp: H.initializeApp }));
vi.mock("firebase/app-check", () => ({
  initializeAppCheck: H.initializeAppCheck, ReCaptchaEnterpriseProvider: H.ReCaptchaEnterpriseProvider,
  CustomProvider: H.CustomProvider,
}));
vi.mock("firebase/auth", () => ({
  getAuth: H.getAuth, onAuthStateChanged: H.onAuthStateChanged, signInAnonymously: H.signInAnonymously,
  GoogleAuthProvider: H.GoogleAuthProvider, signInWithPopup: H.signInWithPopup,
}));
vi.mock("firebase/ai", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAI: H.getAI }));
vi.mock("../../../src/app/firebase-config.public", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FIREBASE_PUBLIC_CONFIG: { apiKey: "real-api-key", authDomain: "real.example.test", projectId: "real-proj", appId: "1:2:web:3",
    storageBucket: "real.appspot.test", messagingSenderId: "42" },
}));
// Delegating spies: record what handler/argument the page controls pass, behaviour stays real.
vi.mock("../../../src/app/boot", async (orig) => {
  const o = await orig<typeof import("../../../src/app/boot")>();
  return {
    ...o,
    onGoogleSignIn: (t: boolean) => { H.onGoogleSignIn(t); return o.onGoogleSignIn(t); },
    onUserActivation: (t: boolean) => { H.onUserActivation(t); return o.onUserActivation(t); },
  };
});

const textOf = (): string => document.getElementById("wall")?.textContent ?? "";
function controls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button, [role=button], input[type=button]")];
}
const label = (e: HTMLElement): string => `${e.textContent ?? ""} ${e.getAttribute("aria-label") ?? ""} ${(e as HTMLInputElement).value ?? ""}`;

function resetH(): void {
  H.s.user = null; H.s.listeners = [];
  for (const k of ["initializeApp", "initializeAppCheck", "ReCaptchaEnterpriseProvider", "CustomProvider", "getAuth",
    "onAuthStateChanged", "signInAnonymously", "GoogleAuthProvider", "signInWithPopup", "getAI", "onGoogleSignIn",
    "onUserActivation"] as const) H[k].mockClear();
}

async function loadHostedMain(): Promise<void> {
  vi.resetModules();
  vi.stubEnv("MODE", "production");
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "real-recaptcha-key");
  vi.stubEnv("VITE_APPCHECK_DEBUG_TOKEN", "");
  document.body.innerHTML = `<div id="wall"></div>`;
  await import("../../../hosting/src/main");
}

beforeEach(() => { resetBootStateForTests(); resetH(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); delete (globalThis as Record<string, unknown>)["LanguageModel"]; });

// ---------------------------------------------------------------------------------------------
// 1. Production wiring (B1, hosted inference purpose): real placeholders replaced -> real Firebase ports.
// ---------------------------------------------------------------------------------------------
describe("R1-1 production wiring builds real Firebase ports once config is real", () => {
  it("prod main.ts with real config + key: initializeApp, ReCaptchaEnterpriseProvider, initializeAppCheck, anonymous auth; wall is not blocked", async () => {
    await loadHostedMain();
    await vi.waitFor(() => { expect(textOf()).toMatch(/ready/i); }, { timeout: 4000 });
    expect(textOf()).not.toMatch(/blocked|CONFIG_INVALID|APPCHECK_INIT_FAILED/i);
    expect(H.initializeApp).toHaveBeenCalledTimes(1);
    expect(H.initializeApp.mock.calls[0]![0]).toMatchObject({ apiKey: "real-api-key", projectId: "real-proj" });
    expect(H.ReCaptchaEnterpriseProvider).toHaveBeenCalledWith("real-recaptcha-key");
    expect(H.initializeAppCheck).toHaveBeenCalledTimes(1);
    expect(H.initializeAppCheck.mock.calls[0]![0]).toBe(H.app);
    expect(H.initializeAppCheck.mock.calls[0]![1]).toMatchObject({ isTokenAutoRefreshEnabled: true });
    expect(H.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(textOf()).toContain("anon-1");
  });

  it("prod main.ts hands the attested app to U06 (getAI sees the initializeApp result, only after App Check)", async () => {
    await loadHostedMain();
    await vi.waitFor(() => { expect(H.getAI).toHaveBeenCalled(); }, { timeout: 4000 });
    expect(H.getAI.mock.calls[0]![0]).toBe(H.app);
    expect(H.initializeAppCheck.mock.invocationCallOrder[0]!).toBeLessThan(H.getAI.mock.invocationCallOrder[0]!);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Controls (B7/B8): trusted controls exist and call the handlers; identity + progress reach state.
// ---------------------------------------------------------------------------------------------
describe("R1-2 controls invoke the handlers", () => {
  it("a Google sign-in control and a device-model control exist after boot; each click calls its handler once with the event's own isTrusted", async () => {
    await loadHostedMain();
    await vi.waitFor(() => { expect(textOf()).toMatch(/ready/i); }, { timeout: 4000 });
    const root = document.getElementById("wall")!;
    const g = controls(root).find((e) => /google/i.test(label(e)));
    const d = controls(root).find((e) => !/google/i.test(label(e)) && /device|model|download|on-device/i.test(label(e)));
    expect(g, "Google sign-in control").toBeDefined();
    expect(d, "device-model control").toBeDefined();
    g!.click();
    expect(H.onGoogleSignIn).toHaveBeenCalledTimes(1);
    expect(H.onGoogleSignIn).toHaveBeenCalledWith(false); // jsdom click() is untrusted: wiring must pass ev.isTrusted, not a literal true
    d!.click();
    expect(H.onUserActivation).toHaveBeenCalledTimes(1);
    expect(H.onUserActivation).toHaveBeenCalledWith(false);
    expect(H.signInWithPopup).not.toHaveBeenCalled(); // untrusted click never opens the popup (B7)
  });
});

describe("R1-2 identity and device progress are surfaced in state", () => {
  it("successful Google sign-in updates the host identity (uid g-1, not anonymous)", async () => {
    const f = fakes({ user: null });
    await boot(env(), f.fb, f.hy, f.onState);
    await onGoogleSignIn(true);
    const last = f.states[f.states.length - 1]!;
    expect(last.kind).toBe("ready");
    expect(last).toMatchObject({ uid: "g-1", isAnonymous: false });
  });

  it("device-model progress values 0..1 are emitted in state while initialising", async () => {
    const f = fakes({ user: { uid: "u1", isAnonymous: true } });
    let release: () => void = () => undefined;
    let cb: (v: number) => void = () => undefined;
    (f.hy as { initializeDeviceModel: unknown }).initializeDeviceModel = (p: (v: number) => void) => {
      cb = p; p(0.25);
      return new Promise<void>((r) => { release = r; });
    };
    await boot(env(), f.fb, f.hy, f.onState);
    const pending = onUserActivation(true);
    await Promise.resolve();
    cb(0.75);
    const during = JSON.stringify(f.states);
    expect(during).toContain("0.25");
    expect(during).toContain("0.75");
    release(); await pending;
    expect(f.states[f.states.length - 1]).toMatchObject({ kind: "ready", deviceModel: "initialized" });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. B16: blocked keeps replay + stale info.
// ---------------------------------------------------------------------------------------------
describe("R1-3 blocked rendering never blanks the replay/stale content (B16)", () => {
  function rootWithWall(): HTMLElement {
    document.body.innerHTML = `<div id="wall"><section id="replay-fixture">Replay fixture: 3 streams</section><span class="stale-badge">stale 5m</span></div>`;
    return document.getElementById("wall")!;
  }
  const keeps = (root: HTMLElement): boolean =>
    (root.querySelector("#replay-fixture") !== null && root.querySelector(".stale-badge") !== null)
    || (/replay/i.test(root.textContent ?? "") && /stale/i.test(root.textContent ?? ""));

  it("blocked after booting: banner with the reason code AND replay/stale content remain", () => {
    const root = rootWithWall();
    renderHostState(root, { kind: "booting" });
    renderHostState(root, { kind: "blocked", reason: "MISSING_RECAPTCHA_KEY" });
    const alert = root.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("MISSING_RECAPTCHA_KEY");
    expect(keeps(root)).toBe(true);
  });

  it("blocked directly (no prior booting render) keeps replay/stale content", () => {
    const root = rootWithWall();
    renderHostState(root, { kind: "blocked", reason: "CONFIG_INVALID" });
    expect(root.querySelector("[role=alert]")?.textContent).toContain("CONFIG_INVALID");
    expect(keeps(root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Stalled injected operations time out (fake timers).
// ---------------------------------------------------------------------------------------------
const STALL_MS = 120_000;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe("R1-4 pending injected operations time out instead of stalling", () => {
  it("onAuthStateChanged that never calls back: boot settles, leaves 'booting', unsubscribes", async () => {
    vi.useFakeTimers();
    const f = fakes();
    const unsub = vi.fn();
    (f.fb as { onAuthStateChanged: unknown }).onAuthStateChanged = () => unsub;
    let settled: HostState | undefined;
    void boot(env(), f.fb, f.hy, f.onState).then((s) => { settled = s; });
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(settled).toBeDefined();
    expect(settled!.kind === "degraded" || settled!.kind === "blocked").toBe(true);
    expect(unsub).toHaveBeenCalled();
  });

  it("signInAnonymously that never settles: boot settles degraded/blocked (not stuck booting)", async () => {
    vi.useFakeTimers();
    const f = fakes({ user: null });
    (f.fb as { signInAnonymously: unknown }).signInAnonymously = () => never();
    let settled: HostState | undefined;
    void boot(env(), f.fb, f.hy, f.onState).then((s) => { settled = s; });
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(settled).toBeDefined();
    expect(settled!.kind).not.toBe("booting");
    expect(settled!.kind).not.toBe("ready");
  });

  it("initializeDeviceModel that never settles: activation settles and the state becomes 'failed'", async () => {
    vi.useFakeTimers();
    const f = fakes({ user: { uid: "u1", isAnonymous: true } });
    (f.hy as { initializeDeviceModel: unknown }).initializeDeviceModel = () => never();
    const bp = boot(env(), f.fb, f.hy, f.onState);
    await vi.advanceTimersByTimeAsync(10);
    await bp;
    let done = false;
    void onUserActivation(true).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(done).toBe(true);
    expect(f.states[f.states.length - 1]).toMatchObject({ kind: "ready", deviceModel: "failed" });
  });

  it("signInWithGooglePopup that never settles: onGoogleSignIn settles", async () => {
    vi.useFakeTimers();
    const f = fakes({ user: { uid: "u1", isAnonymous: true } });
    (f.fb as { signInWithGooglePopup: unknown }).signInWithGooglePopup = () => never();
    const bp = boot(env(), f.fb, f.hy, f.onState);
    await vi.advanceTimersByTimeAsync(10);
    await bp;
    let done = false;
    void onGoogleSignIn(true).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(done).toBe(true);
  });

  it("LanguageModel.availability() that never settles: probe resolves 'unknown'", async () => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>)["LanguageModel"] = { availability: () => never() };
    let out: string | undefined;
    void probeAvailability().then((v) => { out = v; });
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(out).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Boot-context isolation (races between our own async steps).
// ---------------------------------------------------------------------------------------------
describe("R1-5 async continuations stay bound to the boot that started them", () => {
  async function twoBoots() {
    const A = fakes({ user: null });
    const B = fakes({ user: { uid: "uidB", isAnonymous: false } });
    let releaseA: () => void = () => undefined;
    (A.fb as { onAuthStateChanged: unknown }).onAuthStateChanged = (_a: unknown, cb: (u: null) => void) => {
      releaseA = () => { cb(null); };
      return () => undefined;
    };
    const pa = boot(env(), A.fb, A.hy, A.onState);
    await Promise.resolve();
    await boot(env(), B.fb, B.hy, B.onState);
    return { A, B, pa, releaseA: () => releaseA() };
  }

  it("a late first boot does not push state into the second boot's observer or hybrid", async () => {
    const { A, B, pa, releaseA } = await twoBoots();
    const bStates = B.states.length;
    releaseA(); await pa;
    expect(B.states.length).toBe(bStates);
    expect(B.states.some((s) => s.kind === "ready" && s.uid === "uidB")).toBe(true);
    await onUserActivation(true);
    expect(B.hy_spies["initializeDeviceModel"]).toHaveBeenCalledTimes(1);
    expect(A.hy_spies["initializeDeviceModel"]).not.toHaveBeenCalled();
    expect(B.states[B.states.length - 1]).toMatchObject({ kind: "ready", uid: "uidB", deviceModel: "initialized" });
  });

  it("Google sign-in after a late first boot uses the second boot's ports only", async () => {
    const { A, B, pa, releaseA } = await twoBoots();
    releaseA(); await pa;
    await onGoogleSignIn(true);
    expect(B.fb_spies["signInWithGooglePopup"]).toHaveBeenCalledTimes(1);
    expect(A.fb_spies["signInWithGooglePopup"]).not.toHaveBeenCalled();
  });

  it("device model still initialises at most once per page load across a repeated boot", async () => {
    const A = fakes({ user: { uid: "a", isAnonymous: true } });
    const B = fakes({ user: { uid: "b", isAnonymous: true } });
    await boot(env(), A.fb, A.hy, A.onState);
    await onUserActivation(true);
    await boot(env(), B.fb, B.hy, B.onState);
    await onUserActivation(true);
    const total = (A.hy_spies["initializeDeviceModel"]?.mock.calls.length ?? 0) + (B.hy_spies["initializeDeviceModel"]?.mock.calls.length ?? 0);
    expect(total).toBe(1);
  });

  it("an activation in flight for boot A cannot mutate boot B's state when it finishes late", async () => {
    const A = fakes({ user: { uid: "a", isAnonymous: true } });
    const B = fakes({ user: { uid: "b", isAnonymous: true } });
    let releaseA: () => void = () => undefined;
    (A.hy as { initializeDeviceModel: unknown }).initializeDeviceModel = () => new Promise<void>((r) => { releaseA = r; });
    await boot(env(), A.fb, A.hy, A.onState);
    const act = onUserActivation(true);
    await boot(env(), B.fb, B.hy, B.onState);
    const before = B.states.length;
    releaseA(); await act;
    expect(B.states.length).toBe(before);
    expect(B.states[B.states.length - 1]).toMatchObject({ kind: "ready", uid: "b", deviceModel: "idle" });
  });
});

// ---------------------------------------------------------------------------------------------
// 6. wall_port: injected failures never escape; missing snapshot recovers.
// ---------------------------------------------------------------------------------------------
describe("R1-6 wall_port contains injected failures", () => {
  const snap = (nonce: string, items: Array<{ seq: number; projectId: string; payload: unknown }>) => ({ t: "snapshot", v: 1, nonce, items });
  function rig(wrapPort?: (p: FakePort) => void, onEvent?: (raw: string) => void) {
    const rt = fakeRuntime(); const clock = new FakeClock(); const raw: string[] = []; let n = 0;
    const connect = (id: string) => { const p = rt.connect(id) as FakePort; wrapPort?.(p); return p; };
    const wp = createWallPort({ extId: EXT_ID, connect, clock, onEvent: (r) => { raw.push(r); onEvent?.(r); }, nonce: () => `n${++n}` });
    return { rt, clock, raw, wp };
  }

  it("hello postMessage throwing does not escape start(); the port recovers by retry or reports unreachable", () => {
    const r = rig((p) => { p.postMessage = () => { throw new Error("disconnected"); }; });
    expect(() => { r.wp.start(); }).not.toThrow();
    expect(() => { r.clock.advance(120_000); }).not.toThrow();
    expect(r.rt.ports.length > 1 || r.wp.state().kind === "unreachable").toBe(true);
  });

  it("hello throwing only on a reconnect attempt does not escape the retry timer", () => {
    let calls = 0;
    const r = rig((p) => { const orig = p.postMessage.bind(p); p.postMessage = (m: unknown) => { if (++calls > 1) throw new Error("disconnected"); orig(m); }; });
    r.wp.start();
    r.rt.last().drop();
    expect(() => { r.clock.advance(120_000); }).not.toThrow();
  });

  it("ping postMessage throwing does not escape the interval", () => {
    const r = rig();
    r.wp.start();
    r.rt.last().emit(snap("n1", []));
    expect(r.wp.state().kind).toBe("linked");
    r.rt.last().postMessage = () => { throw new Error("disconnected"); };
    expect(() => { r.clock.advance(20_000 * 3); }).not.toThrow();
  });

  it("onEvent throwing for one snapshot item neither escapes nor drops the rest nor skips ping setup", () => {
    let n = 0;
    const r = rig(undefined, () => { if (++n === 1) throw new Error("sink boom"); });
    r.wp.start();
    expect(() => { r.rt.last().emit(snap("n1", [
      { seq: 1, projectId: "a", payload: 1 }, { seq: 2, projectId: "a", payload: 2 }, { seq: 3, projectId: "a", payload: 3 }])); }).not.toThrow();
    expect(r.raw.length).toBe(3);
    expect(r.wp.state()).toEqual({ kind: "linked", nonce: "n1" });
    r.clock.advance(20_000);
    expect(r.wp.stats().pings).toBe(1);
  });

  it("onEvent throwing on a live event does not escape", () => {
    const r = rig(undefined, () => { throw new Error("sink boom"); });
    r.wp.start();
    r.rt.last().emit(snap("n1", []));
    expect(() => { r.rt.last().emit({ t: "event", v: 1, seq: 9, projectId: "p", payload: 1 }); }).not.toThrow();
    expect(r.wp.state().kind).toBe("linked");
  });

  it("a connected port that never sends a snapshot does not stay resyncing forever", () => {
    const r = rig();
    r.wp.start();
    expect(r.wp.state().kind).toBe("resyncing");
    expect(() => { r.clock.advance(120_000); }).not.toThrow();
    const recovered = r.rt.ports.length > 1 || r.wp.state().kind === "unreachable";
    expect(recovered, `state=${JSON.stringify(r.wp.state())} ports=${r.rt.ports.length}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Connector lost updates (REVIEW item 7; DISP_03 #5). State is committed only after the operation succeeded.
// ---------------------------------------------------------------------------------------------
describe("R1-7 connector commits session/sequence only after success", () => {
  const good = (out: HostReply[]): ReplyTarget => ({ postMessage: (m) => { out.push(m); } });
  const bad: ReplyTarget = { postMessage: () => { throw new Error("disconnected"); } };
  const attempt = (f: () => void): void => { try { f(); } catch { /* escaping is allowed here; commit-state is what is pinned */ } };

  it("an ack that could not be delivered leaves no handshake: a following event is NO_HANDSHAKE and not accepted", () => {
    const accepted: number[] = []; const out: HostReply[] = [];
    const c = createConnector(env(), { accept: (_p, s) => { accepted.push(s); } }, () => 1000);
    attempt(() => { c.onMessage({ origin: EXT_ORIGIN, data: { t: "hello", v: 1, nonce: "n1" }, source: bad }); });
    attempt(() => { c.onMessage({ origin: EXT_ORIGIN, data: { t: "event", v: 1, seq: 1, projectId: "p", payload: 1 }, source: good(out) }); });
    expect(accepted).toEqual([]);
    expect(out.some((m) => m.t === "nack" && m.code === "NO_HANDSHAKE")).toBe(true);
  });

  it("a sink that throws once does not burn the sequence: retrying the same seq is accepted, not SEQ_NOT_MONOTONIC", () => {
    const accepted: number[] = []; const out: HostReply[] = []; let first = true;
    const c = createConnector(env(), { accept: (_p, s) => { if (first) { first = false; throw new Error("sink boom"); } accepted.push(s); } }, () => 1000);
    const src = good(out);
    c.onMessage({ origin: EXT_ORIGIN, data: { t: "hello", v: 1, nonce: "n1" }, source: src });
    attempt(() => { c.onMessage({ origin: EXT_ORIGIN, data: { t: "event", v: 1, seq: 1, projectId: "p", payload: 1 }, source: src }); });
    attempt(() => { c.onMessage({ origin: EXT_ORIGIN, data: { t: "event", v: 1, seq: 1, projectId: "p", payload: 1 }, source: src }); });
    expect(out.some((m) => m.t === "nack" && m.code === "SEQ_NOT_MONOTONIC")).toBe(false);
    expect(accepted).toEqual([1]);
    expect(c.stats().accepted).toBe(1);
  });
});
