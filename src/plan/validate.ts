import type { PlanningTemplate, TemplateRejectCode, PlanOpEvent, PlanOpErrorCode } from "./types";
import { PLAN_LIMITS, ROOM_RE, AGENT_RE, OP_ID_RE, TASK_ID_RE, MICRO_ID_RE } from "./limits";

const DANGEROUS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TS_MAX_ABS = 8.64e15;

const encoder = new TextEncoder();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  try {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  } catch { return false; }
}

function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}
function codePointLen(s: string): number {
  return [...s].length;
}
function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && typeof v !== "boolean" && Number.isSafeInteger(v);
}

function isArrayIndexKey(k: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(k)) return false;
  const n = Number(k);
  return Number.isSafeInteger(n) && n < 4294967295;
}

function isJsonSafeValue(v: unknown, seen: Set<object>, depth: number): boolean {
  if (depth > 128) return false;
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return typeof v === "number" && (v as number) !== undefined ? Number.isFinite(v as number) : false;
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") return false;
  // object
  try {
    const obj = v as object;
    if (seen.has(obj)) return false;
    if (Array.isArray(v)) {
      if (Object.getOwnPropertySymbols(v).length > 0) return false;
      const descs = Object.getOwnPropertyDescriptors(v) as Record<string, PropertyDescriptor>;
      for (const k of Object.keys(descs)) {
        if (k === "length") continue;
        if (DANGEROUS.has(k)) return false;
        if (!isArrayIndexKey(k)) return false;
        const d = descs[k];
        if (!d || d.get !== undefined || d.set !== undefined) return false;
        seen.add(obj);
        try {
          if (!isJsonSafeValue(d.value, seen, depth + 1)) return false;
        } finally { seen.delete(obj); }
      }
      return true;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(v).length > 0) return false;
    const descs = Object.getOwnPropertyDescriptors(v) as Record<string, PropertyDescriptor>;
    for (const k of Object.keys(descs)) {
      if (DANGEROUS.has(k)) return false;
    }
    seen.add(obj);
    try {
      for (const k of Object.keys(descs)) {
        const d = descs[k];
        if (!d || d.get !== undefined || d.set !== undefined) return false;
        if (!isJsonSafeValue(d.value, seen, depth + 1)) return false;
      }
    } finally { seen.delete(obj); }
    return true;
  } catch { return false; }
}

function collectionHasDangerousKey(arr: unknown): boolean {
  try {
    const descs = Object.getOwnPropertyDescriptors(arr as object) as Record<string, PropertyDescriptor>;
    for (const k of Object.keys(descs)) {
      if (DANGEROUS.has(k)) return true;
    }
    if (Object.getOwnPropertySymbols(arr as object).length > 0) return true;
    return false;
  } catch { return true; }
}

export function hasDangerousOwnKey(v: unknown): boolean {
  try {
    if (v === null || typeof v !== "object") return false;
    const descs = Object.getOwnPropertyDescriptors(v as object) as Record<string, PropertyDescriptor>;
    for (const k of Object.keys(descs)) if (DANGEROUS.has(k)) return true;
    return false;
  } catch { return true; }
}

function canonicalJsonString(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(v) as string;
  if (Array.isArray(v)) return `[${(v as unknown[]).map(canonicalJsonString).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(`${JSON.stringify(k)}:${canonicalJsonString(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function canonicalOpByteLength(op: Record<string, unknown>): number {
  const s = canonicalJsonString(op);
  return utf8Bytes(s);
}

function safeGetRecord(v: unknown, key: string): { has: boolean; value?: unknown; accessor?: boolean } {
  try {
    const descs = Object.getOwnPropertyDescriptors(v as object) as Record<string, PropertyDescriptor>;
    if (!(key in descs)) return { has: false };
    const d = descs[key];
    if (!d) return { has: false };
    if (d.get !== undefined || d.set !== undefined) return { has: true, accessor: true };
    return { has: true, value: d.value };
  } catch { return { has: false }; }
}

// Template validation helpers
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}
function hasCodeLike(s: string): boolean {
  return s.includes("<") || s.includes(">") || s.includes("://") || s.toLowerCase().includes("javascript:");
}

type TErr = { code: TemplateRejectCode; path: string; detail?: string };

function checkTextField(
  errs: TErr[], value: unknown, path: string, maxLen: number, overCode: TemplateRejectCode,
): void {
  if (typeof value !== "string") { errs.push({ code: "WRONG_TYPE", path }); return; }
  if (hasControl(value)) errs.push({ code: "CONTROL_CHAR", path });
  if (hasCodeLike(value)) errs.push({ code: "CODE_LIKE", path });
  if (codePointLen(value) > maxLen) errs.push({ code: overCode, path });
}

function checkSlugField(errs: TErr[], value: unknown, path: string, maxLen = 48): void {
  if (typeof value !== "string") { errs.push({ code: "WRONG_TYPE", path }); return; }
  if (hasControl(value)) errs.push({ code: "CONTROL_CHAR", path });
  if (hasCodeLike(value)) errs.push({ code: "CODE_LIKE", path });
  if (codePointLen(value) > maxLen) errs.push({ code: "LIMIT_EXCEEDED", path });
  if (!SLUG_RE.test(value)) {
    // Avoid double-reporting control/code-only failures as an extra format error when already flagged;
    // but still flag format for non-control/code strings.
    if (!hasControl(value) && !hasCodeLike(value)) errs.push({ code: "WRONG_TYPE", path });
    else if (!SLUG_RE.test(value) && !hasControl(value) && !hasCodeLike(value)) errs.push({ code: "WRONG_TYPE", path });
    else {
      // For control/code payloads in slug positions, format also fails; tests only require CONTROL_CHAR/CODE_LIKE presence.
      // We already pushed those; do not push WRONG_TYPE to keep diagnostics clean.
    }
  }
}

function cloneDeep<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return (v as unknown[]).map((x) => cloneDeep(x)) as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>)) {
    out[k] = cloneDeep((v as Record<string, unknown>)[k]);
  }
  return out as T;
}

