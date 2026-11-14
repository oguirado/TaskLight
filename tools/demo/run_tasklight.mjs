// Tasklight one-command demo: local Context Wall + U40 ViewPoint observer (no Firebase project).
//
//   node tools/demo/run_tasklight.mjs --check    [--headless] [--dir D]       readiness table, exit 1 on any FAIL
//   node tools/demo/run_tasklight.mjs --replay   [--headless] [--speed X]     4 synthetic ViewPoint runs -> room "viewpoint" -> wall
//   node tools/demo/run_tasklight.mjs --viewpoint [--headless] [--history]   observe the REAL default runs root (read-only)
//   node tools/demo/run_tasklight.mjs --stop     [--dir D]                    stop the processes a previous --keep run started
// Common: --dir D (default $TASKLIGHT_DEMO_DIR, else <tmpdir>/tasklight-demo), --port N (Vite), --cw-home D, --keep,
//         --root D (replay: runs root, default a fresh dir under D/vp_runs; viewpoint: passed to the observer),
//         --duration S (headless --viewpoint: seconds to stay up, default 5), --exit (windowed: exit after the replay check),
//         --ext-dir D (skip the extension build; use an unpacked build made with --key-file <dir>/keys/demo_pub.b64).
//
// Pipeline (reuses tools/demo/run_demo.mjs pieces): build extension with a demo key -> setup_native.py (rooms viewpoint + demo)
// -> Vite dev wall (tools/demo/vite.demo.config.ts) -> Chrome with a THROWAWAY profile -> CDP Extensions.loadUnpacked -> wall page
// -> `python3 -m bridge.viewpoint watch --root R --room viewpoint --interval 0.5` -> (replay) tools/demo/vp_replay.py --root R.
// Hard rules: never writes under /dev/shm/vqa-cu (replay root refused), never uses DISPLAY :98 or port 5998, never touches a
// real Chrome profile, never starts ViewPoint/MetaViewer. Only processes started here are stopped (their own process groups).
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, rmSync, mkdtempSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const MODES = ["--check", "--replay", "--viewpoint", "--stop"].filter(has);
if (MODES.length !== 1) {
  console.error("usage: node tools/demo/run_tasklight.mjs --check|--replay|--viewpoint|--stop [--headless] [--dir D] [--port N] [--speed X] [--keep]");
  process.exit(2);
}
const MODE = MODES[0].slice(2);
const FORBIDDEN_ROOT = "/dev/shm/vqa-cu";
const FORBIDDEN_PORT = 5998;
const FORBIDDEN_DISPLAY = /^[^:]*:98(\.\d+)?$/;
const CHROME = "/usr/bin/google-chrome";
const ROOM = "viewpoint";
const ROOMS = ["viewpoint", "demo"];
const GOALS = [
  "Ask ChatGPT about on-device AI",
  "Ask Gemini to compare hybrid inference",
  "Search Wikipedia for Firebase",
  "Find the latest arXiv paper on small language models",
];
// U42: observer agent slug and task title per replay goal.
const EXPECT = [
  { agent: "chatgpt-agent", title: `ChatGPT \u00b7 ${GOALS[0]}` },
  { agent: "gemini-agent", title: `Gemini \u00b7 ${GOALS[1]}` },
  { agent: "wikipedia-agent", title: `Wikipedia \u00b7 ${GOALS[2]}` },
  { agent: "arxiv-agent", title: `arXiv \u00b7 ${GOALS[3]}` },
];
const AGENT_SLUG_RE = /^(chatgpt|gemini|wikipedia|arxiv|viewpoint)-agent(-\d+)?$/;

