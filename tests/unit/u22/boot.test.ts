import { beforeEach, describe, expect, it, vi } from "vitest";
import { boot, onGoogleSignIn, onUserActivation, resetBootStateForTests } from "../../../src/app/boot";
import type { HostState } from "../../../src/app/types";
import { EXT_ORIGIN, FIXTURE_TOKEN, ORDER_KEYS, REAL_CFG, env, fakes } from "./harness";

beforeEach(() => { resetBootStateForTests(); });
const noCalls = (f: ReturnType<typeof fakes>, ...names: string[]) => { for (const n of names) expect(f.fire(n), n).toBe(0); };

describe("O1 prod_recaptcha", () => {
  it("uses ReCaptchaEnterpriseProvider(key), auto refresh, no debug flag, ready/recaptcha_enterprise", async () => {
    const f = fakes();
    const s = await boot(env({ mode: "prod", origin: "https://site.example.test", recaptchaSiteKey: "k1" }), f.fb, f.hy, f.onState);
    expect(f.fb_spies["newRecaptchaEnterpriseProvider"]).toHaveBeenCalledTimes(1);
    expect(f.fb_spies["newRecaptchaEnterpriseProvider"]).toHaveBeenCalledWith("k1");
    expect(f.fb_spies["initializeAppCheck"]).toHaveBeenCalledTimes(1);
    const [app, opts] = f.fb_spies["initializeAppCheck"]!.mock.calls[0] as [unknown, { provider: unknown; isTokenAutoRefreshEnabled: boolean }];
    expect(app).toBe(f.app);
    expect(opts.isTokenAutoRefreshEnabled).toBe(true);
    expect(opts.provider).toEqual({ kind: "recaptcha" });
    noCalls(f, "setDebugFlag", "newDebugCompatibleProvider");
    expect(s).toEqual({ kind: "ready", uid: "anon-1", isAnonymous: true, appCheck: "recaptcha_enterprise", deviceModel: "idle" });
  });
});

describe("O2 boot order and state stream", () => {
  it("dev: initializeApp < setDebugFlag < initializeAppCheck < signInAnonymously < create (exact)", async () => {
    const f = fakes();
    const s = await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(f.log.filter((x) => ORDER_KEYS.includes(x))).toEqual(ORDER_KEYS);
    expect(f.log.indexOf("initializeAppCheck")).toBeLessThan(f.log.indexOf("getAuth"));
    expect(s).toMatchObject({ kind: "ready", appCheck: "debug", deviceModel: "idle" });
  });
  it("emits booting first and the returned state last", async () => {
    const f = fakes();
    const s = await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(f.states[0]).toEqual({ kind: "booting" });
    expect(f.states[f.states.length - 1]).toEqual(s);
  });
  it("existing user: no signInAnonymously, uid reused", async () => {
    const f = fakes({ user: { uid: "u-9", isAnonymous: false } });
    const s = await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    noCalls(f, "signInAnonymously");
    expect(s).toMatchObject({ kind: "ready", uid: "u-9", isAnonymous: false });
    expect(f.fire("HybridPort.create")).toBe(1);
  });
  it("create receives the app returned by initializeApp (attested app, B1)", async () => {
    const f = fakes();
    await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(f.hy_spies["create"]!.mock.calls[0]![0]).toBe(f.app);
  });
  it.each([false, true])("B6 useLimitedUseTokens=%s forwarded unchanged", async (v) => {
    const f = fakes();
    await boot(env({ debugToken: true, useLimitedUseTokens: v }), f.fb, f.hy, f.onState);
    expect(f.hy_spies["create"]!.mock.calls[0]![1]).toEqual({ useLimitedUseAppCheckTokens: v });
  });
});

