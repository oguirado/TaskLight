// U37c AMEND_W (U22): hosting/src/main.ts with a REAL Firebase config: boot runs as before, startAgentWall is
// called when an extension id is configured, and the drift reviewer gets a port built from the attested app.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBootStateForTests } from "../../../src/app/boot";
import { EXT_ID, PagePort } from "./harness";

const H = vi.hoisted(() => {
  const s: { user: { uid: string; isAnonymous: boolean } | null; listeners: Array<(u: unknown) => void> } = { user: null, listeners: [] };
  const notify = (): void => { for (const l of [...s.listeners]) l(s.user); };
  const app = { name: "real-app" };
  return {
    s, app,
    initializeApp: vi.fn((_c: unknown) => app),
    initializeAppCheck: vi.fn((_a: unknown, _o: unknown) => ({})),
    ReCaptchaEnterpriseProvider: vi.fn(function (this: { k: string }, k: string) { this.k = k; }),
    CustomProvider: vi.fn(function () { /* debug */ }),
    getAuth: vi.fn((_a: unknown) => ({ auth: true })),
    onAuthStateChanged: vi.fn((_a: unknown, cb: (u: unknown) => void) => { s.listeners.push(cb); queueMicrotask(() => { cb(s.user); }); return () => undefined; }),
    signInAnonymously: vi.fn((_a: unknown) => { s.user = { uid: "anon-1", isAnonymous: true }; notify(); return Promise.resolve({ user: s.user }); }),
    GoogleAuthProvider: vi.fn(function () { /* provider */ }),
    signInWithPopup: vi.fn(),
    getAI: vi.fn((_app: unknown, _o: unknown) => ({ ai: true })),
    link: { start: vi.fn(), stop: vi.fn(), state: vi.fn(), post: vi.fn() },
    store: { ingest: vi.fn(), ingestJsonl: vi.fn(), since: vi.fn(), states: vi.fn(), events: vi.fn() },
    reviewer: { review: vi.fn() },
    wall: { refresh: vi.fn(), destroy: vi.fn() },
    createAgentLink: vi.fn(), createAgentStore: vi.fn(), createDriftReviewer: vi.fn(), startAgentWall: vi.fn(), driftPortFromFactory: vi.fn(),
  };
});
vi.mock("firebase/app", () => ({ initializeApp: H.initializeApp }));
vi.mock("firebase/app-check", () => ({ initializeAppCheck: H.initializeAppCheck, ReCaptchaEnterpriseProvider: H.ReCaptchaEnterpriseProvider, CustomProvider: H.CustomProvider }));
vi.mock("firebase/auth", () => ({ getAuth: H.getAuth, onAuthStateChanged: H.onAuthStateChanged, signInAnonymously: H.signInAnonymously, GoogleAuthProvider: H.GoogleAuthProvider, signInWithPopup: H.signInWithPopup }));
vi.mock("firebase/ai", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAI: H.getAI }));
vi.mock("../../../src/app/firebase-config.public", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FIREBASE_PUBLIC_CONFIG: { apiKey: "real-api-key", authDomain: "real.example.test", projectId: "real-proj", appId: "1:2:web:3", storageBucket: "real.appspot.test", messagingSenderId: "42" },
}));
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: H.createAgentLink }));
vi.mock("../../../src/app/agent_store", () => ({ createAgentStore: H.createAgentStore }));
vi.mock("../../../src/app/agent_drift", () => ({ createDriftReviewer: H.createDriftReviewer, driftPortFromFactory: H.driftPortFromFactory }));
vi.mock("../../../src/app/agent_wall", () => ({ startAgentWall: H.startAgentWall }));

const textOf = (): string => document.getElementById("wall")?.textContent ?? "";
async function loadMain(origins: string): Promise<void> {
  vi.resetModules();
  vi.stubEnv("MODE", "production");
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "real-recaptcha-key");
  vi.stubEnv("VITE_APPCHECK_DEBUG_TOKEN", "");
  vi.stubEnv("VITE_EXTENSION_ORIGINS", origins);
  document.body.innerHTML = `<div id="wall"></div>`;
  await import("../../../hosting/src/main");
}
beforeEach(() => {
  resetBootStateForTests(); H.s.user = null; H.s.listeners = [];
  for (const f of [H.initializeApp, H.initializeAppCheck, H.getAI, H.signInAnonymously, H.createAgentLink, H.createAgentStore, H.createDriftReviewer, H.startAgentWall, H.driftPortFromFactory]) f.mockClear();
  H.createAgentLink.mockReturnValue(H.link); H.createAgentStore.mockReturnValue(H.store); H.createDriftReviewer.mockReturnValue(H.reviewer);
  H.startAgentWall.mockReturnValue(H.wall); H.driftPortFromFactory.mockReturnValue({ sentinel: "drift-port" });
  (globalThis as Record<string, unknown>)["chrome"] = { runtime: { connect: vi.fn(() => new PagePort()) } };
});
afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as Record<string, unknown>)["chrome"]; document.body.innerHTML = ""; });

describe("real config + extension id configured", () => {
  it("boot still runs (App Check, anonymous auth) AND startAgentWall is called once with hosts inside #wall", async () => {
    await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(textOf()).toMatch(/ready/i); }, { timeout: 4000 });
    expect(H.initializeApp).toHaveBeenCalledTimes(1);
    expect(H.initializeAppCheck).toHaveBeenCalledTimes(1);
    expect(H.signInAnonymously).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => { expect(H.startAgentWall).toHaveBeenCalledTimes(1); });
    const a = H.startAgentWall.mock.calls[0]![0] as { wallHost: HTMLElement; chatHost: HTMLElement };
    expect(document.getElementById("wall")!.contains(a.wallHost)).toBe(true);
    expect(document.getElementById("wall")!.contains(a.chatHost)).toBe(true);
    expect(textOf()).not.toMatch(/blocked|CONFIG_INVALID/i);
  });
  it("the reviewer gets a drift port derived from the attested app via driftPortFromFactory(factory, mode) (object, or lazy (mode) => port)", async () => {
    await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(H.getAI).toHaveBeenCalled(); }, { timeout: 4000 });
    await vi.waitFor(() => { expect(H.createDriftReviewer).toHaveBeenCalled(); });
    const opts = H.createDriftReviewer.mock.calls.at(-1)![0] as { port?: unknown } | undefined;
    expect(opts?.port).toBeDefined();
    if (typeof opts!.port === "function") {
      expect((opts!.port as (m: string) => unknown)("ONLY_ON_DEVICE")).toEqual({ sentinel: "drift-port" });
      expect(H.driftPortFromFactory.mock.calls.at(-1)![1]).toBe("ONLY_ON_DEVICE");
    } else {
      expect(opts!.port).toEqual({ sentinel: "drift-port" });
    }
    expect(H.getAI.mock.calls[0]![0]).toBe(H.app); // the factory wraps the attested app, after App Check
    expect(H.initializeAppCheck.mock.invocationCallOrder[0]!).toBeLessThan(H.getAI.mock.invocationCallOrder[0]!);
  });
});

describe("real config, NO extension id", () => {
  it("boot is unchanged and the agent wall is not started", async () => {
    await loadMain("");
    await vi.waitFor(() => { expect(textOf()).toMatch(/ready/i); }, { timeout: 4000 });
    expect(H.initializeApp).toHaveBeenCalledTimes(1);
    expect(H.startAgentWall).not.toHaveBeenCalled();
    expect(H.createAgentLink).not.toHaveBeenCalled();
  });
});
