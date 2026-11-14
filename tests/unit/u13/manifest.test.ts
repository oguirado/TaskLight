import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXT = resolve(__dirname, "../../../extension");
const m = (): Record<string, any> => JSON.parse(readFileSync(resolve(EXT, "manifest.json"), "utf8"));
const ALLOWED = ["storage", "sidePanel", "tabs", "scripting", "nativeMessaging"];
const BROAD = (s: string) => s === "<all_urls>" || /^(\*|https?|http\*?):\/\/\*\/\*$/.test(s) || s === "*://*/*";

describe("O14 manifest_minimal (B1')", () => {
  it("MV3 with service worker, side panel and a pinned key", () => {
    const x = m();
    expect(x.manifest_version).toBe(3);
    expect(typeof x.background?.service_worker).toBe("string");
    expect(String(x.side_panel?.default_path)).toMatch(/\.html$/);
    expect(typeof x.key).toBe("string"); expect(x.key.length).toBeGreaterThan(100);
    expect(typeof x.version).toBe("string");
  });
  it("permissions are a subset of the allow-list and include storage + sidePanel", () => {
    const p: string[] = m().permissions ?? [];
    expect(p.every((x) => ALLOWED.includes(x))).toBe(true);
    expect(p).toContain("storage"); expect(p).toContain("sidePanel");
    expect(p).not.toContain("offscreen"); expect(p).not.toContain("activeTab");
  });
  it("no host_permissions by default; <all_urls> never in permissions or host_permissions", () => {
    const x = m();
    expect(x.host_permissions ?? []).toEqual([]);
    expect(JSON.stringify(x.permissions ?? [])).not.toContain("<all_urls>");
    expect(x.permissions ?? []).not.toContain("<all_urls>");
  });
  it("page hosts only via optional_host_permissions (per-site runtime grant)", () => {
    const o = m().optional_host_permissions;
    expect(Array.isArray(o)).toBe(true); expect(o.length).toBeGreaterThan(0);
    expect(o.every((s: unknown) => typeof s === "string" && /^(https?|\*):\/\//.test(s as string))).toBe(true);
  });
  it("no static content script on every page; no unsafe web_accessible_resources", () => {
    const x = m();
    for (const c of x.content_scripts ?? []) for (const mt of c.matches ?? []) expect(BROAD(mt)).toBe(false);
    for (const w of x.web_accessible_resources ?? []) for (const mt of w.matches ?? []) expect(BROAD(mt)).toBe(false);
  });
  it("externally_connectable.matches is exactly one https site pattern (no localhost, no wildcard host) in prod", () => {
    const mt: string[] = m().externally_connectable?.matches ?? [];
    expect(mt).toHaveLength(1);
    expect(mt[0]).toMatch(/^https:\/\/[A-Za-z0-9.-]+\/\*$/);
    expect(mt[0]).not.toMatch(/localhost|\*\./);
    expect(m().externally_connectable?.ids).toBeUndefined();
  });
  it("CSP adds no remote script source, no unsafe-eval, no unsafe-inline", () => {
    const csp = m().content_security_policy?.extension_pages;
    expect(typeof csp).toBe("string");
    const script = String(csp).split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src")) ?? "";
    expect(script).not.toMatch(/https?:|unsafe-eval|unsafe-inline|wasm-unsafe-eval|\*/);
    expect(script).toContain("'self'");
    expect(String(csp)).not.toMatch(/unsafe-eval/);
  });
  it("no sandbox page that could relax CSP; no declarativeNetRequest remote rules", () => {
    const x = m();
    expect(x.sandbox).toBeUndefined();
    expect(x.permissions ?? []).not.toContain("declarativeNetRequest");
  });
});

describe("B21 panel iframe (static markup)", () => {
  const html = (): string => readFileSync(resolve(EXT, "src/panel/panel.html"), "utf8");
  const iframe = (): string => /<iframe\b[^>]*>/i.exec(html())?.[0] ?? "";
  it("iframe carries src and allow=\"language-model\" together in static markup", () => {
    const t = iframe();
    expect(t).not.toBe("");
    expect(/\ballow\s*=\s*"[^"]*\blanguage-model\b[^"]*"/.test(t)).toBe(true);
    const src = /\bsrc\s*=\s*"([^"]+)"/.exec(t)?.[1] ?? "";
    expect(src).toMatch(/^https:\/\//);
    expect(src).not.toContain("*");
  });
  it("allow does not grant language-model to '*'", () => { expect(iframe()).not.toMatch(/language-model\s+\*/); });
  it("no inline script and no remote script in panel.html", () => {
    for (const s of html().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(s[2]!.trim()).toBe("");
      expect(s[1]).not.toMatch(/src\s*=\s*"https?:/);
    }
  });
  it("panel.ts never assigns iframe src/allow from script (S4: silently unavailable)", () => {
    const ts = readFileSync(resolve(EXT, "src/panel/panel.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(ts).not.toMatch(/\.(src|allow)\s*=[^=]/);
    expect(ts).not.toMatch(/setAttribute\(\s*["'](src|allow)["']/);
    expect(ts).not.toMatch(/srcdoc|createElement\(\s*["']iframe["']/);
  });
});
