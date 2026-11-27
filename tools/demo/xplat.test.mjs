import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { chromeCandidates } from "./demo_lib.mjs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const runtime = () => import("./demo_runtime.mjs");
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "tasklight-xplat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Windows launcher selects either PATH interpreter and enters the checkout", () => {
  const cmd = source("../../bin/tasklight.cmd");
  assert.match(cmd, /%~dp0/);
  assert.match(cmd, /python\.exe/i);
  assert.match(cmd, /python3\.exe/i);
  assert.match(cmd, /-m bridge\.room %\*/i);
  assert.match(source("../../docs/CLI.md"), /tasklight\.cmd/);
});

test("Windows discovery understands drive letters, quoted Path entries and install roots", () => {
  const drive = "C:" + win32.sep;
  const dir = (name) => win32.join(drive, name);
  const override = dir("custom browser.exe");
  const result = chromeCandidates("win32", {
    CHROME: override, Path: `"${dir("portable apps")}";${dir("tools")}`,
    ProgramFiles: dir("Program Files"), LOCALAPPDATA: dir("User Data"),
  });
  assert.deepEqual(result.slice(0, 3), [
    override, win32.join(dir("portable apps"), "chrome.exe"), win32.join(dir("tools"), "chrome.exe"),
  ]);
  assert.ok(result.includes(win32.join(dir("Program Files"), "Google", "Chrome", "Application", "chrome.exe")));
  assert.ok(result.includes(win32.join(dir("User Data"), "Microsoft", "Edge", "Application", "msedge.exe")));
});

test("both demos use a shared browser probe and Node key generation", () => {
  for (const path of ["./run_demo.mjs", "./run_tasklight.mjs"]) {
    const text = source(path);
    assert.doesNotMatch(text, /\bopenssl\b|process\.kill\(-|\/proc\//);
    assert.match(text, /findChrome\(chromeCandidates\(/);
    assert.match(text, /extensionId\(P\.keys\)/);
  }
});

test("key files are reusable and their SPKI yields the extension id", async (t) => {
  const { extensionId } = await runtime();
  const dir = scratch(t);
  const id = extensionId(dir);
  const der = Buffer.from(readFileSync(join(dir, "demo_pub.b64"), "utf8"), "base64");
  assert.equal(createPublicKey({ key: der, type: "spki", format: "der" }).asymmetricKeyType, "rsa");
  assert.equal(id, createHash("sha256").update(der).digest("hex").slice(0, 32)
    .replace(/./g, (hex) => "abcdefghijklmnop"[parseInt(hex, 16)]));
  assert.equal(extensionId(dir), id);
});

test("directory counting includes only immediate real directories", async (t) => {
  const { readdirCount } = await runtime();
  const dir = scratch(t);
  mkdirSync(join(dir, "a", "nested"), { recursive: true });
  writeFileSync(join(dir, "b"), "");
  assert.equal(readdirCount(dir), 1);
});

test("owned child cleanup leaves an unrelated child running", async (t) => {
  const { stopChildren } = await runtime();
  const children = [1, 2].map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]));
  for (const child of children) t.after(() => child.kill());
  await Promise.all(children.map((child) => once(child, "spawn")));
  await stopChildren([children[0]]);
  assert.ok(children[0].signalCode || children[0].exitCode !== null);
  assert.equal(children[1].exitCode, null);
  assert.equal(children[1].signalCode, null);
});

test("a stale ViewPoint stop record cannot signal a process", async (t) => {
  const { openStopControl, requestStop } = await runtime();
  const dir = scratch(t);
  const receipt = join(dir, "stop.json");
  let requests = 0;
  const control = await openStopControl(receipt, () => {
    requests++;
    void control.close();
  });
  t.after(() => control.close());
  const saved = JSON.parse(readFileSync(receipt, "utf8"));
  const otherToken = (saved.token.startsWith("a") ? "b" : "a") + saved.token.slice(1);
  writeFileSync(receipt, JSON.stringify({ ...saved, token: otherToken }));
  assert.equal(await requestStop(receipt), false);
  assert.equal(requests, 0);
  writeFileSync(receipt, JSON.stringify(saved));
  assert.equal(await requestStop(receipt), true);
  assert.equal(requests, 1);
});

test("windowed ViewPoint --keep skips the stop wait before the runner is ready", () => {
  const wait = source("./run_tasklight.mjs").split("\n").find((line) => line.includes('log("Ctrl-C to stop")'));
  assert.match(wait, /else if \(!KEEP\) \{ log\("Ctrl-C to stop"\); await waitUntilStopped\(\); \}/);
});

test("windowed replay --keep skips the stop wait before the runner is ready", () => {
  const wait = source("./run_tasklight.mjs").split("\n").find((line) => line.includes('log("replay finished; wall stays up'));
  assert.match(wait, /if \(!HEADLESS && !has\("--exit"\) && !KEEP\) .*await waitUntilStopped\(\)/);
});

test("the runner refuses the protected root on another Windows drive", () => {
  const runner = source("./run_tasklight.mjs");
  const root = runner.match(/^const FORBIDDEN_ROOT = .*;$/m)[0];
  const guard = runner.match(/^const under = .*\r?\n[\s\S]*?^if \([^\r\n]*\bDIR\b[^\r\n]*\) \{ console\.error.*$/m)[0];
  const resolveDrive = (drive, ...parts) => win32.join(drive + win32.sep, ...parts);
  const refused = (dir) => {
    let code;
    runInNewContext(root + "\n" + guard, {
      path: win32, REPO: resolveDrive("C:", "checkout"), DIR: dir,
      console: { error() {} }, process: { exit(value) { code = value; } },
    });
    return code;
  };
  assert.equal(refused(resolveDrive("D:", "dev", "shm", "vqa-cu")), 2);
  assert.equal(refused(resolveDrive("E:", "DEV", "shm", "vqa-cu", "runs")), 2);
  assert.equal(refused(resolveDrive("D:", "dev", "shm", "vqa-cu-scratch")), undefined);
  assert.match(root, /path\.resolve\(REPO, /);
  assert.match(runner, /if \(underForbiddenRoot\(root\)\) \{ log\(`REFUSED replay root/);
});

async function closedStopRecord(dir) {
  const { openStopControl } = await runtime();
  const logs = join(dir, "logs");
  mkdirSync(logs);
  const stop = join(logs, "tasklight_stop.json");
  const pids = join(logs, "tasklight_pids.json");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  writeFileSync(stop, JSON.stringify({ port, token: "a".repeat(64) }));
  writeFileSync(pids, "{}");
  return { openStopControl, stop, pids };
}

test("--stop clears the records for a dead runner and exits successfully", async (t) => {
  const dir = scratch(t);
  const { stop, pids } = await closedStopRecord(dir);
  const runner = fileURLToPath(new URL("./run_tasklight.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [runner, "--stop", "--dir", dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(stop), false);
  assert.equal(existsSync(pids), false);
});

test("startup replaces a dead runner's stop record but preserves a live one", async (t) => {
  const { openStopControl, stop, pids } = await closedStopRecord(scratch(t));
  const control = await openStopControl(stop, () => assert.fail("unexpected stop request"), pids);
  t.after(() => control.close());
  assert.equal(existsSync(pids), false);
  const record = readFileSync(stop, "utf8");
  assert.notEqual(JSON.parse(record).token, "a".repeat(64));
  await assert.rejects(openStopControl(stop, () => assert.fail("unexpected stop request"), pids), { code: "EEXIST" });
  assert.equal(readFileSync(stop, "utf8"), record);
});