const DIR = path.resolve(opt("--dir", process.env.TASKLIGHT_DEMO_DIR ?? path.join(os.tmpdir(), "tasklight-demo")));
const under = (p, root) => p === root || p.startsWith(root + path.sep);
if (under(DIR, FORBIDDEN_ROOT)) { console.error(`REFUSED: --dir under ${FORBIDDEN_ROOT}`); process.exit(2); }
const DISPLAY = process.env.DISPLAY ?? "";
const HEADLESS = has("--headless") || !DISPLAY;
if (!HEADLESS && FORBIDDEN_DISPLAY.test(DISPLAY)) {
  console.error(`REFUSED: DISPLAY ${DISPLAY} is reserved (ViewPoint). Use --headless or another display.`);
  process.exit(2);
}
const BASE_ENV = { ...process.env };
if (HEADLESS) delete BASE_ENV.DISPLAY; // headless children never see a display (in particular :98)
const PORT_ARG = opt("--port", null);
if (PORT_ARG !== null && Number(PORT_ARG) === FORBIDDEN_PORT) { console.error(`REFUSED: port ${FORBIDDEN_PORT}`); process.exit(2); }
const KEEP = has("--keep");

const P = {
  profile: join(DIR, "profile"), keys: join(DIR, "keys"), logs: join(DIR, "logs"), shots: join(DIR, "shots"),
  ext: join(DIR, "ext"), check: join(DIR, "check"), vpRuns: join(DIR, "vp_runs"),
  config: join(DIR, "tasklight.config.json"), pids: join(DIR, "logs", "tasklight_pids.json"),
};
if (under(P.profile, path.join(os.homedir(), ".config"))) throw new Error("refusing profile under ~/.config");
for (const k of ["profile", "keys", "logs", "shots", "ext", "check", "vpRuns"]) mkdirSync(P[k], { recursive: true });

const CW_HOME = path.resolve(opt("--cw-home",
  MODE === "viewpoint" ? (process.env.CW_HOME || path.join(os.homedir(), ".context-wall")) : join(DIR, "cwhome")));

const started = []; // {name, pid, start}
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ` + a.join(" ");
  console.log(line);
  writeFileSync(join(P.logs, "run_tasklight.log"), line + "\n", { flag: "a" });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  for (;;) {
    const p = await new Promise((res, rej) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => { const q = s.address().port; s.close(() => res(q)); });
      s.on("error", rej);
    });
    if (p !== FORBIDDEN_PORT) return p;
  }
};
const portFree = (p) => new Promise((res) => {
  const s = createServer();
  s.once("error", () => res(false));
  s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
});
const procStart = (pid) => {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return null; }
};

function startProc(name, cmd, argv, extra = {}) {
  const out = openSync(join(P.logs, name + ".log"), "a");
  const ch = spawn(cmd, argv, { stdio: ["ignore", out, out], detached: true, env: BASE_ENV, ...extra });
  started.push({ name, pid: ch.pid, start: procStart(ch.pid) });
  writeFileSync(P.pids, JSON.stringify({ dir: DIR, procs: started }, null, 2) + "\n");
  log(`started ${name} pid=${ch.pid}`);
  return ch;
}
const alive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
async function stopList(list) {
  for (const { name, pid } of [...list].reverse()) {
    try { process.kill(-pid, "SIGTERM"); log(`stopped ${name} pgid=${pid}`); } catch (e) { log(`stop ${name} pgid=${pid}: ${e.code}`); }
  }
  await sleep(1500);
  for (const { name, pid } of list) if (alive(pid)) { try { process.kill(-pid, "SIGKILL"); log(`killed ${name} pgid=${pid}`); } catch { /* gone */ } }
}

function py(argv, env = {}) {
  return execFileSync("python3", argv, {
    cwd: REPO, encoding: "utf8", env: { ...BASE_ENV, PYTHONPATH: REPO, CW_HOME, ...env },
  });
}
function roomEvents(room) {
  try {
    const j = JSON.parse(py(["-m", "bridge.room", "read", "--room", room, "--json"]));
    return Array.isArray(j.events) ? j.events : [];
  } catch { return []; }
}

// ---------- minimal CDP client (node >= 22 global WebSocket), as in run_demo.mjs ----------
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else for (const h of this.handlers) h(msg);
    };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("CDP timeout " + method)); } }, 20000);
    });
  }
}

function extensionId() {
  const f = join(P.keys, "ext_id.txt");
  if (!existsSync(f) || !existsSync(join(P.keys, "demo_pub.b64"))) {
    // fresh RSA-2048 key pair; private key stays in keys/ (0600), never printed
    execFileSync("sh", ["-c", "umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out demo_key.pem 2>/dev/null && openssl pkey -in demo_key.pem -pubout -outform DER -out demo_pub.der"], { cwd: P.keys });
    execFileSync("python3", ["-c", `