describe("debug token: runtime only", () => {
  it.each([true, FIXTURE_TOKEN] as const)("dev passes env.debugToken=%s verbatim to setDebugFlag", async (tok) => {
    const f = fakes();
    await boot(env({ debugToken: tok }), f.fb, f.hy, f.onState);
    expect(f.fb_spies["setDebugFlag"]).toHaveBeenCalledTimes(1);
    expect(f.fb_spies["setDebugFlag"]).toHaveBeenCalledWith(tok);
  });
  it("dev without a token never sets the flag (no baked-in default)", async () => {
    const f = fakes();
    await boot(env(), f.fb, f.hy, f.onState);
    noCalls(f, "setDebugFlag");
  });
  it("token value never appears in emitted states or console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const f = fakes();
    await boot(env({ debugToken: FIXTURE_TOKEN }), f.fb, f.hy, f.onState);
    expect(JSON.stringify(f.states)).not.toContain(FIXTURE_TOKEN);
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(FIXTURE_TOKEN);
    spies.forEach((s) => s.mockRestore());
  });
});

describe("fail-closed guards (no AI, no App Check, no auth)", () => {
  const guarded = ["initializeAppCheck", "getAuth", "signInAnonymously", "HybridPort.create", "setDebugFlag"];
  it("O3 debug on public origin -> DEBUG_ON_PUBLIC_ORIGIN", async () => {
    const f = fakes();
    const s = await boot(env({ origin: "https://site.example.test", debugToken: true }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "DEBUG_ON_PUBLIC_ORIGIN" });
    noCalls(f, ...guarded);
  });
  it("B4 look-alike origins are public", async () => {
    for (const origin of ["http://localhost.evil.example:5173", "https://localhost:5173", "http://evil.example/localhost:5173"]) {
      resetBootStateForTests();
      const f = fakes();
      const s = await boot(env({ origin, debugToken: true }), f.fb, f.hy, f.onState);
      expect(s, origin).toEqual({ kind: "blocked", reason: "DEBUG_ON_PUBLIC_ORIGIN" });
    }
  });
  it("B4 http://127.0.0.1:<port> is allowed for debug", async () => {
    const f = fakes();
    const s = await boot(env({ origin: "http://127.0.0.1:4000", debugToken: true }), f.fb, f.hy, f.onState);
    expect(s.kind).toBe("ready");
  });
  it.each(["", "   ", undefined])("O4 prod key %j -> MISSING_RECAPTCHA_KEY", async (key) => {
    const f = fakes();
    const e = env({ mode: "prod", origin: "https://site.example.test", ...(key === undefined ? {} : { recaptchaSiteKey: key }) });
    const s = await boot(e, f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "MISSING_RECAPTCHA_KEY" });
    noCalls(f, ...guarded);
  });
  it("O5 debugToken in prod -> DEBUG_IN_PROD, flag never set", async () => {
    const f = fakes();
    const s = await boot(env({ mode: "prod", origin: "https://site.example.test", recaptchaSiteKey: "k1", debugToken: "uuid-fixture" }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "DEBUG_IN_PROD" });
    noCalls(f, ...guarded);
  });
  it("prod with placeholder firebase config -> CONFIG_INVALID, nothing initialised", async () => {
    const f = fakes();
    const s = await boot(env({ mode: "prod", origin: "https://site.example.test", recaptchaSiteKey: "k1",
      firebaseConfig: { ...REAL_CFG, apiKey: "PLACEHOLDER_API_KEY" } }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "CONFIG_INVALID" });
    expect(f.log).toEqual([]);
  });
  it("prod with placeholder recaptcha key -> CONFIG_INVALID", async () => {
    const f = fakes();
    const s = await boot(env({ mode: "prod", origin: "https://site.example.test", recaptchaSiteKey: "PLACEHOLDER_RECAPTCHA_SITE_KEY" }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "CONFIG_INVALID" });
    expect(f.log).toEqual([]);
  });
  it("prod with empty firebase config -> CONFIG_INVALID", async () => {
    const f = fakes();
    const s = await boot(env({ mode: "prod", origin: "https://site.example.test", recaptchaSiteKey: "k1", firebaseConfig: {} }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "CONFIG_INVALID" });
  });
  it("dev with placeholder config is allowed (local emulator work)", async () => {
    const f = fakes();
    const s = await boot(env({ debugToken: true, firebaseConfig: { apiKey: "PLACEHOLDER_API_KEY", authDomain: "PLACEHOLDER_AUTH_DOMAIN", projectId: "PLACEHOLDER_PROJECT_ID", appId: "PLACEHOLDER_APP_ID" } }), f.fb, f.hy, f.onState);
    expect(s.kind).toBe("ready");
  });
});