export function validateTemplate(raw: unknown):
  | { ok: true; template: PlanningTemplate }
  | { ok: false; errors: readonly TErr[] } {
  try {
    const errs: TErr[] = [];
    // NOT_PLAIN / JSON safety
    let plainOk = false;
    try { plainOk = isPlainObject(raw); } catch { plainOk = false; }
    if (!plainOk) {
      return { ok: false, errors: [{ code: "NOT_PLAIN", path: "" }] };
    }
    // JSON safety (dangerous keys, cycles, non-JSON, accessors)
    let safe = false;
    try { safe = isJsonSafeValue(raw, new Set(), 0); } catch { safe = false; }
    if (!safe) {
      return { ok: false, errors: [{ code: "NOT_PLAIN", path: "" }] };
    }
    const rec = raw as Record<string, unknown>;
    const TOP = new Set(["v", "id", "name", "summary", "lens_id", "brief_fields", "phases", "task_types", "granularity", "memory_sections", "hash"]);
    for (const k of Object.keys(rec)) {
      if (!TOP.has(k)) errs.push({ code: "UNKNOWN_FIELD", path: k });
    }
    const REQUIRED = ["v", "id", "name", "summary", "brief_fields", "phases", "task_types", "granularity", "memory_sections"] as const;
    for (const k of REQUIRED) {
      if (!(k in rec)) errs.push({ code: "MISSING_FIELD", path: k });
    }
    // v
    if ("v" in rec) {
      const v = rec["v"];
      if (!isSafeInt(v) || v !== 1) errs.push({ code: "BAD_VERSION", path: "v" });
    }
    // id
    if ("id" in rec) checkSlugField(errs, rec["id"], "id");
    // name
    if ("name" in rec) {
      const v = rec["name"];
      if (typeof v !== "string") errs.push({ code: "WRONG_TYPE", path: "name" });
      else {
        if (hasControl(v)) errs.push({ code: "CONTROL_CHAR", path: "name" });
        if (hasCodeLike(v)) errs.push({ code: "CODE_LIKE", path: "name" });
        if (codePointLen(v) > PLAN_LIMITS.TEMPLATE_NAME_MAX) errs.push({ code: "BAD_NAME", path: "name" });
      }
    }
    if ("summary" in rec) checkTextField(errs, rec["summary"], "summary", 240, "LIMIT_EXCEEDED");
    if ("lens_id" in rec) checkSlugField(errs, rec["lens_id"], "lens_id", 40);
    if ("hash" in rec) {
      const h = rec["hash"];
      if (typeof h !== "string" || !SHA256_RE.test(h)) errs.push({ code: "WRONG_TYPE", path: "hash" });
    }

    if ("brief_fields" in rec) {
      const bf = rec["brief_fields"];
      if (!Array.isArray(bf)) errs.push({ code: "WRONG_TYPE", path: "brief_fields" });
      else {
        if (bf.length > PLAN_LIMITS.BRIEF_FIELDS_MAX) errs.push({ code: "LIMIT_EXCEEDED", path: "brief_fields" });
        const ids = new Set<string>();
        bf.forEach((item, i) => {
          const p = `brief_fields.${i}`;
          if (!isPlainObject(item)) { errs.push({ code: "WRONG_TYPE", path: p }); return; }
          const r = item as Record<string, unknown>;
          for (const k of Object.keys(r)) if (!["id", "label", "required"].includes(k)) errs.push({ code: "UNKNOWN_FIELD", path: `${p}.${k}` });
          for (const k of ["id", "label", "required"]) if (!(k in r)) errs.push({ code: "MISSING_FIELD", path: `${p}.${k}` });
          if ("id" in r) {
            checkSlugField(errs, r["id"], `${p}.id`);
            if (typeof r["id"] === "string") {
              if (ids.has(r["id"])) errs.push({ code: "DUPLICATE_ID", path: `${p}.id` });
              ids.add(r["id"]);
            }
          }
          if ("label" in r) checkTextField(errs, r["label"], `${p}.label`, 60, "LIMIT_EXCEEDED");
          if ("required" in r && typeof r["required"] !== "boolean") errs.push({ code: "WRONG_TYPE", path: `${p}.required` });
        });
      }
    }
    if ("phases" in rec) {
      const ph = rec["phases"];
      if (!Array.isArray(ph)) errs.push({ code: "WRONG_TYPE", path: "phases" });
      else {
        if (ph.length < 1 || ph.length > PLAN_LIMITS.PHASES_MAX) errs.push({ code: "LIMIT_EXCEEDED", path: "phases" });
        const ids = new Set<string>();
        ph.forEach((item, i) => {
          const p = `phases.${i}`;
          if (!isPlainObject(item)) { errs.push({ code: "WRONG_TYPE", path: p }); return; }
          const r = item as Record<string, unknown>;
          for (const k of Object.keys(r)) if (!["id", "label", "exit"].includes(k)) errs.push({ code: "UNKNOWN_FIELD", path: `${p}.${k}` });
          for (const k of ["id", "label", "exit"]) if (!(k in r)) errs.push({ code: "MISSING_FIELD", path: `${p}.${k}` });
          if ("id" in r) {
            checkSlugField(errs, r["id"], `${p}.id`);
            if (typeof r["id"] === "string") {
              if (ids.has(r["id"])) errs.push({ code: "DUPLICATE_ID", path: `${p}.id` });
              ids.add(r["id"]);
            }
          }
          if ("label" in r) checkTextField(errs, r["label"], `${p}.label`, 60, "LIMIT_EXCEEDED");
          if ("exit" in r) checkTextField(errs, r["exit"], `${p}.exit`, 160, "LIMIT_EXCEEDED");
        });
      }
    }
    if ("task_types" in rec) {
      const tt = rec["task_types"];
      if (!Array.isArray(tt)) errs.push({ code: "WRONG_TYPE", path: "task_types" });
      else {
        if (tt.length < 1 || tt.length > PLAN_LIMITS.TASK_TYPES_MAX) errs.push({ code: "LIMIT_EXCEEDED", path: "task_types" });
        const ids = new Set<string>();
        tt.forEach((item, i) => {
          const p = `task_types.${i}`;
          if (!isPlainObject(item)) { errs.push({ code: "WRONG_TYPE", path: p }); return; }
          const r = item as Record<string, unknown>;
          for (const k of Object.keys(r)) if (!["id", "label", "accept_required", "evidence_required", "micro_hints"].includes(k)) errs.push({ code: "UNKNOWN_FIELD", path: `${p}.${k}` });
          for (const k of ["id", "label", "accept_required", "evidence_required", "micro_hints"]) if (!(k in r)) errs.push({ code: "MISSING_FIELD", path: `${p}.${k}` });
          if ("id" in r) {
            checkSlugField(errs, r["id"], `${p}.id`);
            if (typeof r["id"] === "string") {
              if (ids.has(r["id"])) errs.push({ code: "DUPLICATE_ID", path: `${p}.id` });
              ids.add(r["id"]);
            }
          }
          if ("label" in r) checkTextField(errs, r["label"], `${p}.label`, 60, "LIMIT_EXCEEDED");
          if ("accept_required" in r && typeof r["accept_required"] !== "boolean") errs.push({ code: "WRONG_TYPE", path: `${p}.accept_required` });
          if ("evidence_required" in r && typeof r["evidence_required"] !== "boolean") errs.push({ code: "WRONG_TYPE", path: `${p}.evidence_required` });
          if ("micro_hints" in r) {
            const h = r["micro_hints"];
            if (!Array.isArray(h)) errs.push({ code: "WRONG_TYPE", path: `${p}.micro_hints` });
            else {
              if (h.length > 12) errs.push({ code: "LIMIT_EXCEEDED", path: `${p}.micro_hints` });
              h.forEach((x, j) => checkTextField(errs, x, `${p}.micro_hints.${j}`, 80, "LIMIT_EXCEEDED"));
            }
          }
        });
      }
    }
    if ("granularity" in rec) {
      const g = rec["granularity"];
      if (!isPlainObject(g)) errs.push({ code: "WRONG_TYPE", path: "granularity" });
      else {
        const gr = g as Record<string, unknown>;
        for (const k of Object.keys(gr)) if (!["tasks_max", "micro_min", "micro_max", "rule"].includes(k)) errs.push({ code: "UNKNOWN_FIELD", path: `granularity.${k}` });
        for (const k of ["tasks_max", "micro_min", "micro_max", "rule"]) if (!(k in gr)) errs.push({ code: "MISSING_FIELD", path: `granularity.${k}` });
        const nums: Array<[string, number, number]> = [["tasks_max", 1, 40], ["micro_min", 1, 12], ["micro_max", 1, 12]];
        let granBad = false;
        for (const [f, lo, hi] of nums) {
          if (f in gr) {
            const v = gr[f];
            if (!isSafeInt(v)) { errs.push({ code: "WRONG_TYPE", path: `granularity.${f}` }); granBad = true; }
            else if (v < lo || v > hi) { errs.push({ code: "BAD_GRANULARITY", path: `granularity.${f}` }); granBad = true; }
          }
        }
        if (isSafeInt(gr["micro_min"]) && isSafeInt(gr["micro_max"]) && (gr["micro_min"] as number) > (gr["micro_max"] as number)) {
          errs.push({ code: "BAD_GRANULARITY", path: "granularity" });
        }
        void granBad;
        if ("rule" in gr) checkTextField(errs, gr["rule"], "granularity.rule", 240, "LIMIT_EXCEEDED");
      }
    }
    if ("memory_sections" in rec) {
      const ms = rec["memory_sections"];
      if (!Array.isArray(ms)) errs.push({ code: "WRONG_TYPE", path: "memory_sections" });
      else {
        if (ms.length > PLAN_LIMITS.MEMORY_SECTIONS_MAX) errs.push({ code: "LIMIT_EXCEEDED", path: "memory_sections" });
        const ids = new Set<string>();
        ms.forEach((item, i) => {
          const p = `memory_sections.${i}`;
          if (!isPlainObject(item)) { errs.push({ code: "WRONG_TYPE", path: p }); return; }
          const r = item as Record<string, unknown>;
          for (const k of Object.keys(r)) if (!["id", "label", "required", "max_chars", "hint"].includes(k)) errs.push({ code: "UNKNOWN_FIELD", path: `${p}.${k}` });
          for (const k of ["id", "label", "required", "max_chars", "hint"]) if (!(k in r)) errs.push({ code: "MISSING_FIELD", path: `${p}.${k}` });
          if ("id" in r) {
            checkSlugField(errs, r["id"], `${p}.id`);
            if (typeof r["id"] === "string") {
              if (ids.has(r["id"])) errs.push({ code: "DUPLICATE_ID", path: `${p}.id` });
              ids.add(r["id"]);
            }
          }
          if ("label" in r) checkTextField(errs, r["label"], `${p}.label`, 60, "LIMIT_EXCEEDED");
          if ("required" in r && typeof r["required"] !== "boolean") errs.push({ code: "WRONG_TYPE", path: `${p}.required` });
          if ("max_chars" in r) {
            const v = r["max_chars"];
            if (!isSafeInt(v)) errs.push({ code: "WRONG_TYPE", path: `${p}.max_chars` });
            else if (v < 1 || v > PLAN_LIMITS.MEMORY_CHARS_MAX) errs.push({ code: "LIMIT_EXCEEDED", path: `${p}.max_chars` });
          }
          if ("hint" in r) checkTextField(errs, r["hint"], `${p}.hint`, 160, "LIMIT_EXCEEDED");
        });
      }
    }

    if (errs.length > 0) return { ok: false, errors: errs };
    const template = cloneDeep(rec) as unknown as PlanningTemplate;
    return { ok: true, template };
  } catch {
    return { ok: false, errors: [{ code: "NOT_PLAIN", path: "" }] };
  }
}

