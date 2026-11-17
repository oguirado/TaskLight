// U38 G6: extension/manifest.dev.json `key` is absent or a valid base64 DER SubjectPublicKeyInfo; never a private key.
// A-FB2: type the new ESM gate for the frozen oracle without another output file.
declare module "*hosting/firebase_gate.mjs" {
  export function firebaseConfigIsReal(sourceText: string): boolean;
}

// A-FB2: keep this ambient declaration in script scope; test imports load before assertions.
{
let createPublicKey: typeof import("node:crypto")["createPublicKey"];
let read: typeof import("./helpers")["read"];
let FIREBASE_PUBLIC_CONFIG: typeof import("../../../src/app/firebase-config.public")["FIREBASE_PUBLIC_CONFIG"];
let isPlaceholderConfig: typeof import("../../../src/app/firebase-config.public")["isPlaceholderConfig"];
let isPlaceholderValue: typeof import("../../../src/app/firebase-config.public")["isPlaceholderValue"];
let RECAPTCHA_SITE_KEY_PUBLIC: string;
let text: string;
let manifest: Record<string, unknown>;
beforeAll(async () => {
  ({ createPublicKey } = await import("node:crypto"));
  ({ read } = await import("./helpers"));
  ({ FIREBASE_PUBLIC_CONFIG, isPlaceholderConfig, isPlaceholderValue, RECAPTCHA_SITE_KEY_PUBLIC } =
    await import("../../../src/app/firebase-config.public"));
  text = read("extension/manifest.dev.json");
  manifest = JSON.parse(text) as Record<string, unknown>;
});

describe("G6 manifest.dev.json key", () => {
  it("never contains private key material", () => {
    expect(text).not.toMatch(/PRIVATE KEY/);
    expect(text).not.toMatch(/-----BEGIN/);
    expect(Object.keys(manifest).filter((k) => /private|secret/i.test(k))).toEqual([]);
  });
  it("`key` is either removed or a base64 DER SubjectPublicKeyInfo that OpenSSL parses", () => {
    if (!("key" in manifest)) return; // removed: allowed (the demo build injects a generated key)
    const key = manifest["key"];
    expect(typeof key).toBe("string");
    const b64 = key as string;
    expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const der = Buffer.from(b64, "base64");
    expect(der.length).toBeGreaterThan(90);
    let type: string | undefined;
    expect(() => { type = createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType; }).not.toThrow();
    expect(type).toBe("rsa");
  });
  it("the rest of the dev manifest is untouched (localhost + site.test connectable, same entry points)", () => {
    // A-FB2: accept placeholders or complete configuration, retaining localhost.
    let matches = ["https://site.test/*", "http://localhost/*"];
    if (isPlaceholderConfig(FIREBASE_PUBLIC_CONFIG)) {
      expect(isPlaceholderValue(RECAPTCHA_SITE_KEY_PUBLIC)).toBe(true);
    } else {
      expect(isPlaceholderValue(RECAPTCHA_SITE_KEY_PUBLIC)).toBe(false);
      const binding = JSON.parse(read(".firebaserc")) as { projects: { default: string } };
      expect(binding.projects.default).toBe(FIREBASE_PUBLIC_CONFIG["projectId"]);
      matches = [`https://${binding.projects.default}.web.app/*`, `https://${binding.projects.default}.firebaseapp.com/*`, "http://localhost/*"];
    }
    expect((manifest["externally_connectable"] as { matches: string[] }).matches).toEqual(matches);
    expect((manifest["background"] as { service_worker: string }).service_worker).toBe("src/sw.js");
  });
});
// A-FB2: close the test-local scope.
}