describe("failure states shown to the user", () => {
  it("O6 initializeAppCheck throws -> APPCHECK_INIT_FAILED; no auth, no AI; state streamed", async () => {
    const f = fakes({ appCheckThrows: true });
    const s = await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "blocked", reason: "APPCHECK_INIT_FAILED" });
    noCalls(f, "HybridPort.create", "signInAnonymously");
    expect(f.states.map((x) => x.kind)).toEqual(["booting", "blocked"]);
  });
  it("AUTH_FAILED: degraded state, AI still created exactly once (local-only wall)", async () => {
    const f = fakes({ anonFails: true });
    const s = await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(s).toEqual({ kind: "degraded", reason: "AUTH_FAILED", appCheck: "debug", deviceModel: "idle" });
    expect(f.fire("HybridPort.create")).toBe(1);
    expect(f.log.indexOf("HybridPort.create")).toBeGreaterThan(f.log.indexOf("signInAnonymously"));
  });
  it("boot never rejects: a throwing initializeApp becomes a blocked state", async () => {
    const f = fakes();
    f.fb_spies["initializeApp"]!.mockImplementation(() => { throw new Error("bad config"); });
    const s = await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(s.kind).toBe("blocked");
    noCalls(f, "HybridPort.create");
  });
});

describe("O7 device model activation (B8)", () => {
  it("untrusted call does nothing; trusted twice -> exactly one initializeDeviceModel", async () => {
    const f = fakes();
    await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    await onUserActivation(false);
    expect(f.fire("HybridPort.initializeDeviceModel")).toBe(0);
    await onUserActivation(true);
    await onUserActivation(true);
    expect(f.fire("HybridPort.initializeDeviceModel")).toBe(1);
  });
  it("state moves initializing -> initialized", async () => {
    const f = fakes();
    await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    await onUserActivation(true);
    const dm = f.states.flatMap((x) => (x.kind === "ready" ? [x.deviceModel] : []));
    expect(dm).toEqual(["idle", "initializing", "initialized"]);
  });
  it("failure -> failed, and no retry on later activation", async () => {
    const f = fakes({ deviceInit: () => Promise.reject(new Error("download failed")) });
    await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    await onUserActivation(true);
    await onUserActivation(true);
    expect(f.fire("HybridPort.initializeDeviceModel")).toBe(1);
    const last = f.states[f.states.length - 1] as Extract<HostState, { kind: "ready" }>;
    expect(last.deviceModel).toBe("failed");
  });
  it("blocked boot: activation never reaches the AI port", async () => {
    const f = fakes();
    await boot(env({ mode: "prod", origin: "https://site.example.test", recaptchaSiteKey: "" }), f.fb, f.hy, f.onState);
    await onUserActivation(true);
    noCalls(f, "HybridPort.initializeDeviceModel");
  });
});

describe("O8 anonymous then Google (B7)", () => {
  it("anon once at boot; popup only after a trusted click", async () => {
    const f = fakes();
    await boot(env({ debugToken: true }), f.fb, f.hy, f.onState);
    expect(f.fire("signInAnonymously")).toBe(1);
    expect(f.fire("signInWithGooglePopup")).toBe(0);
    await onGoogleSignIn(false);
    expect(f.fire("signInWithGooglePopup")).toBe(0);
    await onGoogleSignIn(true);
    expect(f.fire("signInWithGooglePopup")).toBe(1);
    expect(f.fire("signInAnonymously")).toBe(1);
  });
  it("extension origin constant sanity", () => { expect(EXT_ORIGIN.startsWith("chrome-extension://")).toBe(true); });
});