import base64,hashlib
d=open('demo_pub.der','rb').read()
open('demo_pub.b64','w').write(base64.b64encode(d).decode())
h=hashlib.sha256(d).hexdigest()[:32]
open('ext_id.txt','w').write(''.join(chr(97+int(c,16)) for c in h))`], { cwd: P.keys });
  }
  return readFileSync(f, "utf8").trim();
}

function mcpInitialize() {
  return new Promise((resolve) => {
    const ch = spawn("python3", ["-m", "bridge.room.mcp"], {
      cwd: REPO, env: { ...BASE_ENV, PYTHONPATH: REPO, CW_HOME: join(P.check, "cwhome") }, stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "";
    const done = (r) => { clearTimeout(timer); try { ch.kill("SIGTERM"); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => done({ ok: false, detail: "no answer in 8 s" }), 8000);
    ch.on("error", (e) => done({ ok: false, detail: e.message }));
    ch.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n").filter((l) => l.trim());
      if (lines.length < 2) return;
      try {
        const init = JSON.parse(lines[0]); const list = JSON.parse(lines[1]);
        const name = init.result?.serverInfo?.name;
        const tools = (list.result?.tools ?? []).map((t) => t.name);
        const need = ["post_plan", "post_step", "post_status"];
        const ok = name === "context-wall" && need.every((t) => tools.includes(t));
        done({ ok, detail: `${name ?? "?"} ${init.result?.serverInfo?.version ?? ""}; tools ${tools.join(",")}` });
      } catch (e) { done({ ok: false, detail: "bad JSON-RPC: " + e.message }); }
    });
    ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tasklight-check", version: "0" } } }) + "\n");
    ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

async function readiness(vitePort) {
  const rows = [];
  const row = (item, ok, detail, warn = false) => rows.push({ item, status: ok ? "OK" : warn ? "WARN" : "FAIL", detail });
  const sub = (cmd, argv, extra = {}) => spawnSync(cmd, argv, { cwd: REPO, encoding: "utf8", timeout: 20000, env: { ...BASE_ENV, PYTHONPATH: REPO, CW_HOME: join(P.check, "cwhome") }, ...extra });

  row("display", HEADLESS || !FORBIDDEN_DISPLAY.test(DISPLAY), HEADLESS ? "headless (DISPLAY removed for children)" : `DISPLAY=${DISPLAY}`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  row("node", nodeMajor >= 22, `v${process.versions.node} (needs >= 22 for global WebSocket)`);
  if (existsSync(CHROME)) {
    const v = sub(CHROME, ["--version"]);
    row("chrome", v.status === 0, (v.stdout || v.stderr || "").trim() + " (throwaway profile " + P.profile + ")");
  } else row("chrome", false, `${CHROME} missing`);
  const viteBin = join(REPO, "node_modules/vite/bin/vite.js");
  const pFree = vitePort !== FORBIDDEN_PORT && await portFree(vitePort);
  row("vite port", existsSync(viteBin) && pFree, `${existsSync(viteBin) ? "vite installed" : "node_modules/vite missing"}; 127.0.0.1:${vitePort} ${pFree ? "free" : "busy/refused"}`);
  let extId = null;
  try { extId = extensionId(); } catch (e) { /* reported below */ }
  row("extension id", !!extId && /^[a-p]{32}$/.test(extId) && existsSync(join(REPO, "extension/build.mjs")), extId ? `${extId} (demo key in ${P.keys})` : "key generation failed");

  // native host manifest + wall config into the throwaway profile (rooms viewpoint + demo)
  if (extId) {
    const s = sub("python3", ["tools/demo/setup_native.py", "--profile", P.profile, "--ext-id", extId, "--cw-home", CW_HOME,
      "--config-out", P.config, ...ROOMS.flatMap((r) => ["--room", r]), "--tier", "private", "--log", join(P.logs, "native_host.stderr.log")]);
    let ok = false, detail = (s.stderr || "").trim().slice(0, 160);
    try {
      const out = JSON.parse(s.stdout);
      const m = JSON.parse(readFileSync(out.manifest, "utf8"));
      const cfg = JSON.parse(readFileSync(out.config, "utf8"));
      const allow = (cfg.rooms?.allow ?? []).map((r) => r.room);
      let exe = false;
      try { accessSync(m.path, constants.X_OK); exe = true; } catch { /* not executable */ }
      ok = m.allowed_origins?.includes(`chrome-extension://${extId}/`) && exe && ROOMS.every((r) => allow.includes(r));
      detail = `${out.manifest}; rooms.allow=[${allow.join(",")}]; launcher ${exe ? "executable" : "NOT executable"}`;
    } catch (e) { detail = detail || e.message; }
    row("native host manifest", ok, detail);
  } else row("native host manifest", false, "no extension id");
  row("CW_HOME", true, `${CW_HOME} (${MODE === "viewpoint" ? "shared with Antigravity context-wall MCP" : "throwaway"})`);

  // U40 observer: import + construct + poll on an EMPTY temp root (never the real runs root)
  const emptyRoot = mkdtempSync(join(P.check, "vp_empty-"));
  const o = sub("python3", ["-c", [
    "import sys, json",
    "from bridge.viewpoint.observer import ViewpointObserver",
    `o = ViewpointObserver(${JSON.stringify(emptyRoot)}, room="viewpoint", home=${JSON.stringify(join(P.check, "cwhome"))})`,
    "n = o.poll()",
    "print(json.dumps({'posted': n, 'stats': o.stats()}, default=str))",
  ].join("\n")]);
  const oerr = (o.stderr || "").trim().split("\n").pop() ?? "";
  row("observer importable", o.status === 0, o.status === 0 ? (o.stdout || "").trim().slice(0, 160) : `rc ${o.status}: ${oerr.slice(0, 160)}`);
  const c = sub("python3", ["-m", "bridge.viewpoint", "watch", "--root", emptyRoot, "--room", "viewpoint", "--once"]);
  row("observer CLI --once", c.status === 0, `rc ${c.status}${c.status === 99 ? " (U40 stub)" : ""}`);

  // replay writer: --once into a temp root, and refusal of the real runs root (pure string check, nothing read there)
  const rr = mkdtempSync(join(P.check, "vp_replay-"));
  const r1 = sub("python3", ["tools/demo/vp_replay.py", "--root", rr, "--once", "--quiet", "--seed", "1"]);
  const r2 = sub("python3", ["tools/demo/vp_replay.py", "--root", FORBIDDEN_ROOT + "/vp-mwrun/metaviewer/runs", "--once", "--quiet"]);
  let nRuns = 0;
  try { nRuns = readdirCount(rr); } catch { /* none */ }
  row("replay writer", r1.status === 0 && nRuns === 4 && r2.status === 3, `--once rc ${r1.status}, ${nRuns} runs; real-root refusal rc ${r2.status}`);

  const mcp = await mcpInitialize();
  row("MCP context-wall initialize", mcp.ok, mcp.detail);
  return { rows, extId };
}
function readdirCount(d) {
  return spawnSync("find", [d, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
}
function printTable(rows) {
  const w = Math.max(...rows.map((r) => r.item.length));
  console.log(`\n| ${"check".padEnd(w)} | state | detail`);
  console.log(`|${"-".repeat(w + 2)}|-------|-------`);
  for (const r of rows) console.log(`| ${r.item.padEnd(w)} | ${r.status.padEnd(5)} | ${r.detail}`);
  console.log("");
  writeFileSync(join(P.logs, "tasklight_check.json"), JSON.stringify(rows, null, 2) + "\n");
}

// ---------------------------------------------------------------- modes
async function modeStop() {
  if (!existsSync(P.pids)) { log("nothing to stop (no " + P.pids + ")"); return 0; }
  const j = JSON.parse(readFileSync(P.pids, "utf8"));
  const mine = (j.procs ?? []).filter((p) => p.start && procStart(p.pid) === p.start); // same pid AND same start time
  log(`stopping ${mine.length}/${(j.procs ?? []).length} recorded process groups (others already gone or pid reused)`);
  await stopList(mine);
  rmSync(P.pids, { force: true });
  return 0;
}

let stopRequested = false;
let wake = null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopRequested = true; if (wake) wake(); });
const waitUntilStopped = (ms = Infinity) => new Promise((res) => {
  wake = res;
  if (stopRequested) res();
  if (Number.isFinite(ms)) setTimeout(res, ms);
});

