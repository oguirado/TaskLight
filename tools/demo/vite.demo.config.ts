// Local demo only: the hosting Vite config plus <link> tags for repo/styles/*.css.
// hosting/src/main.ts imports the stylesheet cascade; the stylesheet list is
// derived by parsing that file with the pure helper so demo links never drift
// from the app order. Links are same-origin (CSP style-src 'self' allows them).
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import base from "../../hosting/vite.config.ts";
import { parseStylesheetImports } from "./demo_lib.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainTs = join(repo, "hosting", "src", "main.ts");
const stylesheetSource = readFileSync(mainTs, "utf8");
const stylesheetNames: string[] = parseStylesheetImports(stylesheetSource);

const injectStyles: Plugin = {
  name: "cw-demo-styles",
  apply: "serve",
  transformIndexHtml() {
    return stylesheetNames.map((f) => ({
      tag: "link",
      attrs: { rel: "stylesheet", href: "/@fs/" + normalizePath(join(repo, "styles", f)).replace(/^\//, "") },
      injectTo: "head" as const,
    }));
  },
};

export default defineConfig((env: ConfigEnv) => {
  const cfg = (typeof base === "function" ? base(env) : base) as UserConfig;
  return { ...cfg, plugins: [...(cfg.plugins ?? []), injectStyles] };
});
