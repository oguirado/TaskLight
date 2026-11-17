import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/** Offline Chromium, pipe transport: no server, listening port, fetch or timer. */
export class Browser {
  private child!: ChildProcess;
  private input!: Writable;
  private sequence = 0;
  private session = "";
  private profile = "";
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  async start(): Promise<void> {
    const executable = [process.env["U156_BROWSER"], "google-chrome", "chromium", "chromium-browser"]
      .filter((value): value is string => Boolean(value))
      .find(value => spawnSync(value, ["--version"], { encoding: "utf8" }).status === 0);
    if (!executable) throw new Error("HOLD: offline Chromium is required; source matching cannot pass rendered checks");
    this.profile = mkdtempSync(resolve(import.meta.dirname, ".browser-"));
    this.child = spawn(executable, [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-pipe",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--disable-domain-reliability", "--no-first-run", "--no-default-browser-check",
      "--disable-breakpad", "--disable-crash-reporter", "--password-store=basic",
      "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${this.profile}`,
    ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    this.input = this.child.stdio[3] as Writable;
    let buffer = "";
    (this.child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let boundary: number;
      while ((boundary = buffer.indexOf("\0")) !== -1) {
        const message = JSON.parse(buffer.slice(0, boundary)) as {
          id?: number; result?: unknown; error?: { message: string };
        };
        buffer = buffer.slice(boundary + 1);
        if (message.id === undefined) continue;
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error.message));
        else request?.resolve(message.result);
      }
    });
    this.child.on("exit", () => {
      for (const request of this.pending.values()) request.reject(new Error("Offline browser exited before responding"));
      this.pending.clear();
    });
    await this.send("Browser.getVersion");
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    this.session = sessionId;
    await this.send("Network.enable");
    await this.send("Network.setBlockedURLs", { urls: ["*"] });
    await this.send("Animation.enable");
    await this.send("Animation.setPlaybackRate", { playbackRate: 0 });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  async send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.sequence;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, {
      resolve: value => resolve(value as T), reject,
    }));
    this.input.write(JSON.stringify({ id, method, params, ...(this.session ? { sessionId: this.session } : {}) }) + "\0");
    return promise;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser fixture did not execute: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  async load(css: string, markup: string, options: {
    theme?: string; width?: number; height?: number; reduced?: boolean; rootClass?: boolean; documentClass?: boolean;
  } = {}): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: options.width ?? 1440, height: options.height ?? 900, deviceScaleFactor: 1, mobile: false,
    });
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: options.reduced ? "reduce" : "no-preference" }],
    });
    await this.evaluate(`(() => {
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.className = '';
      document.head.replaceChildren(); document.body.innerHTML = ${JSON.stringify(markup)};
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)};
      document.head.append(style);
      ${options.theme ? `document.documentElement.dataset.theme = ${JSON.stringify(options.theme)};` : ""}
      if (${Boolean(options.rootClass)}) document.querySelector('.app').classList.add('ui-reduced-motion');
      if (${Boolean(options.documentClass)}) document.documentElement.classList.add('ui-reduced-motion');
      document.documentElement.scrollTop = 0;
      return document.styleSheets.length > 0 && innerWidth > 0;
    })()`);
  }

  async tab(): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  }

  async close(): Promise<void> {
    if (this.child?.exitCode === null) {
      const exited = new Promise<void>(resolve => this.child.once("exit", () => resolve()));
      this.session = "";
      await this.send("Browser.close").catch(() => {
        if (this.child.exitCode === null) this.child.kill("SIGTERM"); // Only our launched process.
      });
      await exited;
    }
    if (this.profile) rmSync(this.profile, { recursive: true, force: true });
  }
}
