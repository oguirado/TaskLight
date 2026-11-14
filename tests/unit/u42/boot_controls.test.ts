// U42 item 5 (real config half): with a REAL Firebase config the boot buttons show as before.
// The placeholder half is boot_placeholder.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBootStateForTests } from "../../../src/app/boot";
import { EXT_ID, PagePort } from "../u37c/harness";

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

const g = globalThis as Record<string, unknown>;
const btns = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>(".boot-controls button.boot-btn")];

async function loadMain(): Promise<HTMLElement> {
  vi.resetModules();
  vi.stubEnv("MODE", "production");
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "real-recaptcha-key");
  vi.stubEnv("VITE_APPCHECK_DEBUG_TOKEN", "");
  vi.stubEnv("VITE_EXTENSION_ORIGINS", `chrome-extension://${EXT_ID}`);
  document.body.innerHTML = `<div id="wall"></div>`;
  await import("../../../hosting/src/main");
  await vi.waitFor(() => { expect(document.querySelector("#wall .rail-status")).not.toBeNull(); });
  return document.getElementById("wall") as HTMLElement;
}

beforeEach(() => {
  resetBootStateForTests(); H.s.user = null; H.s.listeners = [];
  g["chrome"] = { runtime: { connect: vi.fn(() => new PagePort()) } };
});
afterEach(() => { vi.unstubAllEnvs(); delete g["chrome"]; document.body.innerHTML = ""; });

describe("boot controls, real config", () => {
  it("real config: both buttons show in .rail-status > .boot-controls as before (type=button, English copy)", async () => {
    const root = await loadMain();
    await vi.waitFor(() => { expect(btns(root)).toHaveLength(2); });
    const b = btns(root);
    expect(b.map((x) => x.textContent?.trim())).toEqual(["Sign in with Google", "Download device model"]);
    for (const x of b) expect(x.getAttribute("type")).toBe("button");
    expect(root.querySelector(".rail-status .boot-controls")).not.toBeNull();
    expect(root.querySelector(".rail-status .status-line[data-model] .status-text")?.textContent?.trim()).toBe("Gemini Nano: checking…");
  });
});
