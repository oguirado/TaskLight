import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RoomAct, RoomEvent } from "../../../src/agents/types";
import { ROUTE_TARGETS } from "../../../src/router/types";
import type { RouteDecision, RouteRule, RouteTable } from "../../../src/router/types";

export const ACTS: readonly RoomAct[] = ["open", "plan", "step", "question", "answer", "handoff", "ack", "heartbeat", "verdict", "close"];

export function ev(act: RoomAct, text: string, extra: Partial<Pick<RoomEvent, "to" | "re" | "agent" | "plan" | "step">> = {}): RoomEvent {
  const base: RoomEvent = { id: "e-1", lamport: 1, ts: 1_700_000_000_000, room: "room-a", agent: extra.agent ?? "codex", act, text };
  if (extra.to !== undefined) base.to = extra.to;
  if (extra.re !== undefined) base.re = extra.re;
  if (extra.plan !== undefined) base.plan = extra.plan;
  if (extra.step !== undefined) base.step = extra.step;
  return base;
}

/** One realistic event per act (ES/EN, with and without accents). */
export const EVENT_PER_ACT: readonly RoomEvent[] = [
  ev("open", "Abro la sala para revisar la migración"),
  ev("plan", "Plan: 1) migrar esquema 2) pruebas", { plan: { title: "Migración", steps: [{ text: "migrar esquema" }, { text: "pruebas", accept: "verde" }] } }),
  ev("step", "Step 2 done: tests green", { step: { index: 1, state: "done", outcome: "34 passed", took: "12s" } }),
  ev("question", "¿Puedes revisar el fallo del test?", { to: "claude-code" }),
  ev("answer", "El cambio de planificacion queda para mañana"),
  ev("handoff", "Handing off to the reviewer with full context", { to: "reviewer" }),
  ev("ack", "ok, gracias"),
  ev("heartbeat", ""),
  ev("verdict", "needs_user: cannot pick between two migrations"),
  ev("close", "Cierro la sala: todo entregado"),
];

export const ANCHORS: readonly { text: string; target: RouteDecision["target"] }[] = [
  { text: "cambio de planificación", target: "plan_change" },
  { text: "cambio de planificacion", target: "plan_change" },
  { text: "What is the status of the build?", target: "status_query" },
  { text: "¿Cómo va el estado del proyecto?", target: "status_query" },
  { text: "focus the capsule", target: "focus_capsule" },
  { text: "ok thanks", target: "ack_noise" },
];

export const ACCENT_PAIRS: readonly (readonly [string, string])[] = [
  ["cambio de planificación", "cambio de planificacion"],
  ["¿Cómo va el estado del proyecto?", "como va el estado del proyecto"],
  ["enfoca la cápsula del agente", "enfoca la capsula del agente"],
  ["necesito aprobación del usuario", "necesito aprobacion del usuario"],
  ["traspaso de tarea", "TRASPASO DE TAREA"],
];

export const HOSTILE: readonly string[] = [
  "", " ", "\n\t\r", "\u0000", "a\u0000b", "<script>alert(1)</script>", "<img src=x onerror=alert(1)>",
  "'; DROP TABLE rooms; --", "${process.exit(1)}", "{{constructor.constructor('return this')()}}",
  "__proto__", "constructor", "toString", "hasOwnProperty", "prototype", "__proto__.polluted = 1",
  "(?:a+)+$", "a".repeat(50) + "!", "(".repeat(5000), "[".repeat(5000), "\\".repeat(2001),
  "x".repeat(1_000_000), "palabra ".repeat(200_000),
  "\uD800", "\uDC00x\uD800", "𝔭𝔩𝔞𝔫 𝔠𝔥𝔞𝔫𝔤𝔢", "ＰＬＡＮ　ＣＨＡＮＧＥ", "‮plan change‬", "​‍﻿",
  "é".repeat(50_000), "́".repeat(10_000), "🔥".repeat(10_000), "ñandú ß İstanbul ǅ ﬁ",
  "PlanChange_planChange-plan.change", "a_b__c___d", "ÀÉÎÕÜ àéîõü", "\\u0000\\n\\x00", "javascript:alert(1)", "../../etc/passwd",
  "@", "@@", "@ ", "@__proto__", "@claude-code@codex", "@" + "a".repeat(5000),
];

export const GOLDEN_PATH = resolve(__dirname, "golden.jsonl");
export interface GoldenRow { lang: "es" | "en"; act: RoomAct; text: string; expect: string; slice: "main" | "control"; to?: string }
export function loadGolden(): GoldenRow[] {
  return readFileSync(GOLDEN_PATH, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as GoldenRow);
}

export function rule(id: string, target: RouteRule["target"], terms: string[], extra: Partial<RouteRule> = {}): RouteRule {
  return { id, target, terms, ...extra };
}
export function table(rules: RouteRule[], bilingual: Record<string, string> = {}): RouteTable {
  return { version: 1, rules, bilingual };
}

/** Two rules with identical vocabulary and different targets: a genuine tie. */
export const TIE_TABLE: RouteTable = table([
  rule("r.alpha", "status_query", ["deploy", "release", "pipeline"]),
  rule("r.beta", "handoff", ["deploy", "release", "pipeline"]),
]);
export const TIE_TEXT = "deploy release pipeline";

/** A clearly separated two-rule table (control for the tie). */
export const CLEAR_TABLE: RouteTable = table([
  rule("c.status", "status_query", ["status", "progress", "estado"]),
  rule("c.handoff", "handoff", ["handoff", "transfer", "traspaso"]),
]);

export const VALID_STAGES = ["exact", "lexical", "nano"] as const;
export const VALID_STATUS = ["OK", "ABSTAIN", "NO_MATCH", "ERROR"] as const;

/** Shape invariants every decision must satisfy. */
export function decisionProblems(d: RouteDecision): string[] {
  const p: string[] = [];
  if (!VALID_STATUS.includes(d.status)) p.push("status");
  if (!(ROUTE_TARGETS as readonly string[]).includes(d.target)) p.push("target");
  for (const k of ["scorePpm", "coveragePpm"] as const) if (!Number.isInteger(d[k]) || d[k] < 0) p.push(k);
  if (!Number.isInteger(d.coveragePpm) || d.coveragePpm > 1_000_000) p.push("coverage range");
  if (!Number.isInteger(d.marginPpm)) p.push("marginPpm");
  if (!Array.isArray(d.matched) || d.matched.some((m) => typeof m !== "string")) p.push("matched");
  if (typeof d.tableHash !== "string" || !/^[0-9a-f]{64}$/.test(d.tableHash)) p.push("tableHash");
  if (d.status !== "OK" && d.target !== "inbox") p.push("non-OK must go to inbox");
  if (d.status === "OK" && d.stage === undefined) p.push("OK needs stage");
  if (d.status === "OK" && d.reason !== undefined) p.push("OK has no reason");
  if (d.status !== "OK" && d.reason === undefined && d.status !== "ERROR") p.push("abstention needs reason");
  return p;
}
