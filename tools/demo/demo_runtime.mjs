import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  accessSync, closeSync, constants, existsSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const NATIVE_HOST = "com.contextwall.bridge";

export function findChrome(candidates) {
  const executable = candidates.find((candidate) => {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return executable && resolve(executable);
}

export function browserKind(executable) {
  const name = basename(executable ?? "").toLowerCase();
  if (name.includes("edge")) return "edge";
  if (name.includes("brave")) return "brave";
  if (name.includes("chromium") || /[\\/]chromium[\\/]/i.test(executable ?? "")) return "chromium";
  return "chrome";
}

export function findPython(candidates) {
  return candidates.find((candidate) => spawnSync(candidate, [
    "-c", "import sys; sys.exit(sys.version_info < (3, 10))",
  ], { stdio: "ignore", timeout: 5000, windowsHide: true }).status === 0);
}

export function extensionId(dir) {
  const idFile = join(dir, "ext_id.txt");
  const publicFile = join(dir, "demo_pub.b64");
  if (existsSync(idFile) && existsSync(publicFile)) return readFileSync(idFile, "utf8").trim();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const id = createHash("sha256").update(publicKey).digest("hex").slice(0, 32)
    .replace(/./g, (hex) => "abcdefghijklmnop"[parseInt(hex, 16)]);
  writeFileSync(join(dir, "demo_key.pem"), privateKey, { mode: 0o600 });
  writeFileSync(join(dir, "demo_pub.der"), publicKey);
  writeFileSync(publicFile, publicKey.toString("base64"));
  writeFileSync(idFile, id);
  return id;
}

export function configureDemoExtension(dir, extId) {
  if (process.platform !== "win32") return;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const worker = realpathSync(join(dir, manifest.background.service_worker));
  const within = relative(realpathSync(dir), worker);
  if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep)) {
    throw new Error("Demo service worker escapes the extension directory");
  }
  const source = readFileSync(worker, "utf8");
  const original = JSON.stringify(NATIVE_HOST);
  const demo = JSON.stringify(`${NATIVE_HOST}.demo.${extId}`);
  if (source.includes(demo)) return;
  if (!source.includes(original)) throw new Error("Native host name missing from the demo service worker");
  writeFileSync(worker, source.replaceAll(original, demo));
}

export function unregisterNative(py, manifest, browser, options) {
  if (process.platform !== "win32" || !manifest) return;
  execFileSync(py, ["tools/demo/setup_native.py", "--unregister", manifest, "--browser", browser], options);
}

export function readdirCount(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

export function spawnLogged(cmd, argv, file, options, onError) {
  const fd = openSync(file, "a");
  try {
    const child = spawn(cmd, argv, { stdio: ["ignore", fd, fd], windowsHide: true, ...options });
    child.on("error", onError);
    return child;
  } finally {
    closeSync(fd);
  }
}

function waitForExit(child, ms) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), ms);
    child.once("exit", onExit);
  });
}

export async function stopChildren(children) {
  await Promise.all([...children].reverse().map(async (child) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (!await waitForExit(child, 1500)) {
      child.kill("SIGKILL");
      if (!await waitForExit(child, 1500)) throw new Error(`Child ${child.pid} did not exit`);
    }
  }));
}

export async function closeChrome(cdp, child) {
  if (!cdp) return;
  try {
    if (cdp.ws.readyState === WebSocket.OPEN) {
      cdp.ws.send(JSON.stringify({ id: 0, method: "Browser.close" }));
      if (child) await waitForExit(child, 1500);
    }
  } catch {
    // The process-handle cleanup also runs if CDP disconnects during shutdown.
  } finally {
    cdp.ws.close();
  }
}

// The live runner owns the actual ChildProcess handles. The receipt authenticates
// a stop request to that runner without sending a signal to any recorded PID.
export async function openStopControl(file, onStop, pids) {
  const token = randomBytes(32).toString("hex");
  const clients = new Set();
  const accepted = new Set();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { clients.delete(socket); accepted.delete(socket); });
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > token.length + 1) socket.destroy();
      else if (input === token + "\n" && !accepted.has(socket)) {
        accepted.add(socket);
        socket.setTimeout(0);
        onStop();
      } else if (input.includes("\n")) socket.destroy();
    });
  });
  const listen = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const writeReceipt = () => writeFileSync(file, JSON.stringify({ port: server.address().port, token }) + "\n",
    { flag: "wx", mode: 0o600 });
  await listen();
  try {
    try {
      writeReceipt();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Release the temporary listener before probing in case it reused the dead port.
      await new Promise((resolve) => server.close(resolve));
      if (!await contactStopControl(file, pids, false)) throw error;
      await listen();
      writeReceipt();
    }
  } catch (error) {
    server.close();
    throw error;
  }
  let closed;
  return {
    close(stopped = true) {
      return closed ??= new Promise((resolve) => {
        rmSync(file, { force: true });
        for (const socket of clients) {
          if (accepted.has(socket)) socket.end(stopped ? "stopped\n" : "failed\n");
          else socket.destroy();
        }
        server.close(resolve);
      });
    },
  };
}

async function contactStopControl(file, pids, sendStop) {
  try {
    const receipt = readFileSync(file, "utf8");
    const { port, token } = JSON.parse(receipt);
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
    const result = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let reply = "";
      socket.on("connect", () => {
        if (sendStop) socket.write(token + "\n");
        else socket.destroy();
      });
      socket.setTimeout(30000, () => socket.destroy());
      socket.on("data", (chunk) => {
        reply += chunk.toString();
        if (reply.length > 8) socket.destroy();
      });
      socket.on("error", (error) => resolve(error.code === "ECONNREFUSED" ? "refused" : false));
      socket.on("close", () => resolve(sendStop && reply === "stopped\n"));
    });
    if (result !== "refused") return result;
    if (readFileSync(file, "utf8") !== receipt) return false;
    if (pids) rmSync(pids, { force: true });
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function requestStop(file, pids) {
  return contactStopControl(file, pids, true);
}
