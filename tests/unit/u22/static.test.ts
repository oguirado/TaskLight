import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_TOKEN } from "./harness";
import { REPO, cspViolations, findUuids, iframeViolations, metaCsp, parseCsp, read, scriptAllowAssignments, walk } from "./static";

const APP = join(REPO, "src/app"); const HOST = join(REPO, "hosting"); const DIST = join(HOST, "dist");
const appFiles = () => walk(APP).filter((f) => /\.(ts|tsx|js)$/.test(f));
const hostSrc = () => walk(HOST, [], ["node_modules", "dist"]);
const INDEX = join(HOST, "index.html");
const html = () => read(INDEX);

describe("surface exists (stubs are not enough)", () => {
  it.each(["src/app/types.ts", "src/app/boot.ts", "src/app/appcheck.ts", "src/app/connector.ts", "src/app/wall_port.ts",
    "src/app/availability.ts", "src/app/firebase_ports.ts", "src/app/firebase-config.public.ts", "src/app/index.ts",
    "hosting/index.html", "hosting/vite.config.ts", "hosting/headers.json", "hosting/README_HOSTING.md"])("%s", (f) => {
    expect(existsSync(join(REPO, f))).toBe(true);
  });
});

describe("scanner controls (non-vacuous)", () => {
  it("UUID regex finds a planted token, ignores non-UUID", () => {
    expect(findUuids(`x="${FIXTURE_TOKEN}"`)).toEqual([FIXTURE_TOKEN]);
    expect(findUuids("test-api-key-123 PLACEHOLDER_API_KEY")).toEqual([]);
  });
  it("iframe/allow/CSP checkers reject planted violations", () => {
    expect(iframeViolations('<iframe src="a"></iframe>').length).toBe(1);
    expect(iframeViolations('<iframe allow="language-model"></iframe>').length).toBe(1);
    expect(iframeViolations('<iframe src="a" allow="language-model"></iframe>')).toEqual([]);
    expect(scriptAllowAssignments("f.allow = 'language-model'").length).toBe(1);
    expect(scriptAllowAssignments("f.setAttribute('allow','x')").length).toBe(1);
    const bad = "default-src 'self'; script-src 'self' 'unsafe-eval' https://cdn.evil.example; object-src 'none'";
    expect(cspViolations(bad, { requireFrameAncestors: false }).length).toBeGreaterThan(1);
  });
});

