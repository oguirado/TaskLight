// U38 G6: extension/manifest.dev.json `key` is absent or a valid base64 DER SubjectPublicKeyInfo; never a private key.
import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { read } from "./helpers";

const text = read("extension/manifest.dev.json");
const manifest = JSON.parse(text) as Record<string, unknown>;

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
    expect((manifest["externally_connectable"] as { matches: string[] }).matches).toEqual(["https://site.test/*", "http://localhost/*"]);
    expect((manifest["background"] as { service_worker: string }).service_worker).toBe("src/sw.js");
  });
});
