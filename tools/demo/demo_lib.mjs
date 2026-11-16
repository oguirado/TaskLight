// Pure helpers for the local demo (U72). No filesystem probing, no process
// launch, no clock: everything here is a deterministic function of its inputs.

/**
 * Parse CSS side-effect imports from a JS/TS source string and return the
 * ordered basenames of `.../styles/*.css` imports.
 * Passive text scan: the source is never executed.
 */
export function parseStylesheetImports(source) {
  if (typeof source !== "string" || source.length === 0) return [];
  const found = [];
  // Match `import "..."` / `import '...'` (with or without a trailing
  // semicolon). Only paths containing a `/styles/` segment qualify, so
  // unrelated imports (./app.js, etc.) are excluded.
  const re = /import\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (typeof spec !== "string") continue;
    // Require a styles/ path segment and a .css suffix.
    const seg = /styles\/([^"']+\.css)$/.exec(spec);
    if (seg && typeof seg[1] === "string") {
      // Basename only (drop any intermediate subpath below styles/).
      const base = seg[1].split("/").pop();
      if (base) found.push(base);
    }
  }
  return found;
}

const PATH_BROWSERS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "brave-browser",
];

// Standard macOS app bundle app names and their in-bundle executables, in
// the same order used by the oracle coverage check. These follow PATH
// candidates on darwin.
const DARWIN_APPS = [
  ["Google Chrome.app", "Google Chrome"],
  ["Chromium.app", "Chromium"],
  ["Microsoft Edge.app", "Microsoft Edge"],
  ["Brave Browser.app", "Brave Browser"],
];

function joinPosix(...parts) {
  return parts
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

/**
 * Ordered executable paths for Chrome discovery.
 * `CHROME` (env.CHROME) wins when set, then PATH candidates in
 * browser-priority order (for each browser, each PATH dir in order),
 * then macOS app bundles on darwin. No filesystem probing.
 */
export function chromeCandidates(platform, env) {
  const e = env ?? {};
  const out = [];
  if (typeof e.CHROME === "string" && e.CHROME.length > 0) out.push(e.CHROME);
  const rawPath = typeof e.PATH === "string" ? e.PATH : "";
  const dirs = rawPath === "" ? [] : rawPath.split(":").filter((d) => d.length > 0);
  for (const browser of PATH_BROWSERS) {
    for (const dir of dirs) out.push(joinPosix(dir, browser));
  }
  if (platform === "darwin") {
    for (const [app, exe] of DARWIN_APPS) {
      out.push(joinPosix("/Applications", app, "Contents", "MacOS", exe));
    }
  }
  return out;
}

/**
 * Exit-code gate for the demo summary.
 * Default: plan, drift, question, planV2 and memory must all pass.
 * With options.noMcp: planV2 and memory are ignored.
 * A legacy question receipt object counts as successful question evidence.
 * Missing required evidence fails.
 */
export function summaryExitCode(summary, options = {}) {
  const s = summary ?? {};
  const noMcp = options !== null && typeof options === "object" && Boolean(options.noMcp);
  const isTrue = (v) => v === true;
  const questionPass = (v) => {
    if (v === true) return true;
    if (v !== null && typeof v === "object") return true;
    if (typeof v === "string" && v.length > 0) return true;
    return false;
  };
  const required = [
    ["plan", isTrue(s.plan)],
    ["drift", isTrue(s.drift)],
    ["question", questionPass(s.question)],
  ];
  if (!noMcp) {
    required.push(["planV2", isTrue(s.planV2)], ["memory", isTrue(s.memory)]);
  }
  return required.every(([, ok]) => ok) ? 0 : 1;
}
