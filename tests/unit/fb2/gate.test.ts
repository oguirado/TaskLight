import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// FB2 Amendment A (M9): the hosting build gate judges the config VALUES, not a substring of the whole file.
const ROOT = resolve(__dirname, "../../..");
const shipped = readFileSync(resolve(ROOT, "src/app/firebase-config.public.ts"), "utf8");
const real = shipped
  .replace('"PLACEHOLDER_API_KEY"', '"AIza' + 'SyA1234567890abcdefghijklmnopqrstuv"')
  .replace('"PLACEHOLDER_AUTH_DOMAIN"', '"demo-proj-1.firebaseapp.com"')
  .replace('"PLACEHOLDER_PROJECT_ID"', '"demo-proj-1"')
  .replace('"PLACEHOLDER_APP_ID"', '"1:123456789012:web:abcdef0123456789"')
  .replace('"PLACEHOLDER_STORAGE_BUCKET"', '"demo-proj-1.firebasestorage.app"')
  .replace('"PLACEHOLDER_SENDER_ID"', '"123456789012"')
  .replace('"PLACEHOLDER_RECAPTCHA_SITE_KEY"', '"6LcAbCdEfGhIjKlMnOpQrStUvWxYz0123456789"');

describe("FB2 M9 hosting Firebase gate", () => {
  it("gate module exists and judges values", async () => {
    const mod = await import("../../../hosting/firebase_gate.mjs");
    expect(mod.firebaseConfigIsReal(shipped)).toBe(false);
    expect(real).toContain("PLACEHOLDER_PREFIX"); // the constant stays in the file
    expect(mod.firebaseConfigIsReal(real)).toBe(true);
    expect(mod.firebaseConfigIsReal(real.replace('"demo-proj-1"', '"<PROJECT>"'))).toBe(false);
    expect(mod.firebaseConfigIsReal(real.replace('"demo-proj-1"', '""'))).toBe(false);
    expect(mod.firebaseConfigIsReal("")).toBe(false);
  });
  it("vite config uses the gate instead of a raw substring test", () => {
    const vite = readFileSync(resolve(ROOT, "hosting/vite.config.ts"), "utf8");
    expect(vite).toContain("firebaseConfigIsReal");
    expect(vite).not.toMatch(/includes\(\s*["']PLACEHOLDER_["']\s*\)/);
  });
});
