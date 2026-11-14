import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentChatHandle, AgentChatHandlers, AgentChatVM, ChatMessageVM } from "../../../src/agentsui/types";

const REPO = resolve(__dirname, "../../..");
const SRC = join(REPO, "src/agentsui");
const walk = (d: string): string[] => existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : [];
const files = () => walk(SRC).filter((f) => /\.ts$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const implemented = () => {
  const idx = join(SRC, "index.ts");
  expect(existsSync(idx) && !/U35 stub/.test(readFileSync(idx, "utf8")), "src/agentsui/index.ts is still the stub").toBe(true);
};

describe("U35 static scan of src/agentsui (C2)", () => {
  it("types.ts and index.ts exist; index is not a stub and exports mountAgentChat; implementation is substantial", () => {
    expect(existsSync(join(SRC, "types.ts"))).toBe(true);
    const idx = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(idx).not.toMatch(/U35 stub/);
    expect(idx).toMatch(/export[^;]*mountAgentChat/);
    const total = files().reduce((n, f) => n + strip(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(3000);
  });

  const BAD: [string, RegExp][] = [
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\s*\.\s*write(ln)?\b/],
    ["eval(", /\beval\s*\(/],
    ["new Function", /new\s+Function\b/],
    ["setTimeout/setInterval with a string", /\bset(Timeout|Interval)\s*\(\s*["'`]/],
    ["DOMParser / createContextualFragment / srcdoc", /DOMParser|createContextualFragment|\bsrcdoc\b/],
  ];
  it.each(BAD)("no %s anywhere in src/agentsui (comments stripped)", (_n, re) => {
    implemented();
    const fs = files();
    expect(fs.length).toBeGreaterThanOrEqual(2);
    for (const f of fs) expect(strip(readFileSync(f, "utf8")), f).not.toMatch(re);
  });

  it("no Firebase / sync / network access in src/agentsui (pure view layer)", () => {
    implemented();
    for (const f of files()) {
      const s = strip(readFileSync(f, "utf8"));
      expect(s, f).not.toMatch(/from\s+["'](firebase|@firebase)[/"']/);
      expect(s, f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/);
    }
  });

  it("types.ts declares the spec's exported names", () => {
    const s = readFileSync(join(SRC, "types.ts"), "utf8");
    for (const n of ["ChatMessageVM", "AgentChatVM", "AgentChatHandlers", "AgentChatHandle"]) {
      expect(s, n).toMatch(new RegExp(`export\\s+(type|interface)\\s+${n}\\b`));
    }
  });

  it("type contract (compile-time, enforced by tsc): exact optionality and unions", () => {
    const m: ChatMessageVM = { id: "a", from: "nano", agent: "x", text: "t", at: "1" };
    // @ts-expect-error from is a closed union
    const badFrom: ChatMessageVM = { id: "a", from: "robot", agent: "x", text: "t", at: "1" };
    // @ts-expect-error verdict is a closed union
    const badVerdict: AgentChatVM = { room: "r", agent: "a", title: "t", messages: [m], silent: false, sending: false, drift: { verdict: "bad", reason: "", added: [], removed: [], source: "rules" } };
    // @ts-expect-error source is a closed union
    const badSource: AgentChatVM = { room: "r", agent: "a", title: "t", messages: [m], silent: false, sending: false, drift: { verdict: "drift", reason: "", added: [], removed: [], source: "cloudy" } };
    // @ts-expect-error sending is required
    const noSending: AgentChatVM = { room: "r", agent: "a", title: "t", messages: [], silent: false };
    const pushes = (v: AgentChatVM): void => {
      // @ts-expect-error messages is readonly
      v.messages.push(m);
    };
    const h: AgentChatHandlers = {};
    const handle: AgentChatHandle | undefined = undefined;
    expect([badFrom, badVerdict, badSource, noSending, h, handle, pushes].length).toBe(7);
  });
});