describe("debug token never in source or bundle (B5)", () => {
  it("no UUID-like string in src/app or hosting sources", () => {
    const hits = [...appFiles(), ...hostSrc()].flatMap((f) => findUuids(read(f)).map((u) => `${f}: ${u}`));
    expect(hits).toEqual([]);
  });
  it("no .env.local / .env.* with values under src/app or hosting", () => {
    const bad = [...walk(APP), ...hostSrc()].filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f));
    expect(bad).toEqual([]);
  });
  it("FIREBASE_APPCHECK_DEBUG_TOKEN appears in src/app only inside firebase_ports.ts; not in hosting sources", () => {
    const inApp = appFiles().filter((f) => read(f).includes("FIREBASE_APPCHECK_DEBUG_TOKEN")).map((f) => f.replace(APP + "/", ""));
    expect(inApp.every((f) => f === "firebase_ports.ts")).toBe(true);
    expect(hostSrc().filter((f) => read(f).includes("FIREBASE_APPCHECK_DEBUG_TOKEN"))).toEqual([]);
  });
  it("no assignment of a literal to the debug flag anywhere in src/app or hosting", () => {
    const lit = /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*["'`]/;
    expect([...appFiles(), ...hostSrc()].filter((f) => lit.test(read(f)))).toEqual([]);
  });
  it("tools/secret_scan.sh is clean over src/app and hosting (excl. dist)", () => {
    for (const d of [APP, HOST]) {
      const r = spawnSync("bash", [join(REPO, "tools/secret_scan.sh"), d], { encoding: "utf8" });
      expect(r.status, r.stdout).toBe(0);
    }
  });
  it("tools/secret_scan.sh exits non-zero on a planted fixture (O13 control)", () => {
    const d = mkdtempSync(join(tmpdir(), "u22-scan-"));
    try {
      writeFileSync(join(d, "x.ts"), `self.FIREBASE_APPCHECK_DEBUG_TOKEN = "${FIXTURE_TOKEN}";\n`);
      expect(spawnSync("bash", [join(REPO, "tools/secret_scan.sh"), d], { encoding: "utf8" }).status).toBe(1);
      const c = mkdtempSync(join(tmpdir(), "u22-scan-clean-"));
      try { writeFileSync(join(c, "y.ts"), "export const a = 1;\n"); expect(spawnSync("bash", [join(REPO, "tools/secret_scan.sh"), c]).status).toBe(0); }
      finally { rmSync(c, { recursive: true, force: true }); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("module boundaries (R5, firebase_ports sole importer)", () => {
  it("only firebase_ports.ts imports firebase/*", () => {
    const bad = appFiles().filter((f) => !f.endsWith("firebase_ports.ts") && /from\s+["']firebase\/|import\(\s*["']firebase\//.test(read(f)));
    expect(bad).toEqual([]);
  });
  it("firebase_ports.ts imports firebase/app, firebase/app-check, firebase/auth and not firebase/ai", () => {
    const s = read(join(APP, "firebase_ports.ts"));
    for (const m of ["firebase/app", "firebase/app-check", "firebase/auth"]) expect(s).toContain(`"${m}"`);
    expect(s).not.toContain("firebase/ai");
  });
  it("src/app never calls getAI/getGenerativeModel/generateContent (U06 is sole caller)", () => {
    // A3-U22: agent_drift.ts calls generateContent only on a handle produced by the U06 model factory (it never imports firebase/ai).
    expect(appFiles().filter((f) => !f.endsWith("agent_drift.ts") && /\b(getAI|getGenerativeModel|generateContent)\b/.test(read(f)))).toEqual([]);
    expect(/\b(getAI|getGenerativeModel)\b|firebase\/ai/.test(read(join(APP, "agent_drift.ts")))).toBe(false);
  });
  it("no eval / new Function / iframe.allow assignment / innerHTML in src/app", () => {
    for (const f of appFiles()) {
      const s = read(f);
      expect(/(^|[^.\w$])eval\s*\(|new\s+Function\s*\(/.test(s), f).toBe(false);
      expect(scriptAllowAssignments(s), f).toEqual([]);
      expect(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(s), f).toBe(false);
    }
  });
  it("postMessage replies in src/app never use '*' as targetOrigin", () => {
    expect(appFiles().filter((f) => /postMessage\([^)]*,\s*["'`]\*["'`]\s*\)/.test(read(f)))).toEqual([]);
  });
});

describe("O14 CSP meta + headers (B15, B24)", () => {
  it("index.html has a CSP meta with script-src 'self' and object-src 'none', no unsafe-*", () => {
    const csp = metaCsp(html()); expect(csp).not.toBeNull();
    const d = parseCsp(csp!);
    expect(d.get("script-src")).toContain("'self'");
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline/);
    expect(cspViolations(csp!, { requireFrameAncestors: false })).toEqual([]);
  });
  it("script-src carries only 'self' plus the reCAPTCHA/Google script origins (no remote script hosts)", () => {
    const d = parseCsp(metaCsp(html()) ?? "");
    for (const s of d.get("script-src") ?? []) expect(["'self'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/", "https://apis.google.com"]).toContain(s);
  });
  it("hosting/headers.json: parseable, one Content-Security-Policy with frame-ancestors for chrome-extension origins only", () => {
    const j = JSON.parse(read(join(HOST, "headers.json"))) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    const csps = j.flatMap((e) => e.headers.filter((h) => h.key.toLowerCase() === "content-security-policy").map((h) => h.value));
    expect(csps.length).toBeGreaterThanOrEqual(1);
    for (const c of csps) {
      expect(cspViolations(c, { requireFrameAncestors: true })).toEqual([]);
      expect(parseCsp(c).get("frame-ancestors")!.every((x) => x.startsWith("chrome-extension://"))).toBe(true);
    }
    expect(j.some((e) => e.source === "**" || e.source === "/**")).toBe(true);
  });
  it("no X-Frame-Options DENY/SAMEORIGIN header that would block the extension embed", () => {
    const j = JSON.parse(read(join(HOST, "headers.json"))) as Array<{ headers: Array<{ key: string; value: string }> }>;
    expect(j.flatMap((e) => e.headers).filter((h) => h.key.toLowerCase() === "x-frame-options")).toEqual([]);
  });
});

describe("index.html scripts and embedding requirement", () => {
  it("all <script> are external relative modules; no inline script bodies or inline handlers", () => {
    const h = html();
    const scripts = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const m of scripts) {
      expect(m[1]).toMatch(/\ssrc\s*=\s*["'](?!https?:|\/\/)[^"']+["']/);
      expect(m[1]).toMatch(/type\s*=\s*["']module["']/);
      expect(m[2]!.trim()).toBe("");
    }
    expect(/\son[a-z]+\s*=/i.test(h)).toBe(false);
  });
  it("documents the embedding requirement in the HTML (allow=\"language-model\", static markup, frame-ancestors)", () => {
    const c = [...html().matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).join("\n");
    expect(c).toContain('allow="language-model"');
    expect(c).toMatch(/static|markup/i);
    expect(c).toContain("frame-ancestors");
  });
  it("any <iframe> in hosting HTML has src and allow=\"language-model\" in static markup", () => {
    for (const f of hostSrc().filter((x) => x.endsWith(".html"))) expect(iframeViolations(read(f)), f).toEqual([]);
  });
  it("hosting scripts never assign iframe.allow from JS", () => {
    for (const f of hostSrc().filter((x) => /\.(ts|js|html)$/.test(x))) expect(scriptAllowAssignments(read(f)), f).toEqual([]);
  });
  it("README_HOSTING.md documents the embed contract", () => {
    const r = read(join(HOST, "README_HOSTING.md"));
    expect(r).toContain('allow="language-model"');
    expect(r).toContain("frame-ancestors");
    expect(r).toContain("chrome-extension://");
    expect(r).toMatch(/before\s+`?src|static markup|same markup/i);
    expect(r).toMatch(/externally_connectable/);
  });
});

describe("O13 prod bundle clean (vite build --mode production, hostile env)", () => {
  it("dist has no debug-token key name, planted token value, eval( or new Function(", () => {
    rmSync(DIST, { recursive: true, force: true });
    const r = spawnSync("npx", ["vite", "build", "--mode", "production", "--config", "hosting/vite.config.ts"], {
      cwd: REPO, encoding: "utf8", timeout: 200_000,
      env: { ...process.env, VITE_APPCHECK_DEBUG_TOKEN: FIXTURE_TOKEN, FIREBASE_APPCHECK_DEBUG_TOKEN: FIXTURE_TOKEN, VITE_RECAPTCHA_SITE_KEY: "k-test" },
    });
    expect(r.status, (r.stdout ?? "") + (r.stderr ?? "")).toBe(0);
    expect(existsSync(join(DIST, "index.html"))).toBe(true);
    const files = walk(DIST).filter((f) => /\.(js|mjs|html|css|map|json)$/.test(f));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const s = read(f);
      expect(s.includes("FIREBASE_APPCHECK_DEBUG_TOKEN"), `${f} key name`).toBe(false);
      expect(s.includes(FIXTURE_TOKEN), `${f} planted token`).toBe(false);
      expect(/(^|[^.\w$])eval\s*\(|new\s+Function\s*\(/.test(s), `${f} eval/new Function`).toBe(false);
      for (const m of s.matchAll(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g)) {
        const ctx = s.slice(Math.max(0, m.index! - 80), m.index! + 120);
        expect(/debug|token|appcheck/i.test(ctx), `${f} uuid near debug/token: ${m[0]}`).toBe(false);
      }
    }
    const idx = read(join(DIST, "index.html"));
    expect(cspViolations(metaCsp(idx) ?? "", { requireFrameAncestors: false })).toEqual([]);
    mkdirSync(DIST, { recursive: true });
  }, 240_000);
});
