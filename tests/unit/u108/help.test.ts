import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mountWall } from "../../../src/views/index";
import type { WallHandle, WallVM } from "../../../src/views/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const EXT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GUIDE = "https://github.com/oguirado/TaskLight/blob/main/docs/DESKTOP_SETUP.md";
const handles: WallHandle[] = [];
const scratch: string[] = [];
const vm: WallVM = {
  now: "09:00", model: { state: "ready", label: "Model ready" }, network: "offline",
  workspaces: [], workspace: "", view: "wall", archiveScope: "workspace",
  tasks: [], agenda: [], archive: [],
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T09:00:00Z")); });
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function control(root: ParentNode, label: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("button, a")]
    .find(node => node.textContent?.trim() === label);
  expect(found, `Missing control: ${label}`).toBeDefined();
  return found!;
}
function readable(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return [...node.childNodes].map(readable).join(" ").replace(/\s+/g, " ").trim();
}
function assertNoPrematureClaim(text: string): void {
  for (const sentence of text.split(/[.!?\n]/)) {
    // Explicit denials are valid connection guidance, not success claims.
    if (/\b(?:no|not|never|cannot|doesn['’]t|isn['’]t|won['’]t)\b/i.test(sentence)) continue;
    expect(sentence).not.toMatch(/\b(?:harness|agent)\s+(?:(?:is|has been|successfully|now|already)\s+)*(?:connected|deployed)\b/i);
  }
}
function openHelp() {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, vm); handles.push(handle);
  control(host, "New workspace").click();
  control(host, "Close");
  // The spec leaves the help container's tag, classes and ARIA label open.
  return { host, help: host };
}
function blocks(help: HTMLElement): HTMLElement[] {
  // A pre may contain code; count its text once, with no layout/class dependency.
  return [...help.querySelectorAll<HTMLElement>("pre, code")]
    .filter(node => !node.querySelector("pre, code"));
}
function recipes(help: HTMLElement): string[] {
  const commands = blocks(help).flatMap(node => (node.textContent ?? "").split("\n"))
    .map(line => line.trim()).filter(line => /^python3\s+bridge\/install\.py(?:\s|$)/.test(line));
  expect(commands, "Preview and Install must expose executable installer recipes").toHaveLength(2);
  return commands;
}
function words(recipe: string): string[] {
  const result = spawnSync("python3", ["-c", "import json,shlex,sys; json.dump(shlex.split(sys.stdin.read()),sys.stdout)"],
    { input: recipe, encoding: "utf8", cwd: ROOT, timeout: 5000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as string[];
}
function assertRecipePair(help: HTMLElement): string[][] {
  const pair = recipes(help).map(words);
  const base = ["python3", "bridge/install.py", "--browser", "chrome", "--extension-id", "<extension-id>", "--room", "my-room:private"];
  expect(pair).toContainEqual(base); expect(pair).toContainEqual([...base, "--apply"]);
  expect(readable(help)).toMatch(/\bPreview\b/); expect(readable(help)).toMatch(/\bInstall\b/);
  return pair;
}
function temp(): string {
  const dir = mkdtempSync(join(HERE, ".scratch-")); scratch.push(dir); return dir;
}
function registration(help: HTMLElement) {
  // Only installer recipes have a mandated element type. Registration may be
  // displayed in any text container; find a complete, parseable JSON object.
  const raw = help.textContent ?? "";
  let parsed: unknown;
  for (let start = raw.indexOf("{"); start >= 0 && parsed === undefined; start = raw.indexOf("{", start + 1)) {
    for (let end = raw.indexOf("}", start); end >= 0; end = raw.indexOf("}", end + 1)) {
      try {
        const candidate: unknown = JSON.parse(raw.slice(start, end + 1));
        if (candidate && typeof candidate === "object" && "command" in candidate) { parsed = candidate; break; }
      } catch { /* A nested object is not yet the full registration. */ }
    }
  }
  expect(parsed, "Help must expose parseable MCP registration JSON").toBeDefined();
  const value = parsed as { command: string; args: string[]; cwd: string; env: { CW_HOME: string } };
  expect(value).toEqual({ command: "python3", args: ["-m", "bridge.room.mcp"], cwd: "<repo-root>", env: { CW_HOME: "<cw-home-path>" } });
  return value;
}
function assertGuide(link: HTMLElement) {
  expect(link.tagName).toBe("A"); expect(link.getAttribute("href")).toBe(GUIDE);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(new Set(link.getAttribute("rel")?.split(/\s+/))).toEqual(new Set(["noopener", "noreferrer"]));
  expect(link.tabIndex).toBeGreaterThanOrEqual(0);
}

function executeRecipes(help: HTMLElement) {
  const pair = assertRecipePair(help);
  const dir = temp(), checkout = join(dir, "checkout"), home = join(dir, "home"), cw = join(dir, "cw");
  mkdirSync(join(checkout, "bridge"), { recursive: true }); mkdirSync(home);
  cpSync(join(ROOT, "bridge/install.py"), join(checkout, "bridge/install.py"));
  const env = { PATH: process.env.PATH ?? "", HOME: home, CW_HOME: cw, PYTHONDONTWRITEBYTECODE: "1" };
  const run = (args: string[]) => spawnSync(args[0]!, args.slice(1).map(word => word.replace("<extension-id>", EXT)),
    { cwd: checkout, env, encoding: "utf8", timeout: 5000 });
  const preview = run(pair.find(args => !args.includes("--apply"))!);
  expect(preview.error).toBeUndefined(); expect(preview.status, preview.stderr).toBe(0);
  const previewJSON = preview.stdout.slice(0, preview.stdout.indexOf("\nTarget:"));
  expect(() => JSON.parse(previewJSON)).not.toThrow();
  expect(JSON.parse(previewJSON).allowed_origins).toEqual([`chrome-extension://${EXT}/`]);
  expect(existsSync(join(home, ".config"))).toBe(false); expect(existsSync(cw)).toBe(false);
  const apply = pair.find(args => args.includes("--apply"))!;
  const installed = run(apply); expect(installed.error).toBeUndefined(); expect(installed.status, installed.stderr).toBe(0);
  const config = join(cw, "wall.config.json"), before = readFileSync(config);
  expect(JSON.parse(before.toString()).rooms.allow).toEqual([{ room: "my-room", tier: "private" }]);
  // The preview is the authoritative public description of its native destination.
  const manifest = JSON.parse(previewJSON) as { path: string };
  expect(existsSync(manifest.path)).toBe(true);
  const target = preview.stdout.match(/^Target: (.+)$/m)?.[1];
  expect(target).toBeDefined(); expect(existsSync(target!)).toBe(true);
  const again = run(apply); expect(again.status, again.stderr).toBe(0); expect(readFileSync(config)).toEqual(before);
  assertNoPrematureClaim(installed.stdout);
}

function executeRegistration(help: HTMLElement) {
  const cfg = registration(help), dir = temp();
  const args = { room: "my-room", agent: "setup-check", text: "Workspace connected" };
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "setup-check", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "post_status", arguments: args } },
  ];
  const child = spawnSync(cfg.command, cfg.args, {
    cwd: cfg.cwd.replace("<repo-root>", ROOT),
    env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), PYTHONDONTWRITEBYTECODE: "1", CW_HOME: cfg.env.CW_HOME.replace("<cw-home-path>", join(dir, "cw")) },
    input: messages.map(message => JSON.stringify(message)).join("\n") + "\n", encoding: "utf8", timeout: 5000,
  });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
  const replies = child.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(replies.find(reply => reply.id === 1)?.result.protocolVersion).toBe("2024-11-05");
  const posted = replies.find(reply => reply.id === 2); expect(posted?.error).toBeUndefined();
  expect(posted?.result.isError).not.toBe(true);
  const payload = JSON.parse(posted.result.content[0].text);
  expect(payload.event).toMatchObject({ room: "my-room", agent: "setup-check", act: "heartbeat", untrusted_text: "Workspace connected" });
  expect(payload.event).not.toHaveProperty("text");
  expect(JSON.stringify(payload)).not.toMatch(/"(?:deployment|deployed)"/);
}

