// Context Wall LOCAL end-to-end demo (no Firebase project).
//
//   node tools/demo/run_demo.mjs [--dir <path>]  (default: $TASKLIGHT_DEMO_DIR or <os tmpdir>/tasklight-demo) [--headless] [--keep] [--no-mcp]
//
// room events.jsonl -> bridge.wall native host -> extension SW -> hosted wall page (vite dev)
// and back: wall chat -> SW -> native host -> room `question` event.
// Everything lives under --dir (throwaway profile, CW_HOME, key pair, logs, shots).
// Only processes started here are stopped (their own process groups); --keep leaves them up.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromeCandidates, summaryExitCode } from "./demo_lib.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const DIR = opt("--dir", process.env.TASKLIGHT_DEMO_DIR ?? path.join(os.tmpdir(), "tasklight-demo"));
const HEADLESS = args.includes("--headless") || !process.env.DISPLAY;
const KEEP = args.includes("--keep");
const NO_MCP = args.includes("--no-mcp");
const DRIFT_LABEL = "Rules";
const ROOM = "demo";
const AGENT = "claude-code";

function findChrome() {
  const candidates = chromeCandidates(process.platform, process.env);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const CHROME = findChrome();
if (!CHROME) throw new Error("Chrome/Chromium browser not found: set CHROME or install google-chrome/chromium on PATH");

const P = {
  profile: join(DIR, "profile"), cwhome: join(DIR, "cwhome"), keys: join(DIR, "keys"),
  logs: join(DIR, "logs"), shots: join(DIR, "shots"), ext: join(DIR, "ext"),
  config: join(DIR, "wall.config.json"), plans: join(DIR, "plans"),
};
if (P.profile.includes("/.config/")) throw new Error("refusing profile under ~/.config");
for (const d of Object.values(P)) if (!d.endsWith(".json")) mkdirSync(d, { recursive: true });

const started = []; // {name, pid}
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ` + a.join(" ");
  console.log(line);
  writeFileSync(join(P.logs, "run_demo.log"), line + "\n", { flag: "a" });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });

function startProc(name, cmd, argv, extra = {}) {
  const out = openSync(join(P.logs, name + ".log"), "a");
  const ch = spawn(cmd, argv, { stdio: ["ignore", out, out], detached: true, ...extra });
  started.push({ name, pid: ch.pid });
  writeFileSync(join(P.logs, "pids.json"), JSON.stringify(started, null, 2) + "\n");
  log(`started ${name} pid=${ch.pid}`);
  return ch;
}
function stopAll() {
  for (const { name, pid } of [...started].reverse()) {
    try {
      process.kill(-pid, "SIGTERM"); // own process group (detached)
      log(`stopped ${name} pgid=${pid}`);
    } catch (e) {
      log(`stop ${name} pgid=${pid}: ${e.code}`);
    }
  }
}


async function waitForVite(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      // Bound both the connection and response body, even for a stalled server.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))),
        redirect: "error",
      });
      const html = await response.text();
      if (response.status === 200 && html.includes('<title>TaskLight</title>') && html.includes('id="wall"')) return;
    } catch { /* retry until the readiness deadline */ }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  let tail;
  try {
    tail = readFileSync(join(P.logs, "vite.log"), "utf8").trimEnd().split("\n").slice(-20).join("\n");
  } catch (e) {
    tail = `Unable to read logs/vite.log: ${e.message}`;
  }
  throw new Error(`Vite did not serve the TaskLight index within 15000 ms. Last lines of logs/vite.log:\n${tail}`);
}

function py(argv, env = {}) {
  return execFileSync("python3", argv, {
    cwd: REPO, encoding: "utf8", env: { ...process.env, CW_HOME: P.cwhome, ...env },
  });
}
function roomPost(act, text, extra = []) {
  const out = py(["-m", "bridge.room", "post", "--room", ROOM, "--agent", AGENT, "--act", act, "--text", text, ...extra]);
  log(`room post ${act}: ${out.trim().slice(0, 200)}`);
  const j = JSON.parse(out);
  if (!j.ok) throw new Error("room post failed: " + out);
  return j.event;
}

// ---------- minimal CDP client (node >= 22 global WebSocket) ----------
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
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("CDP timeout " + method));
        }
      }, 20000);
    });
  }
}

async function main() {
  const extId = (() => {
    const f = join(P.keys, "ext_id.txt");
    if (!existsSync(f) || !existsSync(join(P.keys, "demo_pub.b64"))) {
      // fresh RSA-2048 key pair; private key stays in keys/ (0600), never printed
      execFileSync("sh", ["-c", `umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out demo_key.pem 2>/dev/null && openssl pkey -in demo_key.pem -pubout -outform DER -out demo_pub.der`], { cwd: P.keys });
      execFileSync("python3", ["-c", `
import base64,hashlib
d=open('demo_pub.der','rb').read()
open('demo_pub.b64','w').write(base64.b64encode(d).decode())
h=hashlib.sha256(d).hexdigest()[:32]
open('ext_id.txt','w').write(''.join(chr(97+int(c,16)) for c in h))`], { cwd: P.keys });
    }
    return readFileSync(f, "utf8").trim();
  })();
  log(`extension id ${extId} (headless=${HEADLESS})`);

  // 1. build extension (built manifest copy carries the demo public key)
  log(execFileSync("node", ["extension/build.mjs", "--manifest", "dev", "--key-file", join(P.keys, "demo_pub.b64"), "--out", P.ext], { cwd: REPO, encoding: "utf8" }).trim());

  // 2. native host manifest + launcher + wall config (throwaway profile only)
  log(py(["tools/demo/setup_native.py", "--profile", P.profile, "--ext-id", extId, "--cw-home", P.cwhome,
    "--config-out", P.config, "--room", ROOM, "--tier", "private", "--log", join(P.logs, "native_host.stderr.log")]).trim());

  // 3. fresh room + plan v1 (before the host starts, so the room directory exists)
  rmSync(join(P.cwhome, "rooms", ROOM), { recursive: true, force: true });
  const planV1 = { title: "Add CSV export to reports", steps: [
    { text: "Read the report module", accept: "entry points listed" },
    { text: "Add CSV writer with header row", accept: "unit test passes" },
    { text: "Wire export button", accept: "button downloads file" },
  ] };
  const driftPlanV2 = { title: "Add CSV export to reports", steps: [
    { text: "Rewrite the report module in Rust", accept: "old module deleted" },
    { text: "Add CSV writer with header row", accept: "unit test passes" },
    { text: "Wire export button", accept: "button downloads file" },
  ] };
  writeFileSync(join(P.plans, "plan_v1.json"), JSON.stringify(planV1));
  writeFileSync(join(P.plans, "plan_v2.json"), JSON.stringify(driftPlanV2));
  // Only `open` is posted before the page exists: the room directory must exist for the host
  // (room_post refuses rooms without a directory). Plan v1 is posted live, after the page links:
  // a fresh page sends room_sync with since={} (store.since() knows no rooms yet), so history
  // posted before the page opened is never replayed (see README_DEMO.md, "Known gaps").
  roomPost("open", "Starting CSV export task");

  // 4. wall page (vite dev, 127.0.0.1; browsed as http://localhost:<port> to match externally_connectable)
  const vitePort = await freePort();
  startProc("vite", process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "--config", "tools/demo/vite.demo.config.ts",
    "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: REPO, env: { ...process.env, VITE_EXTENSION_ORIGINS: `chrome-extension://${extId}` },
  });
  const wallUrl = `http://localhost:${vitePort}/`;
  await waitForVite(wallUrl);

  // 5. Chrome with throwaway profile + CDP
  const cdpPort = await freePort();
  const chromeArgs = [`--user-data-dir=${P.profile}`, `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*",
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--password-store=basic", "--window-size=1280,900", "about:blank"];
  if (HEADLESS) chromeArgs.unshift("--headless=new");
  startProc("chrome", CHROME, chromeArgs, { env: { ...process.env, CW_HOME: P.cwhome } });
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); }
  }
  if (!wsUrl) throw new Error("CDP endpoint never came up");
  const cdp = new Cdp(wsUrl);
  await cdp.open();
  const consoleOut = join(P.logs, "page_console.log");
  cdp.handlers.push((m) => {
    if (m.method === "Runtime.consoleAPICalled") writeFileSync(consoleOut, `${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}\n`, { flag: "a" });
    if (m.method === "Runtime.exceptionThrown") writeFileSync(consoleOut, `EXCEPTION: ${JSON.stringify(m.params.exceptionDetails).slice(0, 600)}\n`, { flag: "a" });
    if (m.method === "Log.entryAdded") writeFileSync(consoleOut, `log/${m.params.entry.level}: ${m.params.entry.text}\n`, { flag: "a" });
  });

  let loaded;
  try {
    loaded = await cdp.send("Extensions.loadUnpacked", { path: P.ext });
  } catch (e) {
    log("Extensions.loadUnpacked FAILED: " + e.message);
    throw e;
  }
  log(`Extensions.loadUnpacked -> ${JSON.stringify(loaded)}`);
  if (loaded.id !== extId) throw new Error(`loaded id ${loaded.id} != computed ${extId}`);
  await sleep(1500);
  const targets = (await cdp.send("Target.getTargets")).targetInfos;
  log("targets: " + targets.map((t) => `${t.type}:${t.url}`).join(" | "));

  // 6. open the wall page
  const { targetId } = await cdp.send("Target.createTarget", { url: wallUrl });
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Log.enable", {}, S);
  await cdp.send("Page.enable", {}, S);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  const evalJs = async (expr) => (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S)).result.value;
  const waitFor = async (expr, label, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
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
  const bodyHas = (s) => `document.body && document.body.innerText.includes(${JSON.stringify(s)})`;

  const results = {};
  if (!await waitFor(`document.title === "TaskLight" && !!document.querySelector('#wall')`, "wall page rendered")) {
    throw new Error("TaskLight wall page did not render");
  }
  await sleep(1500); // let the T1 port link and the first room_hello / room_sync pass
  roomPost("plan", "Plan v1 for CSV export", ["--plan-file", join(P.plans, "plan_v1.json")]);
  results.plan = await waitFor(bodyHas(planV1.steps[0].text), "plan v1 task rendered");
  await sleep(500);
  await shot("1_plan.png");

  // 7. step 0 active, then plan v2 that edits the active step -> drift
  roomPost("step", "Started reading the report module", ["--step-json", JSON.stringify({ index: 0, state: "active" })]);
  await sleep(1200);
  roomPost("plan", "Plan v2 for CSV export", ["--plan-file", join(P.plans, "plan_v2.json")]);
  results.drift = await waitFor(bodyHas(DRIFT_LABEL), `drift banner '${DRIFT_LABEL}'`);
  await sleep(500);
  await shot("2_drift.png");

  // 8. chat: open the task Chat drawer first, then type + send through CDP Input events
  const chatOpen = await evalJs(`(() => { const b = document.querySelector('button.task-chat'); if (!b) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
  if (chatOpen) {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: chatOpen.x, y: chatOpen.y, button: "left", clickCount: 1 }, S);
  } else log("task Chat button not found");
  await sleep(500);
  const box = await evalJs(`(() => { const t = document.querySelector('textarea.chat-input'); if (!t) return null; t.scrollIntoView({block:'center'}); const r = t.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
  const msg = "Why are you rewriting the module in Rust? Please keep Python.";
  if (box) {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, S);
    await cdp.send("Input.insertText", { text: msg }, S);
    await sleep(300);
    log(`textarea before send: ${JSON.stringify(await evalJs("document.querySelector('textarea.chat-input').value"))}`);
    const send = await evalJs(`(() => { const b = document.querySelector('button.chat-send'); if (!b) return null; const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, disabled: b.disabled}; })()`);
    log(`send button ${JSON.stringify(send)}`);
    if (send) for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: send.x, y: send.y, button: "left", clickCount: 1 }, S);
  } else log("chat textarea not found");
  let q = null;
  for (let i = 0; i < 40 && !q; i++) {
    await sleep(250);
    const evs = JSON.parse(py(["-m", "bridge.room", "read", "--room", ROOM, "--json"])).events;
    q = evs.find((e) => e.act === "question" && e.text === msg) ?? null;
  }
  results.question = q;
  log(`room question: ${q ? JSON.stringify(q) : "NOT FOUND"}`);
  await waitFor(bodyHas(msg), "question echoed in chat log", 5000);
  await shot("3_chat.png");
  writeFileSync(join(P.logs, "room_events.json"), py(["-m", "bridge.room", "read", "--room", ROOM, "--json"]));

  // 9. MCP v2 planning (skip with --no-mcp): plan_create, task_claim, microtask_set, memory_set
  let planV2 = false;
  let memory = false;
  if (NO_MCP) {
    log("MCP step skipped (--no-mcp)");
    planV2 = true;
    memory = true;
  } else {
    const mcp = spawn("python3", ["-m", "bridge.room.mcp"], {
      cwd: REPO,
      env: { ...process.env, PYTHONPATH: REPO, CW_HOME: P.cwhome },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let nextId = 1;
    let buf = "";
    const pending = new Map();
    mcp.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id && pending.has(resp.id)) {
            const { res, rej } = pending.get(resp.id);
            pending.delete(resp.id);
            if (resp.error) rej(new Error(JSON.stringify(resp.error)));
            else res(resp.result);
          }
        } catch { /* ignore partial */ }
      }
    });
    const mcpCall = (name, arguments_) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } }) + "\n");
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("MCP timeout " + name)); } }, 10000);
    });
    try {
      const initId = nextId++;
      await new Promise((res, rej) => {
        pending.set(initId, { res, rej });
        mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-demo", version: "0" } } }) + "\n");
      });
      const planTitle = "Add CSV export via MCP";
      const created = await mcpCall("plan_create", {
        room: ROOM, agent: AGENT, template_id: "web-app", title: planTitle,
        brief: { goal: planTitle, users: "report readers", stack: "python + vite" },
        tasks: [
          { key: "t1", title: "Read report module", type: "feature", phase: "discovery", accept: "entry points listed" },
          { key: "t2", title: "Add CSV writer", type: "feature", phase: "build", accept: "unit test passes" },
          { key: "t3", title: "Wire export button", type: "ui", phase: "verify", accept: "button downloads file" },
        ],
      });
      log("plan_create -> " + JSON.stringify(created).slice(0, 300));
      const payloadOf = (result) => {
        const text = result?.content?.[0]?.text;
        if (!text) return result;
        try { return JSON.parse(text); } catch { return result; }
      };
      const createPayload = payloadOf(created);
      const ids = createPayload?.ids ?? {};
      const firstTaskId = ids["t1"] ?? "t1";
      await mcpCall("task_claim", { room: ROOM, agent: AGENT, task_id: firstTaskId, base_rev: 1 });
      // Find a real micro id via plan_get, then mark it done.
      let microId = "m1";
      try {
        const got = await mcpCall("plan_get", { room: ROOM });
        const planPayload = payloadOf(got);
        const tasks = planPayload?.plan?.tasks ?? planPayload?.tasks ?? [];
        const firstMicro = (tasks[0]?.microtasks ?? planPayload?.tasks?.[0]?.microtasks)?.[0];
        if (firstMicro?.id) microId = firstMicro.id;
      } catch { /* fall back to m1 */ }
      await mcpCall("microtask_set", { room: ROOM, agent: AGENT, id: microId, state: "done" });
      await mcpCall("memory_set", { room: ROOM, agent: AGENT, section: "architecture", text: "CSV export: report module -> csv writer -> button download.", base_rev: 1 });
      results.planV2 = await waitFor(bodyHas(planTitle), "MCP plan title rendered", 15000);
      results.memory = await waitFor(bodyHas("Memory"), "Memory view entry rendered", 15000);
      planV2 = results.planV2;
      memory = results.memory;
      await shot("4_plan_v2.png");
      const memoryTab = await evalJs(`(() => { const b = document.querySelector('[role="tab"][data-nav="memory"]') || Array.from(document.querySelectorAll('button')).find((x) => x.textContent === 'Memory'); if (!b) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
      if (memoryTab) {
        for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: memoryTab.x, y: memoryTab.y, button: "left", clickCount: 1 }, S);
      }
      await sleep(800);
      await shot("5_memory.png");
      log(`MCP planV2=${planV2} memory=${memory}`);
    } catch (e) {
      log("MCP step failed: " + (e && e.stack ? e.stack : String(e)));
      planV2 = false;
      memory = false;
    } finally {
      try { mcp.stdin.end(); } catch { }
      try { mcp.kill("SIGTERM"); } catch { }
    }
  }

  const summary = { extId, wallUrl, plan: results.plan, drift: results.drift,
    question: q ? { agent: q.agent, to: q.to, lamport: q.lamport } : null,
    planV2, memory };
  writeFileSync(join(P.logs, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  log("SUMMARY " + JSON.stringify(summary));
  cdp.ws.close();
  return summaryExitCode(summary, { noMcp: NO_MCP });
}

let rc = 1;
try {
  rc = await main();
} catch (e) {
  log("ERROR " + (e && e.stack ? e.stack : String(e)));
} finally {
  if (KEEP) log("--keep: leaving processes up: " + JSON.stringify(started));
  else {
    stopAll();
    await sleep(1000);
  }
}
process.exit(rc);
