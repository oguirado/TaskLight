// Local demo only: the hosting Vite config plus <link> tags for repo/styles/*.css.
// hosting/index.html and hosting/src/main.ts import no stylesheet, so without this the
// wall renders unstyled. Links are same-origin (CSP style-src 'self' allows them).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import base from "../../hosting/vite.config.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHEETS = ["tokens.css", "views.css", "wall.css", "agents.css"];

const injectStyles: Plugin = {
  name: "cw-demo-styles",
  apply: "serve",
  transformIndexHtml() {
    return SHEETS.map((f) => ({
      tag: "link",
      attrs: { rel: "stylesheet", href: "/@fs" + join(repo, "styles", f) },
      injectTo: "head" as const,
    }));
  },
};

export default defineConfig((env: ConfigEnv) => {
  const cfg = (typeof base === "function" ? base(env) : base) as UserConfig;
  return { ...cfg, plugins: [...(cfg.plugins ?? []), injectStyles] };
});
