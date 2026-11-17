import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { firebaseConfigIsReal } from "./firebase_gate.mjs";

const hostingRoot = dirname(fileURLToPath(import.meta.url));

// Real Firebase wiring is bundled only when the shipped public config carries
// real values (not the placeholder). A placeholder production build stays
// Firebase-free (B5/O13); boot then fails closed on CONFIG_INVALID.
const shippedConfig = readFileSync(
  join(hostingRoot, "..", "src", "app", "firebase-config.public.ts"),
  "utf8",
);
const firebaseReal = firebaseConfigIsReal(shippedConfig);

// Root is the hosting directory so index.html stays the entry and dist is hosting/dist.
// Cache lives inside hosting so builds never touch a shared read-only node_modules.
export default defineConfig(({ mode }) => ({
  root: hostingRoot,
  cacheDir: join(hostingRoot, "node_modules", ".vite"),
  build: { outDir: "dist" },
  server: { fs: { allow: [hostingRoot, ".."] } },
  define:
    mode === "production"
      ? {
          "import.meta.env.VITE_APPCHECK_DEBUG_TOKEN": '""',
          __U22_FIREBASE_REAL__: String(firebaseReal),
        }
      : {},
}));