describe("U108 rendered connection guidance", () => {
  it("A1/M1 renders Preview and Install recipes in selectable code/pre elements", () => {
    const { help } = openHelp(); assertRecipePair(help);
    for (const block of blocks(help).filter(node => node.textContent?.includes("bridge/install.py"))) {
      for (let node: HTMLElement | null = block; node; node = node.parentElement) {
        expect(getComputedStyle(node).userSelect).not.toBe("none");
        expect(node.hidden).toBe(false); expect(node.getAttribute("aria-hidden")).not.toBe("true");
      }
      const range = document.createRange(); range.selectNodeContents(block);
      expect(range.toString()).toBe(block.textContent);
    }
  });
  it("A1/M1 removes the obsolete executable from visible and selectable recipe text", () => {
    const { help } = openHelp();
    expect(help.textContent).not.toMatch(/\bTaskLight\s+--room\b/);
    for (const node of blocks(help)) expect(node.textContent).not.toMatch(/\bTaskLight\s+--room\b/);
  });
  it("M1 explains repository root, loaded extension ID, preview and configuration writes", () => {
    const text = readable(openHelp().help);
    expect(text).toMatch(/repo(?:sitory)?[ -]root/i);
    expect(text).toContain("<extension-id>");
    expect(text).toMatch(/replac/i);
    expect(text).toMatch(/loaded extension(?:'s|’s)?\s+(?:ID|identifier)|(?:ID|identifier)[^.!?]*loaded extension/i);
    expect(text).toMatch(/preview[^.!?]*\b(?:writes? nothing|no (?:files?|writes?|changes?)|does not write)\b/i);
    expect(text).toMatch(/install[^.!?]*\b(?:writes?|creates?)\b[^.!?]*config/i);
  });
  it("A1 executes both copied recipes in a scratch checkout and preserves existing config", () => {
    executeRecipes(openHelp().help);
  });
  it("M2 shows the generic MCP heading, launch command and parseable registration", () => {
    const { help } = openHelp();
    expect([...help.querySelectorAll("h1,h2,h3,h4,h5,h6")].some(node => node.textContent === "Connect your MCP client or agent harness")).toBe(true);
    expect(help.textContent).toContain("python3 -m bridge.room.mcp");
    registration(help);
  });
  it("M2 explains both path placeholders and the shared CW_HOME for MCP and native host", () => {
    const help = openHelp().help;
    const copy = help.cloneNode(true) as HTMLElement;
    for (const node of blocks(copy)) {
      if (/^(?:\{|python3\s)/.test(node.textContent?.trim() ?? "")) node.remove();
    }
    const text = readable(copy);
    expect(text).toContain("<repo-root>"); expect(text).toMatch(/repo(?:sitory)?[ -]root/i);
    expect(text).toContain("<cw-home-path>"); expect(text).toMatch(/(?:local )?data director/i);
    expect(text).toMatch(/same[^.!?]*CW_HOME|CW_HOME[^.!?]*same/i);
    expect(text).toMatch(/MCP (?:server|process)/i); expect(text).toMatch(/native host/i);
  });
  it("A2 initializes the exact displayed MCP registration and posts an untrusted heartbeat", () => {
    executeRegistration(openHelp().help);
  });
  it("M3 explains allowlisting, MCP and activity without asserting a connection or deployment", () => {
    const text = readable(openHelp().help);
    expect(text).toMatch(/allow[ -]?list/i); expect(text).toContain("wall.config.json");
    expect(text).toMatch(/harness[^.!?]*MCP|MCP[^.!?]*harness/i);
    expect(text).toMatch(/agent[^.!?]*post/i); expect(text).toMatch(/activit/i);
    assertNoPrematureClaim(text);
  });
  it("M3 keeps Close and permits reopening help without registering a room", () => {
    const { host, help } = openHelp();
    const before = readable(help);
    assertNoPrematureClaim(readable(help));
    control(help, "Close").click();
    expect([...host.querySelectorAll("button")].some(node => node.textContent?.trim() === "Close")).toBe(false);
    control(host, "New workspace").click(); expect(control(host, "Close")).toBeDefined();
    expect(readable(host)).toBe(before);
    expect(vm.workspaces).toHaveLength(0);
  });
  it("M4 uses the absolute guide with safe new-tab attributes and keyboard focus", () => {
    const link = control(openHelp().help, "Read the desktop setup guide");
    assertGuide(link); link.focus(); expect(document.activeElement).toBe(link);
    expect(new URL(link.getAttribute("href")!, GUIDE).href).toBe(GUIDE);
  });
  it("A6 negative control rejects the old help command without editing product source", () => {
    const help = document.createElement("section"), code = document.createElement("code");
    code.textContent = "TaskLight --room my-room"; help.append(code);
    expect(() => assertRecipePair(help)).toThrow(/Preview and Install/);
  });
  it("A6 Amendment B negative control rejects a restored relative guide href", () => {
    const link = document.createElement("a"); link.href = "docs/DESKTOP_SETUP.md";
    link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Read the desktop setup guide";
    expect(() => assertGuide(link)).toThrow();
  });
  function referenceHelp(): HTMLElement {
    const help = document.createElement("section");
    for (const text of [
      "Preview", 'python3 bridge/install.py --browser chrome --extension-id "<extension-id>" --room my-room:private',
      "Install", 'python3 bridge/install.py --browser chrome --extension-id "<extension-id>" --room my-room:private --apply',
      JSON.stringify({ command: "python3", args: ["-m", "bridge.room.mcp"], cwd: "<repo-root>", env: { CW_HOME: "<cw-home-path>" } }),
    ]) {
      const code = document.createElement("code"); code.textContent = text; help.append(code);
    }
    return help;
  }
  it("A6 calibrates recipe execution against the specification fixture", () => {
    executeRecipes(referenceHelp());
    assertNoPrematureClaim("Installation does not mean a harness is connected or an agent deployed.");
    expect(() => assertNoPrematureClaim("Your harness is now connected.")).toThrow();
  });
  it("A6 calibrates exact MCP registration execution against the specification fixture", () => {
    executeRegistration(referenceHelp());
  });
});