// Operation shape validation returning error code (null = ok)
const OP_KINDS: ReadonlySet<string> = new Set([
  "plan.open", "plan.close", "plan.phase",
  "task.add", "task.set", "task.claim", "task.release",
  "micro.add", "micro.set", "memory.set", "activity.beat", "agent.lifecycle",
]);

function strLenCheck(v: unknown, lo: number, hi: number): PlanOpErrorCode | null {
  if (typeof v !== "string") return "bad_op";
  const n = codePointLen(v);
  if (n < lo) return "bad_op";
  if (n > hi) return "bad_op";
  return null;
}
function slugCheck(v: unknown): PlanOpErrorCode | null {
  if (typeof v !== "string" || !SLUG_RE.test(v)) return "bad_op";
  return null;
}
function baseRevCheck(v: unknown, lo: number): PlanOpErrorCode | null {
  if (!isSafeInt(v) || (v as number) < lo) return "bad_op";
  return null;
}
function hasOwn(rec: Record<string, unknown>, k: string): boolean {
  try { return Object.prototype.hasOwnProperty.call(rec, k); } catch { return false; }
}

function fullMatch(pattern: RegExp, value: unknown): boolean {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

function resultText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && codePointLen(value) <= maximum
    && !Array.from(value).some(ch => {
      const point = ch.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    });
}

function validAgentResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const fields = ["verdict", "summary", "receipt", "evidence"];
  if (!hasOwn(value, "verdict") || Object.keys(value).some(key => !fields.includes(key))) return false;
  if (typeof value["verdict"] !== "string" || !["ADMIT", "HOLD", "NO_PUDE", "OK", "FAIL"].includes(value["verdict"])) return false;
  if (hasOwn(value, "summary") && !resultText(value["summary"], 2000)) return false;
  if (hasOwn(value, "receipt") && !resultText(value["receipt"], 512)) return false;
  if (!hasOwn(value, "evidence")) return true;
  const evidence = value["evidence"];
  return Array.isArray(evidence) && evidence.length <= 32 && evidence.every(item =>
    isPlainObject(item) && Object.keys(item).length === 2 && hasOwn(item, "path") && hasOwn(item, "sha256")
    && resultText(item["path"], 512)
    && fullMatch(/^[0-9a-fA-F]{64}$/, item["sha256"]));
}

export function validateOpShapeCode(op: Record<string, unknown>): PlanOpErrorCode | null {
  try {
    if (!isPlainObject(op)) return "bad_op";
    if (!isJsonSafeValue(op, new Set(), 0)) return "bad_op";
    // Terminal results have their own field bounds, separate from the legacy
    // operation byte cap (including summaries containing astral characters).
    const hasResult = op["kind"] === "agent.lifecycle" && hasOwn(op, "result");
    if (hasResult && ((op["state"] !== "finished" && op["state"] !== "failed") || !validAgentResult(op["result"]))) return "bad_op";
    const byteOp = hasResult ? Object.fromEntries(Object.entries(op).filter(([key]) => key !== "result")) : op;
    let blen = 0;
    try { blen = canonicalOpByteLength(byteOp); } catch { return "bad_op"; }
    if (blen > PLAN_LIMITS.OP_PAYLOAD_MAX_BYTES) return "limit_exceeded";

    const kind = op["kind"];
    if (typeof kind !== "string" || !OP_KINDS.has(kind)) return "bad_op";
    if (hasOwn(op, "op_id")) {
      const v = op["op_id"];
      if (typeof v !== "string" || !OP_ID_RE.test(v)) return "bad_op";
    }
    const unknown = (allowed: ReadonlySet<string>): PlanOpErrorCode | null => {
      for (const k of Object.keys(op)) if (!allowed.has(k)) return "bad_op";
      return null;
    };

    if (kind === "agent.lifecycle") {
      const e = unknown(new Set(["kind", "state", "run_id", "swarm", "harness", "reason", "op_id", "parent_agent", "parent_run_id", "result"]));
      if (e) return e;
      if (typeof op["state"] !== "string" || !["deployed", "alive", "finished", "failed"].includes(op["state"])) return "bad_op";
      if (!fullMatch(/^[A-Za-z0-9_-]{1,64}$/, op["run_id"]) || !fullMatch(OP_ID_RE, op["op_id"])) return "bad_op";
      if (hasOwn(op, "parent_agent") && !fullMatch(AGENT_RE, op["parent_agent"])) return "bad_op";
      if (hasOwn(op, "parent_run_id") && !fullMatch(/^[A-Za-z0-9_-]{1,64}$/, op["parent_run_id"])) return "bad_op";
      for (const key of ["swarm", "harness", "reason"]) {
        if (!hasOwn(op, key)) continue;
        const value = op[key];
        const c = strLenCheck(value, key === "reason" ? 0 : 1, key === "reason" ? 512 : PLAN_LIMITS.PLAN_TITLE_MAX);
        if (c) return c;
        // Iterate Unicode scalars so valid astral pairs remain printable data.
        for (const ch of value as string) {
          const point = ch.codePointAt(0)!;
          if (point < 0x20 || (point >= 0x7f && point <= 0x9f) || (point >= 0xd800 && point <= 0xdfff)) return "bad_op";
        }
        if (key !== "reason" && !(value as string).trim()) return "bad_op";
      }
      return null;
    }
    if (kind === "activity.beat") {
      const e = unknown(new Set(["kind", "task_id", "micro_id", "run_id", "note", "op_id"]));
      if (e) return e;
      if (!fullMatch(TASK_ID_RE, op["task_id"]) || !fullMatch(OP_ID_RE, op["op_id"])) return "bad_op";
      if (!fullMatch(/^[A-Za-z0-9_-]{1,64}$/, op["run_id"])) return "bad_op";
      if (hasOwn(op, "micro_id") && !fullMatch(MICRO_ID_RE, op["micro_id"])) return "bad_op";
      if (hasOwn(op, "note")) {
        const c = strLenCheck(op["note"], 0, 240); if (c) return c;
        if (/[\x00-\x1f\x7f-\x9f]/.test(op["note"] as string)) return "bad_op";
      }
      return null;
    }
    if (kind === "plan.open") {
      const e = unknown(new Set(["kind", "op_id", "title", "template_id", "template_hash", "brief", "phase"]));
      if (e) return e;
      if (!hasOwn(op, "title") || !hasOwn(op, "template_id") || !hasOwn(op, "template_hash")) return "bad_op";
      const c1 = strLenCheck(op["title"], 1, PLAN_LIMITS.PLAN_TITLE_MAX); if (c1) return c1;
      const c2 = slugCheck(op["template_id"]); if (c2) return c2;
      const th = op["template_hash"];
      if (typeof th !== "string" || !SHA256_RE.test(th)) return "bad_op";
      if (hasOwn(op, "brief")) {
        const b = op["brief"];
        if (!isPlainObject(b)) return "bad_op";
        if (!isJsonSafeValue(b, new Set(), 0)) return "bad_op";
        for (const k of Object.keys(b as Record<string, unknown>)) {
          if (DANGEROUS.has(k)) return "bad_op";
          if (!SLUG_RE.test(k)) return "bad_op";
          const v = (b as Record<string, unknown>)[k];
          if (typeof v !== "string") return "bad_op";
          if (codePointLen(v) > 400) return "bad_op";
        }
      }
      if (hasOwn(op, "phase")) { const c = slugCheck(op["phase"]); if (c) return c; }
      return null;
    }
    if (kind === "plan.close") {
      const e = unknown(new Set(["kind", "op_id", "base_rev", "outcome"])); if (e) return e;
      if (!hasOwn(op, "base_rev")) return "bad_op";
      const c = baseRevCheck(op["base_rev"], 1); if (c) return c;
      if (hasOwn(op, "outcome")) {
        if (op["outcome"] === null) return "bad_op";
        const c2 = strLenCheck(op["outcome"], 0, PLAN_LIMITS.MICRO_OUTCOME_MAX); if (c2) return c2;
      }
      return null;
    }
    if (kind === "plan.phase") {
      const e = unknown(new Set(["kind", "op_id", "base_rev", "phase"])); if (e) return e;
      if (!hasOwn(op, "base_rev") || !hasOwn(op, "phase")) return "bad_op";
      const c = baseRevCheck(op["base_rev"], 1); if (c) return c;
      const c2 = slugCheck(op["phase"]); if (c2) return c2;
      return null;
    }
    if (kind === "task.add") {
      const e = unknown(new Set(["kind", "op_id", "base_rev", "title", "type", "phase", "accept", "deps", "assignee", "estimate", "microtasks"])); if (e) return e;
      if (!hasOwn(op, "title") || !hasOwn(op, "type") || !hasOwn(op, "phase")) return "bad_op";
      const c1 = strLenCheck(op["title"], 1, PLAN_LIMITS.TASK_TITLE_MAX); if (c1) return c1;
      const c2 = slugCheck(op["type"]); if (c2) return c2;
      const c3 = slugCheck(op["phase"]); if (c3) return c3;
      if (hasOwn(op, "base_rev")) { const c = baseRevCheck(op["base_rev"], 0); if (c) return c; }
      if (hasOwn(op, "accept")) {
        if (op["accept"] === null) return "bad_op";
        const c = strLenCheck(op["accept"], 0, PLAN_LIMITS.TASK_ACCEPT_MAX); if (c) return c;
      }
      if (hasOwn(op, "deps")) {
        const deps = op["deps"];
        if (!Array.isArray(deps)) return "bad_op";
        if (deps.length > PLAN_LIMITS.TASK_DEPS_MAX) return "limit_exceeded";
        const seen = new Set<string>();
        for (const d of deps) {
          if (typeof d !== "string" || !TASK_ID_RE.test(d)) return "bad_op";
          if (seen.has(d)) return "bad_op";
          seen.add(d);
        }
      }
      if (hasOwn(op, "assignee")) {
        const a = op["assignee"];
        if (a !== null) {
          if (typeof a !== "string" || !AGENT_RE.test(a)) return "bad_op";
        }
      }
      if (hasOwn(op, "estimate")) {
        const v = op["estimate"];
        if (v !== null) {
          if (typeof v !== "string") return "bad_op";
          if (codePointLen(v) > PLAN_LIMITS.TASK_ESTIMATE_MAX) return "bad_op";
        }
      }
      if (hasOwn(op, "microtasks")) {
        const mts = op["microtasks"];
        if (!Array.isArray(mts)) return "bad_op";
        if (mts.length > PLAN_LIMITS.MICROS_MAX) return "limit_exceeded";
        for (const m of mts) {
          if (!isPlainObject(m)) return "bad_op";
          const mr = m as Record<string, unknown>;
          for (const k of Object.keys(mr)) if (!["text", "accept"].includes(k)) return "bad_op";
          if (!hasOwn(mr, "text")) return "bad_op";
          const ct = strLenCheck(mr["text"], 1, PLAN_LIMITS.MICRO_TEXT_MAX); if (ct) return ct;
          if (hasOwn(mr, "accept")) {
            if (mr["accept"] === null) return "bad_op";
            const ca = strLenCheck(mr["accept"], 0, PLAN_LIMITS.MICRO_ACCEPT_MAX); if (ca) return ca;
          }
        }
      }
      return null;
    }
    if (kind === "task.set") {
      const e = unknown(new Set(["kind", "op_id", "task_id", "base_rev", "title", "type", "phase", "accept", "deps", "estimate", "state", "reason"])); if (e) return e;
      if (!hasOwn(op, "task_id") || !hasOwn(op, "base_rev")) return "bad_op";
      if (typeof op["task_id"] !== "string" || !TASK_ID_RE.test(op["task_id"] as string)) return "bad_op";
      const c0 = baseRevCheck(op["base_rev"], 1); if (c0) return c0;
      const mut = ["title", "type", "phase", "accept", "deps", "estimate", "state", "reason"] as const;
      if (!mut.some((k) => hasOwn(op, k))) return "bad_op";
      if (hasOwn(op, "title")) { const c = strLenCheck(op["title"], 1, PLAN_LIMITS.TASK_TITLE_MAX); if (c) return c; }
      if (hasOwn(op, "type")) { const c = slugCheck(op["type"]); if (c) return c; }
      if (hasOwn(op, "phase")) { const c = slugCheck(op["phase"]); if (c) return c; }
      if (hasOwn(op, "accept")) {
        if (op["accept"] === null) return "bad_op";
        const c = strLenCheck(op["accept"], 0, PLAN_LIMITS.TASK_ACCEPT_MAX); if (c) return c;
      }
      if (hasOwn(op, "deps")) {
        const deps = op["deps"];
        if (!Array.isArray(deps)) return "bad_op";
        if (deps.length > PLAN_LIMITS.TASK_DEPS_MAX) return "limit_exceeded";
        const seen = new Set<string>();
        for (const d of deps) {
          if (typeof d !== "string" || !TASK_ID_RE.test(d)) return "bad_op";
          if (seen.has(d)) return "bad_op";
          seen.add(d);
        }
      }
      if (hasOwn(op, "estimate")) {
        const v = op["estimate"];
        if (v !== null) {
          if (typeof v !== "string") return "bad_op";
          if (codePointLen(v) > PLAN_LIMITS.TASK_ESTIMATE_MAX) return "bad_op";
        }
      }
      if (hasOwn(op, "state")) {
        const s = op["state"];
        if (s !== null && s !== "blocked" && s !== "cancelled") return "bad_op";
      }
      if (hasOwn(op, "reason")) {
        const r = op["reason"];
        if (r !== null) {
          if (typeof r !== "string") return "bad_op";
          if (codePointLen(r) > 240) return "bad_op";
        }
      }
      return null;
    }
    if (kind === "task.claim") {
      const e = unknown(new Set(["kind", "op_id", "task_id", "base_rev", "takeover"])); if (e) return e;
      if (!hasOwn(op, "task_id")) return "bad_op";
      if (typeof op["task_id"] !== "string" || !TASK_ID_RE.test(op["task_id"] as string)) return "bad_op";
      if (hasOwn(op, "base_rev")) { const c = baseRevCheck(op["base_rev"], 1); if (c) return c; }
      if (hasOwn(op, "takeover") && typeof op["takeover"] !== "boolean") return "bad_op";
      return null;
    }
    if (kind === "task.release") {
      const e = unknown(new Set(["kind", "op_id", "task_id", "base_rev", "claim_lamport"])); if (e) return e;
      if (hasOwn(op, "claim_lamport") && (!isSafeInt(op["claim_lamport"]) || op["claim_lamport"] <= 0)) return "bad_op";
      if (!hasOwn(op, "task_id")) return "bad_op";
      if (typeof op["task_id"] !== "string" || !TASK_ID_RE.test(op["task_id"] as string)) return "bad_op";
      if (hasOwn(op, "base_rev")) { const c = baseRevCheck(op["base_rev"], 1); if (c) return c; }
      return null;
    }
    if (kind === "micro.add") {
      const e = unknown(new Set(["kind", "op_id", "task_id", "base_rev", "text", "accept"])); if (e) return e;
      if (!hasOwn(op, "task_id") || !hasOwn(op, "base_rev") || !hasOwn(op, "text")) return "bad_op";
      if (typeof op["task_id"] !== "string" || !TASK_ID_RE.test(op["task_id"] as string)) return "bad_op";
      const c = baseRevCheck(op["base_rev"], 1); if (c) return c;
      const ct = strLenCheck(op["text"], 1, PLAN_LIMITS.MICRO_TEXT_MAX); if (ct) return ct;
      if (hasOwn(op, "accept")) {
        if (op["accept"] === null) return "bad_op";
        const ca = strLenCheck(op["accept"], 0, PLAN_LIMITS.MICRO_ACCEPT_MAX); if (ca) return ca;
      }
      return null;
    }
    if (kind === "micro.set") {
      const e = unknown(new Set(["kind", "op_id", "micro_id", "state", "outcome", "took", "evidence", "claim_lamport"])); if (e) return e;
      if (hasOwn(op, "claim_lamport") && (!isSafeInt(op["claim_lamport"]) || op["claim_lamport"] <= 0)) return "bad_op";
      if (!hasOwn(op, "micro_id") || !hasOwn(op, "state")) return "bad_op";
      if (typeof op["micro_id"] !== "string" || !MICRO_ID_RE.test(op["micro_id"] as string)) return "bad_op";
      const states: ReadonlySet<string> = new Set(["done", "active", "blocked", "pending"]);
      if (typeof op["state"] !== "string" || !states.has(op["state"] as string)) return "bad_op";
      if (hasOwn(op, "outcome")) {
        if (op["outcome"] === null) return "bad_op";
        const c = strLenCheck(op["outcome"], 0, PLAN_LIMITS.MICRO_OUTCOME_MAX); if (c) return c;
      }
      if (hasOwn(op, "took")) {
        if (op["took"] === null) return "bad_op";
        const c = strLenCheck(op["took"], 0, PLAN_LIMITS.MICRO_TOOK_MAX); if (c) return c;
      }
      if (hasOwn(op, "evidence")) {
        const ev = op["evidence"];
        if (!Array.isArray(ev)) return "bad_op";
        if (ev.length > PLAN_LIMITS.MICRO_EVIDENCE_MAX) return "limit_exceeded";
        for (const item of ev) {
          if (!isPlainObject(item)) return "bad_op";
          const ir = item as Record<string, unknown>;
          for (const k of Object.keys(ir)) if (!["path", "sha256"].includes(k)) return "bad_op";
          if (!hasOwn(ir, "path") || !hasOwn(ir, "sha256")) return "bad_op";
          if (typeof ir["path"] !== "string") return "bad_op";
          const pl = codePointLen(ir["path"] as string);
          if (pl < 1 || pl > 512) return "bad_op";
          if (typeof ir["sha256"] !== "string" || !SHA256_RE.test(ir["sha256"] as string)) return "bad_op";
        }
      }
      return null;
    }
    if (kind === "memory.set") {
      const e = unknown(new Set(["kind", "op_id", "section", "text", "base_rev"])); if (e) return e;
      if (!hasOwn(op, "section") || !hasOwn(op, "text") || !hasOwn(op, "base_rev")) return "bad_op";
      const c1 = slugCheck(op["section"]); if (c1) return c1;
      if (typeof op["text"] !== "string") return "bad_op";
      if (codePointLen(op["text"] as string) > PLAN_LIMITS.MEMORY_CHARS_MAX) return "bad_op";
      const c2 = baseRevCheck(op["base_rev"], 0); if (c2) return c2;
      return null;
    }
    return "bad_op";
  } catch { return "bad_op"; }
}

