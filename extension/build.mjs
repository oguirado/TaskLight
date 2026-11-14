// Build the unpacked extension into extension/dist/ with Vite's build API (no esbuild bin needed).
//
//   node extension/build.mjs [--manifest dev|prod] [--key-file <b64 SPKI file>] [--out <dir>]
//                            [--origin <pattern>]...
//
// - Service worker: a virtual entry that calls startSwMain() from src/sw_main.ts with the
//   external-port gate built from the manifest's externally_connectable.matches (or --origin).
//   Bundled as a classic IIFE script at <out>/src/sw.js (manifest background.service_worker).
// - sw.ts self-boots at module load with a fixed `https://site.test/*` gate. When it is bundled
//   under sw_main that second instance would disconnect every other origin's port (same port
//   object), so the build neutralises that boot block in the bundle only (source untouched).
// - Panel: src/panel/panel.ts -> <out>/src/panel/panel.js; panel.html is copied with a script tag.
// - Manifest: copied from manifest.json / manifest.dev.json; --key-file replaces `key` in the
//   BUILT copy only.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const extRoot = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { manifest: "dev", keyFile: null, out: join(extRoot, "dist"), origins: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error("missing value for " + a);
      return argv[++i];
    };
    if (a === "--manifest") o.manifest = v();
    else if (a === "--key-file") o.keyFile = v();
    else if (a === "--out") o.out = resolve(v());
    else if (a === "--origin") o.origins.push(v());
    else throw new Error("unknown arg " + a);
  }
  if (o.manifest !== "dev" && o.manifest !== "prod") throw new Error("--manifest dev|prod");
  return o;
}

const SW_BOOT_RE = /const bootChrome = \(globalThis as unknown as \{ chrome\?: ChromeLike \}\)\.chrome;/;

function swEntryPlugin(gateOrigins) {
  const VIRTUAL = "\0cw-sw-entry";
  return {
    name: "cw-sw-entry",
    enforce: "pre",
    resolveId(id) {
      // Lib mode hands the entry over root-resolved (e.g. "<root>/cw-sw-entry").
      return id === "cw-sw-entry" || id.endsWith("/cw-sw-entry") ? VIRTUAL : null;
    },
    load(id) {
      if (id !== VIRTUAL) return null;
      const swMain = JSON.stringify(join(extRoot, "src", "sw_main.ts"));
      return [
        `import { startSwMain } from ${swMain};`,
        `const ch = globalThis.chrome;`,
        `if (ch) {`,
        `  startSwMain({ chrome: ch, gate: { allowedOrigins: Object.freeze(${JSON.stringify(gateOrigins)}) } })`,
        `    .catch(() => {});`,
        `}`,
      ].join("\n");
    },
    transform(code, id) {
      if (!id.endsWith(join("extension", "src", "sw.ts"))) return null;
      if (!SW_BOOT_RE.test(code)) return null; // sw.ts no longer self-starts (U38 G2): nothing to strip
      return { code: code.replace(SW_BOOT_RE, "const bootChrome = undefined as ChromeLike | undefined;"), map: null };
    },
  };
}

async function bundle(entry, outDir, fileName, name, plugins = []) {
  await build({
    configFile: false,
    root: extRoot,
    logLevel: "warn",
    plugins,
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      lib: { entry, formats: ["iife"], name, fileName: () => fileName },
    },
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const srcManifest = join(extRoot, o.manifest === "dev" ? "manifest.dev.json" : "manifest.json");
  const manifest = JSON.parse(readFileSync(srcManifest, "utf8"));
  if (o.keyFile) {
    const key = readFileSync(o.keyFile, "utf8").trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(key)) throw new Error("key file is not base64");
    manifest.key = key;
  }
  const gate = o.origins.length > 0 ? o.origins : (manifest.externally_connectable?.matches ?? []);
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(join(o.out, "src", "panel"), { recursive: true });

  await bundle("cw-sw-entry", o.out, "src/sw.js", "cwSw", [swEntryPlugin(gate)]);
  await bundle(join(extRoot, "src", "panel", "panel.ts"), o.out, "src/panel/panel.js", "cwPanel");

  const panelHtml = readFileSync(join(extRoot, "src", "panel", "panel.html"), "utf8")
    .replace("</body>", '<script src="panel.js"></script></body>');
  writeFileSync(join(o.out, "src", "panel", "panel.html"), panelHtml);
  writeFileSync(join(o.out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ok: true, out: o.out, manifest: o.manifest, gate }) + "\n");
}

main().catch((e) => {
  process.stderr.write("build failed: " + (e && e.message ? e.message : String(e)) + "\n");
  process.exit(1);
});
