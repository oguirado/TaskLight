// Context Wall LOCAL end-to-end demo (no Firebase project).
//
//   node tools/demo/run_demo.mjs [--dir <path>]  (default: $TASKLIGHT_DEMO_DIR or <os tmpdir>/tasklight-demo) [--headless] [--keep] [--no-mcp]
//
// room events.jsonl -> bridge.wall native host -> extension SW -> hosted wall page (vite dev)
// The browser sends a question through Messages (legacy). MCP drives shared planning.
// Everything lives under --dir (throwaway profile, CW_HOME, key pair, logs, shots).
// Only processes started here are stopped (their own process groups); --keep leaves them up.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromeCandidates, summaryExitCode } from "./demo_lib.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const DIR = path.resolve(opt("--dir", process.env.TASKLIGHT_DEMO_DIR ?? join(os.tmpdir(), "tasklight-demo")));
const HEADLESS = args.includes("--headless") || !process.env.DISPLAY;
const KEEP = args.includes("--keep");
const NO_MCP = args.includes("--no-mcp");
const ROOM = "demo";
const AGENT = "claude-code";
const WALL_USER = "wall-user";
const DRIFT_LABEL = "Rules";

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
  config: join(DIR, "wall.config.json"), plans: join(DIR, "plans"), cache: join(DIR, "vite-cache"),
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

// A parent harness's room or agent pin must not redirect the demo.
const roomEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CW_")));
Object.assign(roomEnv, { CW_HOME: P.cwhome, PYTHONDONTWRITEBYTECODE: "1" });

function py(argv) {
  return execFileSync("python3", argv, { cwd: REPO, encoding: "utf8", env: roomEnv });
}
function roomPost(act, text, extra = []) {
  const out = py(["-m", "bridge.room", "post", "--room", ROOM, "--agent", AGENT, "--act", act, "--text", text, ...extra]);
  log(`room post ${act}: ${out.trim().slice(0, 200)}`);
  const j = JSON.parse(out);
  if (!j.ok) throw new Error("room post failed: " + out);
  return j.event;
}

function toolAnswer(name, answer, isError = false) {
  const payload = answer?.untrusted ?? answer;
  const detail = JSON.stringify(payload)?.slice(0, 250);
  if (isError || answer?.ok === false || payload?.ok === false) {
    const code = payload?.code ?? answer?.code ?? "missing_refusal_code";
    log(`${name} -> refused (${code}): ${detail}`);
    throw new Error(`${name} refused: ${code}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${name} returned an invalid payload`);
  }
  log(`${name} -> ${detail}`);
  return payload;
}

