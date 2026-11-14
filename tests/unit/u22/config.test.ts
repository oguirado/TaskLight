import { describe, expect, it } from "vitest";
import { FIREBASE_PUBLIC_CONFIG, RECAPTCHA_SITE_KEY_PUBLIC, isPlaceholderConfig, isPlaceholderValue } from "../../../src/app/firebase-config.public";
import { isLocalDevOrigin } from "../../../src/app/appcheck";
import { readHostEnv } from "../../../src/app/index";
import { createFirebasePorts } from "../../../src/app/firebase_ports";
import { renderHostState } from "../../../src/app/ui";
import { FIXTURE_TOKEN, REAL_CFG } from "./harness";

describe("placeholder guard", () => {
  it("shipped public config is placeholders (D-2 project absent) and detected as such", () => {
    expect(isPlaceholderConfig(FIREBASE_PUBLIC_CONFIG)).toBe(true);
    expect(isPlaceholderValue(RECAPTCHA_SITE_KEY_PUBLIC)).toBe(true);
  });
  it("real-looking config passes", () => { expect(isPlaceholderConfig(REAL_CFG)).toBe(false); });
  it.each([
    ["one placeholder field", { ...REAL_CFG, projectId: "PLACEHOLDER_PROJECT_ID" }],
    ["empty required value", { ...REAL_CFG, appId: "" }],
    ["missing required key", { apiKey: "k", authDomain: "d", projectId: "p" }],
    ["angle-bracket value", { ...REAL_CFG, authDomain: "<SITE>" }],
    ["REPLACE_ME", { ...REAL_CFG, apiKey: "replace_me" }],
    ["placeholder optional field", { ...REAL_CFG, storageBucket: "PLACEHOLDER_STORAGE_BUCKET" }],
  ])("flags %s", (_n, cfg) => { expect(isPlaceholderConfig(cfg as Record<string, string>)).toBe(true); });
  it("isPlaceholderValue", () => {
    for (const v of ["", undefined, "PLACEHOLDER_X", "<KEY>", "TODO"]) expect(isPlaceholderValue(v), String(v)).toBe(true);
    expect(isPlaceholderValue("6Lc-real-looking-key")).toBe(false);
  });
});

describe("B4 isLocalDevOrigin", () => {
  it.each([["http://localhost:5173", true], ["http://127.0.0.1:8080", true], ["https://localhost:5173", false],
    ["http://localhost.evil.example:5173", false], ["http://evil.example", false], ["https://site.example.test", false],
    ["http://localhost@evil.example:80", false], ["chrome-extension://abc", false], ["", false]])("%s -> %s", (o, r) => {
    expect(isLocalDevOrigin(o)).toBe(r);
  });
});

describe("readHostEnv (runtime/build env -> HostEnv)", () => {
  it("maps mode, key, token, origins, limited-use", () => {
    const e = readHostEnv({ MODE: "production", VITE_RECAPTCHA_SITE_KEY: "k1", VITE_EXTENSION_ORIGINS: "chrome-extension://a,chrome-extension://b",
      VITE_USE_LIMITED_USE_TOKENS: "true" }, "https://site.example.test");
    expect(e).toMatchObject({ mode: "prod", recaptchaSiteKey: "k1", origin: "https://site.example.test",
      extensionOrigins: ["chrome-extension://a", "chrome-extension://b"], useLimitedUseTokens: true });
    expect(e.firebaseConfig).toEqual(FIREBASE_PUBLIC_CONFIG);
    expect(e.debugToken).toBeUndefined();
  });
  it("defaults: dev, limited-use false, no origins, no token", () => {
    const e = readHostEnv({ MODE: "development" }, "http://localhost:5173");
    expect(e).toMatchObject({ mode: "dev", useLimitedUseTokens: false, extensionOrigins: [] });
    expect("debugToken" in e && e.debugToken !== undefined).toBe(false);
  });
  it("token: 'true' -> true; uuid -> string; empty -> undefined", () => {
    expect(readHostEnv({ MODE: "development", VITE_APPCHECK_DEBUG_TOKEN: "true" }, "http://localhost:1").debugToken).toBe(true);
    expect(readHostEnv({ MODE: "development", VITE_APPCHECK_DEBUG_TOKEN: FIXTURE_TOKEN }, "http://localhost:1").debugToken).toBe(FIXTURE_TOKEN);
    expect(readHostEnv({ MODE: "development", VITE_APPCHECK_DEBUG_TOKEN: "" }, "http://localhost:1").debugToken).toBeUndefined();
  });
});

describe("real firebase_ports.setDebugFlag (no network)", () => {
  it("writes self.FIREBASE_APPCHECK_DEBUG_TOKEN at runtime", () => {
    const g = globalThis as Record<string, unknown>;
    const p = createFirebasePorts();
    try {
      p.setDebugFlag(true); expect(g["FIREBASE_APPCHECK_DEBUG_TOKEN"]).toBe(true);
      p.setDebugFlag(FIXTURE_TOKEN); expect(g["FIREBASE_APPCHECK_DEBUG_TOKEN"]).toBe(FIXTURE_TOKEN);
    } finally { delete g["FIREBASE_APPCHECK_DEBUG_TOKEN"]; }
  });
});

describe("renderHostState (failure banner)", () => {
  const mk = () => document.createElement("div");
  it.each(["CONFIG_INVALID", "MISSING_RECAPTCHA_KEY", "DEBUG_IN_PROD", "DEBUG_ON_PUBLIC_ORIGIN", "APPCHECK_INIT_FAILED"] as const)(
    "blocked %s shows an alert naming the code", (reason) => {
      const r = mk(); renderHostState(r, { kind: "blocked", reason });
      const a = r.querySelector('[role="alert"]');
      expect(a?.textContent).toContain(reason);
    });
  it("degraded AUTH_FAILED shows an alert naming the code", () => {
    const r = mk(); renderHostState(r, { kind: "degraded", reason: "AUTH_FAILED", appCheck: "debug", deviceModel: "idle" });
    expect(r.querySelector('[role="alert"]')?.textContent).toContain("AUTH_FAILED");
  });
  it("ready has no alert; booting is announced; re-render replaces, never stacks", () => {
    const r = mk();
    renderHostState(r, { kind: "blocked", reason: "DEBUG_IN_PROD" });
    renderHostState(r, { kind: "ready", uid: "u", isAnonymous: true, appCheck: "debug", deviceModel: "idle" });
    expect(r.querySelector('[role="alert"]')).toBeNull();
    renderHostState(r, { kind: "booting" });
    expect(r.textContent?.toLowerCase()).toContain("boot");
    renderHostState(r, { kind: "blocked", reason: "DEBUG_IN_PROD" });
    renderHostState(r, { kind: "blocked", reason: "DEBUG_IN_PROD" });
    expect(r.querySelectorAll('[role="alert"]').length).toBe(1);
  });
  it("never injects markup from state (textContent only)", () => {
    const r = mk();
    renderHostState(r, { kind: "blocked", reason: "<img src=x onerror=1>" as never });
    expect(r.querySelector("img")).toBeNull();
  });
});
