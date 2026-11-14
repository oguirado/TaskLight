// U38 test support (no assertions about product behaviour). Nothing here redefines Event.isTrusted.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentState, RoomEvent } from "../../../src/agents/types";

export const ROOT = resolve(__dirname, "../../..");
export const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
export const exists = (rel: string): boolean => existsSync(resolve(ROOT, rel));
export const stripCss = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
export const stripTs = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ---- time ---- */
const pad = (n: number): string => String(n).padStart(2, "0");
/** Local-time epoch ms (the formatter under test works in local time). */
export const local = (y: number, mon1: number, d: number, h = 0, m = 0): number => new Date(y, mon1 - 1, d, h, m, 0, 0).getTime();
export const hhmm = (ms: number): string => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
export const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
export const FORMATTED_RE = /^(Yesterday \d{2}:\d{2}|\d{2}:\d{2}|\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}:\d{2})$/;

/* ---- fixtures ---- */
export const idOf = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;
export const ev = (lamport: number, room: string, agent: string, act: RoomEvent["act"], text: string, ts: number, extra: Partial<RoomEvent> = {}): RoomEvent =>
  ({ id: idOf(lamport + (room.length + agent.length) * 1000), lamport, ts, room, agent, act, text, ...extra });

export function mkState(over: Partial<AgentState> & { steps?: number; done?: number } = {}): AgentState {
  const { steps = 3, done = 0, ...rest } = over;
  const n = steps;
  const base: AgentState = {
    room: "demo", agent: "worker-1",
    stepStates: Array.from({ length: n }, (_, i) => (i < done ? "done" : "pending")),
    outcomes: Array.from({ length: n }, (_, i) => (i < done ? "ok" : undefined)),
    took: Array.from({ length: n }, () => undefined),
    lastSeen: local(2026, 11, 13, 9, 30), openQuestions: [], closed: false,
  };
  if (n > 0) base.contract = { title: "Add CSV export", steps: Array.from({ length: n }, (_, i) => ({ text: `step ${i + 1}` })), hash: "h1", version: 1, lamport: 2 };
  return { ...base, ...rest };
}

/* ---- tiny CSS model (comments stripped; media blocks flattened with their condition) ---- */
export interface Rule { media: string | null; selector: string; decls: Record<string, string>; order: number }
export function parseCss(css: string): Rule[] {
  const out: Rule[] = [];
  let order = 0;
  const walk = (src: string, media: string | null): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (j < src.length && depth > 0) { const c = src[j]; if (c === "{") depth++; else if (c === "}") depth--; j++; }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(body, prelude.slice(6).trim());
      else if (!prelude.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const d of body.split(";")) {
          const k = d.indexOf(":"); if (k < 0) continue;
          decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim();
        }
        out.push({ media, selector: prelude.replace(/\s+/g, " "), decls, order: order++ });
      }
      i = j;
    }
  };
  walk(stripCss(css), null);
  return out;
}
export const cssRules = (rel: string): Rule[] => parseCss(read(rel));
export const rulesFor = (rules: Rule[], selRe: RegExp, media?: RegExp | null): Rule[] =>
  rules.filter((r) => r.selector.split(",").some((s) => selRe.test(s.trim())) && (media === undefined ? true : media === null ? r.media === null : r.media !== null && media.test(r.media)));
export const declsOf = (rs: Rule[]): Record<string, string> => Object.assign({}, ...rs.map((r) => r.decls));
export const varsUsed = (v: string): string[] => [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string);
export const definedTokens = (): Set<string> => new Set([...stripCss(read("styles/tokens.css")).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));
export const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;

function specificity(sel: string): [number, number, number] {
  let s = sel.replace(/"[^"]*"|'[^']*'/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length; s = s.replace(/#[\w-]+/g, " ");
  const attrs = (s.match(/\[[^\]]*\]/g) ?? []).length; s = s.replace(/\[[^\]]*\]/g, " ");
  const cls = (s.match(/\.[\w-]+/g) ?? []).length; s = s.replace(/\.[\w-]+/g, " ");
  const pseudoEl = (s.match(/::[\w-]+/g) ?? []).length; s = s.replace(/::[\w-]+/g, " ");
  const pseudoCl = (s.match(/:[\w-]+(\([^)]*\))?/g) ?? []).length; s = s.replace(/:[\w-]+(\([^)]*\))?/g, " ");
  const els = (s.match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return [ids, cls + attrs + pseudoCl, els + pseudoEl];
}
const norm = (p: string): string => (p === "background" ? "background-color" : p);
/** Winning declared value of `prop` for `el` across `sheets` (in load order); unconditional rules only. */
export function winning(el: Element, prop: string, sheets: Rule[][]): string | undefined {
  let best: { v: string; spec: [number, number, number]; key: number } | undefined;
  let key = 0;
  for (const rules of sheets) {
    for (const r of rules) {
      key++;
      if (r.media !== null) continue;
      for (const sel of r.selector.split(",").map((x) => x.trim())) {
        let hit = false;
        try { hit = el.matches(sel); } catch { hit = false; }
        if (!hit) continue;
        for (const [p, v] of Object.entries(r.decls)) {
          if (norm(p) !== norm(prop)) continue;
          const sp = specificity(sel);
          const imp = /!important/.test(v) ? 1 : 0;
          const cur: [number, number, number] = [sp[0] + imp * 1000, sp[1], sp[2]];
          if (best === undefined || cur[0] > best.spec[0] || (cur[0] === best.spec[0] && (cur[1] > best.spec[1] || (cur[1] === best.spec[1] && (cur[2] > best.spec[2] || (cur[2] === best.spec[2] && key >= best.key)))))) {
            best = { v: v.replace(/!important/, "").trim(), spec: cur, key };
          }
        }
      }
    }
  }
  return best?.v;
}

/* ---- sheets the hosted wall loads (hosting/index.html <link>s or css imports in hosting/src/main.ts), in load order ---- */
export interface HostedSheet { how: "html" | "ts"; ref: string; file: string; resolves: boolean }
export function hostedSheets(): HostedSheet[] {
  const out: HostedSheet[] = [];
  const html = read("hosting/index.html");
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]; if (href === undefined) continue;
    const base = href.split("?")[0] as string;
    const cands = [resolve(ROOT, "hosting", base.replace(/^\//, "")), resolve(ROOT, "hosting/public", base.replace(/^\//, ""))];
    out.push({ how: "html", ref: href, file: base.split("/").pop() as string, resolves: !/^https?:/.test(href) && cands.some((c) => existsSync(c)) });
  }
  const ts = stripTs(read("hosting/src/main.ts"));
  for (const m of ts.matchAll(/^\s*import\s+(?:[\w{}*\s,]+\s+from\s+)?["']([^"']+\.css)(\?[^"']*)?["']/gm)) {
    const ref = m[1] as string;
    out.push({ how: "ts", ref, file: ref.split("/").pop() as string, resolves: existsSync(resolve(dirname(resolve(ROOT, "hosting/src/main.ts")), ref)) });
  }
  return out;
}
export const hostedOrder = (): string[] => {
  const s = hostedSheets();
  const how = s.some((x) => x.how === "html") ? "html" : "ts";
  return s.filter((x) => x.how === how).map((x) => x.file);
};
export const hostedRules = (): Rule[][] => hostedOrder().filter((f) => exists(`styles/${f}`)).map((f) => cssRules(`styles/${f}`));