async function withMcp(run) {
  const child = spawn("python3", ["-m", "bridge.room.mcp"], {
    cwd: REPO, env: { ...roomEnv, PYTHONPATH: REPO },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  let pending;
  const fail = (error) => pending?.reject(error);
  child.on("error", fail);
  child.stdin.on("error", fail);
  lines.on("close", () => fail(new Error("MCP closed before replying")));
  lines.on("line", (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch (error) {
      fail(error);
      return;
    }
    if (!pending || reply.id !== pending.id) return;
    if (reply.error) pending.reject(new Error(JSON.stringify(reply.error)));
    else pending.resolve(reply.result);
  });

  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = async (method, params, label = method) => {
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
        timer = setTimeout(() => reject(new Error(`MCP timeout: ${label}`)), 10000);
        send({ id, method, params });
      });
    } catch (error) {
      log(`${label} -> ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
      pending = undefined;
    }
  };
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "run-demo", version: "1" },
    });
    log(`MCP initialize -> ${initialized.serverInfo?.name} ${initialized.protocolVersion}`);
    send({ method: "notifications/initialized" });
    await run(async (name, fields) => {
      const reply = await request("tools/call", {
        name, arguments: { room: ROOM, agent: AGENT, ...fields },
      }, name);
      return toolAnswer(name, JSON.parse(reply.content[0].text), reply.isError);
    });
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
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

  // 3. Fresh room before the host starts. Post the plans after the wall links.
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
  // The native host needs the room directory before the page exists.
  roomPost("open", "Starting CSV export task");

  // 4. wall page (vite dev, 127.0.0.1; browsed as http://localhost:<port> to match externally_connectable)
  const vitePort = await freePort();
  startProc("vite", process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "vite";
    const [port, cacheDir] = process.argv.slice(1);
    const server = await createServer({
      configFile: "tools/demo/vite.demo.config.ts",
      configLoader: "runner",
      cacheDir,
      server: { host: "127.0.0.1", port: Number(port), strictPort: true },
    });
    await server.listen();
    server.printUrls();
  `, String(vitePort), P.cache], {
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
  startProc("chrome", CHROME, chromeArgs, { env: roomEnv });
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
  const visibleText = (selector, text) =>
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(
       (el) => el.checkVisibility() && el.textContent.trim() === ${JSON.stringify(text)})`;
  const requireView = async (expr, label) => {
    if (!await waitFor(expr, label)) throw new Error(`Missing UI evidence: ${label}`);
  };
  const click = async (selector) => {
    const find = `document.querySelector(${JSON.stringify(selector)})`;
    await requireView(`!!(${find}) && !(${find}).disabled`, `control ${selector}`);
    await evalJs(`${find}.click()`);
  };

  const summary = { extId, wallUrl, plan: false, drift: false, question: null, planV2: false, memory: false };
  const readRoom = () => py(["-m", "bridge.room", "read", "--room", ROOM, "--json"]);
  const legacyTitle = `.app[data-view="wall"] .board .task-title`;
  const legacyStep = `.app[data-view="wall"] .board .step-label`;
  const banner = '.chat-drawer[data-open="true"] .chat-banner[data-kind="drift"][data-verdict="drift"]';
  if (!await waitFor(`document.title === "TaskLight" && !!document.querySelector('#wall')`, "wall page rendered")) {
    throw new Error("TaskLight wall page did not render");
  }
  await requireView(visibleText(".workspace-guidance > p", "Bridge connected"), "room bridge connected");
  await click('button[data-nav="wall"]');
  roomPost("plan", "Plan v1 for CSV export", ["--plan-file", join(P.plans, "plan_v1.json")]);
  await requireView(
    `${visibleText(legacyTitle, planV1.title)} && ${visibleText(legacyStep, planV1.steps[0].text)}`,
    "legacy plan title and first step in Wall",
  );
  if (NO_MCP) {
    await shot("1_plan.png");
    summary.plan = true;
  }

  // Let the wall observe the active step before the old plan is replaced.
  roomPost("step", "Started reading the report module", ["--step-json", JSON.stringify({ index: 0, state: "active" })]);
  await requireView(
    visibleText('.app[data-view="wall"] .board .step[data-state="active"] .step-label', planV1.steps[0].text),
    "legacy first step active in Wall",
  );
  const closedMessages = 'button.messages-toggle[aria-expanded="false"]';
  if (await evalJs(`!!document.querySelector(${JSON.stringify(closedMessages)})`)) await click(closedMessages);
  const messagesTask = ".messages-legacy button.messages-task, button.task-chat";
  const legacyTaskButton = `document.querySelector(${JSON.stringify(messagesTask)})`;
  await requireView(`!!(${legacyTaskButton}) && !(${legacyTaskButton}).disabled`, "legacy task messages control");
  await evalJs(`${legacyTaskButton}.click()`);
  await requireView(
    `!document.querySelector(${JSON.stringify(banner)}) && !!document.querySelector('.chat-drawer[data-open="true"]')`,
    "legacy messages open before revision",
  );
  roomPost("plan", "Plan v2 for CSV export", ["--plan-file", join(P.plans, "plan_v2.json")]);
  await requireView(
    `${visibleText(banner + " .drift-removed li", planV1.steps[0].text)} &&
     ${visibleText(banner + " .drift-added li", driftPlanV2.steps[0].text)} &&
     ${visibleText(banner + " .drift-source", "Reviewed by " + DRIFT_LABEL.toLowerCase())}`,
    "legacy drift verdict with removed and replacement steps",
  );
  await shot("2_drift.png");
  summary.drift = true;

  const question = "Why are you rewriting the module in Rust? Please keep Python.";
  const chatInput = ".chat-drawer[data-open=true] textarea.chat-input";
  await requireView(`!!document.querySelector(${JSON.stringify(chatInput)})`, "legacy chat composer");
  await evalJs(`document.querySelector(${JSON.stringify(chatInput)}).focus()`);
  await cdp.send("Input.insertText", { text: question }, S);
  const sendButton = '.chat-drawer[data-open="true"] button.chat-send';
  await requireView(`document.querySelector(${JSON.stringify(sendButton)})?.disabled === false`, "legacy chat Send enabled");
  await evalJs(`document.querySelector(${JSON.stringify(sendButton)}).click()`);
  const outgoing = '.chat-drawer[data-open="true"] .chat-msg[data-from="user"]';
  await requireView(
    `!!document.querySelector(${JSON.stringify(outgoing + '[data-delivery]:not([data-delivery="sending"])')})`,
    "legacy question delivery settled",
  );
  const delivery = await evalJs(`document.querySelector(${JSON.stringify(outgoing + " .chat-delivery")})?.textContent`);
  log(`legacy question -> ${delivery}`);
  const event = JSON.parse(readRoom()).events.find((item) =>
    item.agent === WALL_USER && item.to === AGENT && item.act === "question" && item.text === question);
  if (!event || delivery !== `Delivered · ${event.id} · ${event.lamport}`) {
    throw new Error(`Question delivery did not match a persisted receipt: ${delivery}`);
  }
  await requireView(visibleText(outgoing + '[data-delivery="delivered"] .chat-text', question),
    "persisted question in Messages (legacy)");
  await shot("3_chat.png");
  summary.question = { agent: event.agent, to: event.to, lamport: event.lamport };

  if (NO_MCP) {
    log("MCP skipped (--no-mcp)");
  } else {
    await withMcp(async (call) => {
      const write = (name, fields) => call(name, { ...fields, op_id: randomUUID() });
      await click('.chat-drawer[data-open="true"] button.agent-chat-close');

      const planTitle = "Verify the local TaskLight wall";
      const taskTitle = "Check the TaskLight page entry point";
      const indexCheck = { text: "Verify the hosted HTML title and Wall mount",
        accept: "The source HTML declares the TaskLight title and wall mount" };
      const memoryText = "TaskLight sends room events through the native host and extension to the Wall.";
      // Strict web-app conformance requires these sections before plan_create.
      for (const [section, text] of Object.entries({
        architecture: memoryText,
        decisions: "Use a throwaway browser profile and the development extension.",
        constraints: "Run the demo locally without a Firebase project.",
      })) {
        await write("memory_set", { section, text, base_rev: 0 });
      }
      const created = await write("plan_create", {
        template_id: "web-app", title: planTitle, strict: true,
        brief: { goal: planTitle, users: "TaskLight operators", stack: "Python and Vite" },
        tasks: [{ key: "entry", title: taskTitle, type: "test", phase: "discovery",
          accept: "The checked HTML entry point loads and renders the Wall",
          microtasks: [indexCheck, { text: "Inspect the plan task in the browser",
            accept: "The Wall shows the plan and task titles" }] }],
      });
      const taskId = created.ids?.entry;
      if (created.created !== true || !taskId) throw new Error("plan_create did not return the entry task");
      const checked = await call("plan_check");
      if (checked.conformance?.ok !== true) throw new Error("plan_check did not confirm conformance");
      await requireView(
        `${visibleText('.app[data-view="wall"] .plan-title', planTitle)} &&
         ${visibleText('.app[data-view="wall"] .task-title', taskTitle)}`, "MCP plan title and task title in Wall",
      );
      await shot("1_plan.png");
      summary.plan = true;

      await write("agent_lifecycle", { state: "deployed", run_id: randomUUID(), harness: "external", swarm: "demo" });
      const ready = await call("next_work");
      const { tasks } = await call("plan_get");
      const task = tasks.find((item) => item.id === taskId);
      const micro = task?.microtasks.find((item) => item.text === indexCheck.text);
      if (!Number.isSafeInteger(task?.rev) || !micro?.id || !ready.items?.some((item) => item.id === micro.id)) {
        throw new Error("The current plan did not return the entry task revision and a ready microtask");
      }
      const claimed = await write("task_claim", { task_id: taskId, base_rev: task.rev });
      const claim = claimed.task?.claim_lamport;
      if (claimed.task?.assignee !== AGENT || !Number.isSafeInteger(claim) || claim <= 0) {
        throw new Error("task_claim did not return ownership and a claim fence");
      }
      await write("microtask_set", { id: micro.id, state: "active", claim_lamport: claim });
      const evidence = join(REPO, "hosting", "index.html");
      const html = readFileSync(evidence, "utf8");
      if (!html.includes("<title>TaskLight</title>") || !html.includes('id="wall"')) {
        throw new Error("The hosted HTML source lacks the TaskLight title or Wall mount");
      }
      const reported = await write("microtask_set", {
        id: micro.id, state: "done", claim_lamport: claim,
        outcome: "Verified the TaskLight title and wall mount in the HTML source.", evidence: [evidence],
      });
      if (reported.microtask?.state !== "done" || !reported.microtask.evidence?.length) {
        throw new Error("microtask_set did not acknowledge completion with evidence");
      }

      await click('button[data-nav="swarm"]');
      const lane = `.app[data-view="swarm"] .swarm-lane[aria-label="Agent · ${AGENT} · demo"]`;
      const progress = `${taskTitle}, active, 1/2`;
      await requireView(
        `${visibleText(lane + " .swarm-agent-name", AGENT)} &&
         ${visibleText(lane + ` .swarm-task-bubble[aria-label^="${progress}"] .swarm-task-title`, taskTitle)}`,
        "registered agent owns the task with one microtask complete in Agents",
      );
      await shot("4_plan_v2.png");
      summary.planV2 = true;

      await evalJs(`document.querySelector('button[data-nav="memory"]').click()`);
      await requireView(visibleText('.app[data-view="memory"] [data-section-id="architecture"] > .memory-text',
        memoryText), "architecture section text in Memory");
      await shot("5_memory.png");
      summary.memory = true;
    });
  }

  writeFileSync(join(P.logs, "room_events.json"), readRoom());
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