export function opEventErrorCode(raw: unknown): PlanOpErrorCode | null {
  try {
    if (!isPlainObject(raw)) return "bad_op";
    if (!isJsonSafeValue(raw, new Set(), 0)) return "bad_op";
    const ev = raw as Record<string, unknown>;
    if (!hasOwn(ev, "id") || !hasOwn(ev, "lamport") || !hasOwn(ev, "ts") || !hasOwn(ev, "room") || !hasOwn(ev, "agent") || !hasOwn(ev, "act") || !hasOwn(ev, "text") || !hasOwn(ev, "op")) {
      // Check byte overflow precedence for op even when envelope incomplete? op byte overflow => limit_exceeded
      // But missing fields are bad_op; overflow check still needed for limit mapping.
      // If op present and oversize, report limit_exceeded.
      if (hasOwn(ev, "op") && isPlainObject(ev["op"])) {
        try {
          if (canonicalOpByteLength(ev["op"] as Record<string, unknown>) > PLAN_LIMITS.OP_PAYLOAD_MAX_BYTES) return "limit_exceeded";
        } catch { /* fall through */ }
      }
      return "bad_op";
    }
    const id = ev["id"];
    if (typeof id !== "string" || id.length === 0) return "bad_op";
    const room = ev["room"];
    if (typeof room !== "string" || !ROOM_RE.test(room)) return "bad_op";
    const agent = ev["agent"];
    if (typeof agent !== "string" || !AGENT_RE.test(agent)) return "bad_op";
    if (ev["act"] !== "op") return "bad_op";
    const lam = ev["lamport"];
    if (!isSafeInt(lam) || (lam as number) < 1) return "bad_op";
    const ts = ev["ts"];
    if (!isSafeInt(ts) || Math.abs(ts as number) > TS_MAX_ABS) return "bad_op";
    const text = ev["text"];
    if (typeof text !== "string") return "bad_op";
    if (utf8Bytes(text as string) > PLAN_LIMITS.TEXT_MAX_BYTES) return "bad_op";
    const op = ev["op"];
    if (!isPlainObject(op)) return "bad_op";
    const shape = validateOpShapeCode(op as Record<string, unknown>);
    if (shape !== null) return shape;
    return null;
  } catch { return "bad_op"; }
}

export function validateOpEvent(raw: unknown): raw is PlanOpEvent {
  try {
    return opEventErrorCode(raw) === null;
  } catch { return false; }
}

// Exported for reducer/fold safely reading fields without invoking accessors
export function safeField(raw: unknown, key: string): { has: boolean; value: unknown } {
  try {
    if (!isPlainObject(raw) && !Array.isArray(raw)) return { has: false, value: undefined };
    const g = safeGetRecord(raw, key);
    if (g.accessor) return { has: true, value: undefined };
    return { has: g.has, value: g.value };
  } catch { return { has: false, value: undefined }; }
}

export function isPlainObjectExport(v: unknown): boolean {
  return isPlainObject(v);
}

export function isJsonSafe(v: unknown): boolean {
  try { return isJsonSafeValue(v, new Set(), 0); } catch { return false; }
}

export function collectionHasDangerous(arr: unknown): boolean {
  return collectionHasDangerousKey(arr);
}