async function modeRun() {
  const vitePort = PORT_ARG !== null ? Number(PORT_ARG) : await freePort();
  const { rows, extId } = await readiness(vitePort);
  printTable(rows);
  if (MODE === "check") return rows.some((r) => r.status === "FAIL") ? 1 : 0;
  if (rows.some((r) => r.status === "FAIL")) { log("readiness FAILED: not starting (see table)"); return 1; }

  // runs root
  let root = opt("--root", null);
  if (MODE === "replay") {
    root = root ? path.resolve(root) : mkdtempSync(join(P.vpRuns, "replay-"));
    if (under(root, FORBIDDEN_ROOT)) { log(`REFUSED replay root under ${FORBIDDEN_ROOT}`); return 2; }
    if (under(CW_HOME, DIR)) { // throwaway home only: fresh viewpoint room + observer cursor
      rmSync(join(CW_HOME, "rooms", ROOM), { recursive: true, force: true });
      rmSync(join(CW_HOME, "observers", "viewpoint.json"), { force: true });
    }
  }
  log(`mode=${MODE} headless=${HEADLESS} CW_HOME=${CW_HOME} root=${root ?? "(observer default, read-only)"} ext=${extId}`);

  // 1. build extension (built manifest copy carries the demo public key), unless --ext-dir names a prebuilt one
  const extDir = opt("--ext-dir", null);
  if (extDir) {
    P.ext = path.resolve(extDir);
    if (!existsSync(join(P.ext, "manifest.json"))) throw new Error(`--ext-dir ${P.ext} has no manifest.json`);
    log(`using prebuilt extension ${P.ext} (must be built with --key-file ${join(P.keys, "demo_pub.b64")})`);
  } else {
    log(execFileSync("node", ["extension/build.mjs", "--manifest", "dev", "--key-file", join(P.keys, "demo_pub.b64"), "--out", P.ext], { cwd: REPO, encoding: "utf8", env: BASE_ENV }).trim());
  }

  // 2. wall page (vite dev on 127.0.0.1, browsed as http://localhost:<port> to match externally_connectable)
  startProc("vite", process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "--config", "tools/demo/vite.demo.config.ts",
    "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: REPO, env: { ...BASE_ENV, VITE_EXTENSION_ORIGINS: `chrome-extension://${extId}` },
  });
  const wallUrl = `http://localhost:${vitePort}/`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(wallUrl)).ok; } catch { await sleep(250); } }
  if (!up) throw new Error("vite never answered on " + wallUrl);

  // 3. Chrome with the throwaway profile + CDP
  const cdpPort = await freePort();
  const chromeArgs = [`--user-data-dir=${P.profile}`, `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*",
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--password-store=basic", "--window-size=1440,900", "about:blank"];
  if (HEADLESS) chromeArgs.unshift("--headless=new");
  startProc("chrome", CHROME, chromeArgs, { env: { ...BASE_ENV, CW_HOME } });
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); }
  }
  if (!wsUrl) throw new Error("CDP endpoint never came up");
  const cdp = new Cdp(wsUrl);
  await cdp.open();
  const consoleOut = join(P.logs, "tasklight_page_console.log");
  cdp.handlers.push((m) => {
    if (m.method === "Runtime.consoleAPICalled") writeFileSync(consoleOut, `${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}\n`, { flag: "a" });
    if (m.method === "Runtime.exceptionThrown") writeFileSync(consoleOut, `EXCEPTION: ${JSON.stringify(m.params.exceptionDetails).slice(0, 600)}\n`, { flag: "a" });
  });
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: P.ext });
  if (loaded.id !== extId) throw new Error(`loaded id ${loaded.id} != computed ${extId}`);
  log(`extension loaded ${loaded.id}`);
  await sleep(1500);

  // 4. open the wall page (and drop the initial about:blank tab)
  const before = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page" && t.url === "about:blank");
  const { targetId } = await cdp.send("Target.createTarget", { url: wallUrl });
  for (const t of before) await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Page.enable", {}, S);
  if (HEADLESS) await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  const evalJs = async (expr) => (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S)).result.value;
  const waitFor = async (expr, label, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !stopRequested) {
      if (await evalJs(expr)) { log(`ok: ${label} (${Date.now() - t0} ms)`); return true; }
      await sleep(250);
    }
    log(`TIMEOUT: ${label}`);
    return false;
  };
  const shot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, S);
    writeFileSync(join(P.shots, name), Buffer.from(data, "base64"));
    log(`screenshot ${join(P.shots, name)}`);
  };
  await waitFor("!!document.querySelector('h1, h2')", "wall page rendered");
  await sleep(1500); // T1 port link + first room_hello/room_sync before anything is posted (history is not replayed)

  // 5. U40 observer
  const watchArgs = ["-m", "bridge.viewpoint", "watch", "--room", ROOM, "--interval", "0.5"];
  if (root) watchArgs.push("--root", root);
  if (MODE === "viewpoint" && !has("--history")) watchArgs.push("--prime"); // do not repaint old real runs
  const watcher = startProc("observer", "python3", watchArgs, { cwd: REPO, env: { ...BASE_ENV, PYTHONPATH: REPO, CW_HOME } });
  let watcherExit = null;
  watcher.on("exit", (code) => { watcherExit = code; log(`observer exited rc=${code}`); });
  await sleep(1000);
  if (watcherExit !== null) throw new Error(`observer exited early rc=${watcherExit} (see ${join(P.logs, "observer.log")})`);

  if (MODE === "viewpoint") {
    log(`watching the real ViewPoint runs root read-only; room "${ROOM}" in CW_HOME=${CW_HOME}; wall ${wallUrl}`);
    if (HEADLESS) await waitUntilStopped(Number(opt("--duration", "5")) * 1000);
    else { log("Ctrl-C to stop"); await waitUntilStopped(); }
    await shot("viewpoint.png").catch(() => {});
    cdp.ws.close();
    return watcherExit === null ? 0 : 1;
  }

  // 6. replay: 4 synthetic runs into the temp root
  const speed = opt("--speed", "1");
  const replay = startProc("replay", "python3", ["tools/demo/vp_replay.py", "--root", root, "--speed", speed], { cwd: REPO });
  const replayRc = await new Promise((res) => {
    replay.on("exit", (c) => res(c));
    setTimeout(() => shot("replay_mid.png").catch(() => {}), 12000 / Number(speed));
  });
  log(`replay exited rc=${replayRc}`);

  // 7. verify: room events (4 capsule-agent tasks, >= 3 steps, closed) and the wall text (4 goals)
  let summary = null;
  for (let i = 0; i < 60 && !stopRequested; i++) {
    const evs = roomEvents(ROOM);
    const agents = {};
    for (const e of evs) {
      if (typeof e.agent !== "string" || !AGENT_SLUG_RE.test(e.agent)) continue;
      const a = (agents[e.agent] ??= { title: null, steps: 0, done: 0, blocked: 0, closed: null });
      if (e.act === "plan" && e.plan) { a.title = e.plan.title; a.steps = e.plan.steps.length; }
      if (e.act === "step" && e.step?.state === "done") a.done++;
      if (e.act === "step" && e.step?.state === "blocked") a.blocked++;
      if (e.act === "close") a.closed = e.text;
    }
    const tasks = Object.entries(agents);
    summary = { root, events: evs.length, tasks: agents };
    if (tasks.length >= 4 && tasks.every(([, a]) => a.closed && a.steps >= 3)) break;
    await sleep(500);
  }
  const tasks = Object.values(summary?.tasks ?? {});
  const roomOk = tasks.length === 4 && tasks.every((a) => a.closed && a.steps >= 3) &&
    EXPECT.every((x) => summary?.tasks?.[x.agent]?.title === x.title);
  let wallOk = true;
  for (const g of GOALS) wallOk = (await waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(g)})`, `wall shows "${g}"`, 10000)) && wallOk;
  await sleep(800);
  // U42: human card summaries, no "Waiting for a plan" on closed tasks, chat drawer closed by default.
  const ui = await evalJs(`(() => {
    const cards = [...document.querySelectorAll("article.task")];
    return {
      summaries: cards.map((c) => (c.querySelector(".task-summary")?.textContent ?? "").trim()),
      next: cards.map((c) => (c.querySelector(".next-text")?.textContent ?? "").trim()),
      drawer: document.querySelector(".chat-drawer")?.getAttribute("data-open") ?? null,
      bootButtons: document.querySelectorAll("button.boot-btn").length,
      running: (document.querySelector(".rail-heading-meta")?.textContent ?? "").trim(),
    };
  })()`).catch(() => null);
  const uiOk = ui !== null && ui.drawer !== "true" && ui.summaries.length === 4 &&
    ui.summaries.every((t) => !/\(rc -?\d+\)/.test(t)) && ui.next.every((t) => t !== "Waiting for a plan");
  log("UI " + JSON.stringify(ui));
  await shot("replay.png");
  summary = { ...summary, replayRc, roomOk, wallOk, uiOk, ui, wallUrl, shot: join(P.shots, "replay.png") };
  writeFileSync(join(P.logs, "tasklight_summary.json"), JSON.stringify(summary, null, 2) + "\n");
  log("SUMMARY " + JSON.stringify({ replayRc, roomOk, wallOk, uiOk, tasks: tasks.map((a) => `${a.title}: ${a.done}/${a.steps} done, ${a.blocked} blocked, ${a.closed}`) }));
  if (!HEADLESS && !has("--exit")) { log("replay finished; wall stays up. Ctrl-C to stop"); await waitUntilStopped(); }
  cdp.ws.close();
  return replayRc === 0 && roomOk && wallOk && uiOk ? 0 : 1;
}

let rc = 1;
try {
  rc = MODE === "stop" ? await modeStop() : await modeRun();
} catch (e) {
  log("ERROR " + (e && e.stack ? e.stack : String(e)));
} finally {
  if (started.length) {
    if (KEEP) log(`--keep: leaving processes up (stop with: node tools/demo/run_tasklight.mjs --stop --dir ${DIR})`);
    else { await stopList(started); rmSync(P.pids, { force: true }); }
  }
}
process.exit(rc);
