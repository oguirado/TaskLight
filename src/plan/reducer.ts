import type {
  PlanningTemplate, PlanProjection, PlanTask, TaskStatus, PlanConformance,
  PlanApplyResult, PlanFoldResult, PlanOpEvent, PlanOpErrorCode, PlanMicrotask,
} from "./types";
import { PLAN_LIMITS, AGENT_RE } from "./limits";
import { opEventErrorCode, isPlainObjectExport, isJsonSafe, collectionHasDangerous, safeField, hasDangerousOwnKey } from "./validate";

const SILENT_AFTER_MS = PLAN_LIMITS.SILENT_AFTER_MS;
const TS_MAX_ABS = 8.64e15;
const ACTIVITY_RETIRED = "activity.retired";
// At most 256 opaque IDs per task/microtask scope (520 scopes per plan).
// Saturation seals the scope until plan.open; evicting IDs would admit old runs.
const ACTIVITY_RETIRED_MAX = 256;
const ACTIVITY_SEALED = "*"; // Cannot be a valid run_id.
type RetiredRuns = Record<string, string[]>;

function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function cloneDeep<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return (v as unknown[]).map((x) => cloneDeep(x)) as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>)) {
    // Avoid polluting prototype: skip dangerous? But cloning canonical data never has them.
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      Object.defineProperty(out, k, { value: cloneDeep((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
    } else {
      out[k] = cloneDeep((v as Record<string, unknown>)[k]);
    }
  }
  return out as T;
}

export function emptyProjection(): PlanProjection {
  try {
    return {
      plan: null,
      tasks: [],
      memory: {},
      archived_plans: [],
      rollup: { tasks_total: 0, tasks_done: 0, tasks_blocked: 0, tasks_ready: 0, micro_total: 0, micro_done: 0, progress: 0, progress_pct: 0 },
      replayed_ops: {},
      rejected: [],
      last_lamport: 0,
    };
  } catch {
    return {
      plan: null, tasks: [], memory: {}, archived_plans: [],
      rollup: { tasks_total: 0, tasks_done: 0, tasks_blocked: 0, tasks_ready: 0, micro_total: 0, micro_done: 0, progress: 0, progress_pct: 0 },
      replayed_ops: {}, rejected: [], last_lamport: 0,
    };
  }
}

export function computeTaskStatus(task: PlanTask): TaskStatus {
  try {
    const t = task as unknown as Record<string, unknown> | null;
    if (!t || typeof t !== "object") return "pending";
    const explicit = t["explicit_state"];
    const micros = Array.isArray(t["microtasks"]) ? (t["microtasks"] as Array<Record<string, unknown>>) : [];
    const states = micros.map((m) => (m && typeof m === "object" ? (m["state"] as string) : undefined));
    if (explicit === "cancelled") return "cancelled";
    if (explicit === "blocked" || states.some((s) => s === "blocked")) return "blocked";
    if (micros.length > 0 && states.every((s) => s === "done")) return "done";
    if (states.some((s) => s === "active" || s === "done")) return "active";
    return "pending";
  } catch { return "pending"; }
}

export function isTaskReady(task: PlanTask, byId: ReadonlyMap<string, PlanTask>): boolean {
  try {
    const t = task as unknown as Record<string, unknown> | null;
    if (!t || typeof t !== "object") return false;
    const state = t["state"];
    if (state === "done" || state === "cancelled") return false;
    const deps = Array.isArray(t["deps"]) ? (t["deps"] as unknown[]) : [];
    const map = byId as unknown as Map<string, unknown> | null;
    if (!map || typeof (map as Map<string, unknown>).get !== "function") return false;
    for (const d of deps) {
      if (typeof d !== "string") return false;
      const dep = (map as Map<string, unknown>).get(d);
      if (!dep || typeof dep !== "object") return false;
      if ((dep as Record<string, unknown>)["state"] !== "done" && (dep as Record<string, unknown>)["state"] !== "cancelled") return false;
    }
    return true;
  } catch { return false; }
}

export function computeProgress(tasks: readonly PlanTask[]): number {
  try {
    if (!Array.isArray(tasks)) return 0;
    let total = 0;
    let done = 0;
    for (const t of tasks) {
      if (!t || typeof t !== "object") continue;
      const mir = Array.isArray((t as Record<string, unknown>)["microtasks"])
        ? ((t as Record<string, unknown>)["microtasks"] as unknown[]) : [];
      for (const m of mir) {
        total += 1;
        if (m && typeof m === "object" && (m as Record<string, unknown>)["state"] === "done") done += 1;
      }
    }
    return total === 0 ? 0 : done / total;
  } catch { return 0; }
}

export function checkConformance(proj: PlanProjection, template?: PlanningTemplate): PlanConformance {
  try {
    const findings: Array<{ code: string; severity: "error"; path: string; message: string }> = [];
    const add = (code: string, path: string, message: string) => findings.push({ code, severity: "error" as const, path, message });
    // Hostile proj guard
    if (!proj || typeof proj !== "object" || Array.isArray(proj)) {
      add("invalid_projection", "", "Invalid projection");
      return { ok: false, findings };
    }
    const p = proj as unknown as Record<string, unknown>;
    const plan = p["plan"] as Record<string, unknown> | null;
    const tasks = Array.isArray(p["tasks"]) ? (p["tasks"] as unknown[]) : [];
    const memory = isPlainObjectExport(p["memory"]) ? (p["memory"] as Record<string, unknown>) : {};
    // template may be undefined / hostile
    let tpl: Record<string, unknown> | null = null;
    if (template === undefined || template === null) return { ok: true, findings: [] };
    if (isPlainObjectExport(template)) tpl = template as unknown as Record<string, unknown>;
    else return { ok: true, findings: [] };

    const phases = Array.isArray(tpl["phases"]) ? (tpl["phases"] as unknown[]) : [];
    const phaseIds = new Set<string>();
    for (const ph of phases) if (ph && typeof ph === "object" && typeof (ph as Record<string, unknown>)["id"] === "string") phaseIds.add((ph as Record<string, unknown>)["id"] as string);
    const taskTypes = Array.isArray(tpl["task_types"]) ? (tpl["task_types"] as unknown[]) : [];
    const typeById = new Map<string, Record<string, unknown>>();
    for (const tt of taskTypes) if (tt && typeof tt === "object" && typeof (tt as Record<string, unknown>)["id"] === "string") typeById.set((tt as Record<string, unknown>)["id"] as string, tt as Record<string, unknown>);
    const briefFields = Array.isArray(tpl["brief_fields"]) ? (tpl["brief_fields"] as unknown[]) : [];
    const memorySections = Array.isArray(tpl["memory_sections"]) ? (tpl["memory_sections"] as unknown[]) : [];
    const gran = isPlainObjectExport(tpl["granularity"]) ? (tpl["granularity"] as Record<string, unknown>) : {};
    const tasksMax = gran["tasks_max"];
    const microMin = gran["micro_min"];
    const microMax = gran["micro_max"];

    if (plan === null || plan === undefined || typeof plan !== "object") {
      for (const bf of briefFields) {
        if (bf && typeof bf === "object" && (bf as Record<string, unknown>)["required"] === true) {
          const fid = (bf as Record<string, unknown>)["id"];
          add("missing_brief", `plan.brief.${String(fid)}`, `Missing required brief field ${String(fid)}`);
        }
      }
      add("missing_plan", "plan", "Missing plan");
    } else {
      const brief = isPlainObjectExport(plan["brief"]) ? (plan["brief"] as Record<string, unknown>) : {};
      for (const bf of briefFields) {
        if (!bf || typeof bf !== "object") continue;
        const r = bf as Record<string, unknown>;
        if (r["required"] === true) {
          const fid = r["id"] as string;
          const val = brief[fid];
          if (typeof val !== "string" || val === "") add("missing_brief", `plan.brief.${fid}`, `Missing required brief field ${fid}`);
        }
      }
      if (!phaseIds.has(plan["phase"] as string)) add("invalid_phase", "plan.phase", "Invalid plan phase");
    }

    tasks.forEach((task) => {
      if (!task || typeof task !== "object") return;
      const t = task as Record<string, unknown>;
      const tid = typeof t["id"] === "string" ? (t["id"] as string) : "unknown";
      if (!phaseIds.has(t["phase"] as string)) add("invalid_phase", `tasks.${tid}.phase`, `Invalid phase for ${tid}`);
      const ttype = t["type"] as string;
      if (!typeById.has(ttype)) {
        add("invalid_type", `tasks.${tid}.type`, `Invalid type for ${tid}`);
      } else {
        const tdef = typeById.get(ttype)!;
        if (tdef["accept_required"] === true) {
          const acc = t["accept"];
          if (typeof acc !== "string" || acc === "") add("missing_accept", `tasks.${tid}.accept`, `Missing accept for ${tid}`);
        }
        if (tdef["evidence_required"] === true) {
          const micros = Array.isArray(t["microtasks"]) ? (t["microtasks"] as unknown[]) : [];
          for (const m of micros) {
            if (!m || typeof m !== "object") continue;
            const mr = m as Record<string, unknown>;
            const ev = mr["evidence"];
            if (!Array.isArray(ev) || ev.length === 0) {
              const mid = typeof mr["id"] === "string" ? (mr["id"] as string) : "";
              add("missing_evidence", `tasks.${tid}.microtasks.${mid}.evidence`, `Missing evidence for ${mid}`);
            }
          }
        }
      }
      const micros = Array.isArray(t["microtasks"]) ? (t["microtasks"] as unknown[]) : [];
      if (isSafeInt(microMin) && micros.length < (microMin as number)) add("micro_below_min", `tasks.${tid}.microtasks`, `Microtask count below minimum for ${tid}`);
      if (isSafeInt(microMax) && micros.length > (microMax as number)) add("micro_above_max", `tasks.${tid}.microtasks`, `Microtask count above maximum for ${tid}`);
    });

    if (isSafeInt(tasksMax) && tasks.length > (tasksMax as number)) add("tasks_above_max", "tasks", "Task count above template maximum");

    for (const sec of memorySections) {
      if (!sec || typeof sec !== "object") continue;
      const s = sec as Record<string, unknown>;
      const sid = s["id"] as string;
      if (s["required"] === true) {
        const entry = memory[sid];
        if (!entry || typeof entry !== "object") { add("missing_memory", `memory.${sid}`, `Missing required memory section ${sid}`); continue; }
        const text = (entry as Record<string, unknown>)["text"];
        if (typeof text !== "string" || text === "") { add("missing_memory", `memory.${sid}.text`, `Empty required memory section ${sid}`); continue; }
        const maxChars = s["max_chars"];
        if (isSafeInt(maxChars) && [...(text as string)].length > (maxChars as number)) add("memory_above_max", `memory.${sid}.text`, `Memory section ${sid} exceeds max_chars`);
      } else {
        const entry = memory[sid];
        if (entry && typeof entry === "object") {
          const text = (entry as Record<string, unknown>)["text"];
          const maxChars = s["max_chars"];
          if (isSafeInt(maxChars) && typeof text === "string" && [...text].length > (maxChars as number)) add("memory_above_max", `memory.${sid}.text`, `Memory section ${sid} exceeds max_chars`);
        }
      }
    }

    return { ok: findings.length === 0, findings };
  } catch {
    return { ok: false, findings: [{ code: "invalid", severity: "error" as const, path: "", message: "Invalid projection" }] };
  }
}

function cloneProjection(p: PlanProjection): PlanProjection {
  return cloneDeep(p) as PlanProjection;
}

function phaseIdsFor(tpl: PlanningTemplate | undefined): Set<string> | null {
  if (!tpl) return null;
  try {
    const arr = (tpl as unknown as Record<string, unknown>)["phases"];
    if (!Array.isArray(arr)) return null;
    const s = new Set<string>();
    for (const ph of arr) if (ph && typeof ph === "object" && typeof (ph as Record<string, unknown>)["id"] === "string") s.add((ph as Record<string, unknown>)["id"] as string);
    return s;
  } catch { return null; }
}

function derived(task: Record<string, unknown>, byId: Map<string, Record<string, unknown>>): { state: string; ready: boolean } {
  const explicit = task["explicit_state"];
  const micros = Array.isArray(task["microtasks"]) ? (task["microtasks"] as Array<Record<string, unknown>>) : [];
  const mstates = micros.map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>)["state"] : undefined));
  let state: string;
  if (explicit === "cancelled") state = "cancelled";
  else if (explicit === "blocked" || mstates.some((s) => s === "blocked")) state = "blocked";
  else if (micros.length > 0 && mstates.every((s) => s === "done")) state = "done";
  else if (mstates.some((s) => s === "active" || s === "done")) state = "active";
  else state = "pending";
  let ready: boolean;
  if (state === "done" || state === "cancelled") ready = false;
  else {
    ready = true;
    const deps = Array.isArray(task["deps"]) ? (task["deps"] as unknown[]) : [];
    for (const d of deps) {
      if (typeof d !== "string") { ready = false; break; }
      const dep = byId.get(d);
      if (!dep) { ready = false; break; }
      if ((dep as Record<string, unknown>)["state"] !== "done" && (dep as Record<string, unknown>)["state"] !== "cancelled") { ready = false; break; }
    }
  }
  return { state, ready };
}

function rememberRetired(proj: PlanProjection, scope: string, runId: string): void {
  const cache = proj.replayed_ops as Record<string, unknown>;
  const retired = (cache[ACTIVITY_RETIRED] ??= {}) as RetiredRuns;
  const runs = retired[scope] ??= [];
  if (runs.includes(ACTIVITY_SEALED) || runs.includes(runId)) return;
  if (runId === ACTIVITY_SEALED || runs.length >= ACTIVITY_RETIRED_MAX) retired[scope] = [ACTIVITY_SEALED];
  else retired[scope] = [...runs, runId];
}

function isRetired(proj: PlanProjection, scope: string, runId: string): boolean {
  const retired = proj.replayed_ops[ACTIVITY_RETIRED] as RetiredRuns | undefined;
  const runs = retired?.[scope];
  return runs?.includes(ACTIVITY_SEALED) === true || runs?.includes(runId) === true;
}

function retireLive(proj: PlanProjection, micro: PlanMicrotask): void {
  const live = micro.live;
  if (!live) return;
  // Opaque replay-cache metadata keeps JSON continuation deterministic without
  // adding fields to the public task or microtask shape.
  rememberRetired(proj, micro.id, live.run_id);
  delete micro.live;
}

function retireTaskActivity(proj: PlanProjection, task: PlanTask): void {
  for (const micro of task.microtasks) {
    if (micro.live) rememberRetired(proj, task.id, micro.live.run_id);
    // Include runs whose microtask already left active before this transition.
    const retired = proj.replayed_ops[ACTIVITY_RETIRED] as RetiredRuns | undefined;
    for (const runId of retired?.[micro.id] ?? []) rememberRetired(proj, task.id, runId);
    retireLive(proj, micro);
  }
}

function retireInactiveActivity(proj: PlanProjection): void {
  for (const task of proj.tasks) {
    const allowed = proj.plan?.state === "active" && task.state !== "blocked" && task.state !== "cancelled";
    if (!allowed || task.microtasks.some((m) => m.live && task.assignee !== m.live.agent)) {
      retireTaskActivity(proj, task);
      continue;
    }
    for (const micro of task.microtasks) {
      if (micro.live && micro.state !== "active") retireLive(proj, micro);
    }
  }
}

function recompute(proj: PlanProjection): void {
  const tasks = proj.tasks as unknown as Array<Record<string, unknown>>;
  if (!Array.isArray(tasks)) return;
  for (let iter = 0; iter < 5; iter++) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const t of tasks) if (t && typeof t["id"] === "string") byId.set(t["id"] as string, t);
    let changed = false;
    for (const t of tasks) {
      const { state, ready } = derived(t, byId);
      if (t["state"] !== state || t["ready"] !== ready) { t["state"] = state; t["ready"] = ready; changed = true; }
    }
    if (!changed) break;
  }
  const tasks_total = tasks.length;
  const tasks_done = tasks.filter((t) => t["state"] === "done").length;
  const tasks_blocked = tasks.filter((t) => t["state"] === "blocked").length;
  const tasks_ready = tasks.filter((t) => t["ready"] === true).length;
  let micro_total = 0;
  let micro_done = 0;
  for (const t of tasks) {
    const mir = Array.isArray(t["microtasks"]) ? (t["microtasks"] as unknown[]) : [];
    for (const m of mir) {
      micro_total += 1;
      if (m && typeof m === "object" && (m as Record<string, unknown>)["state"] === "done") micro_done += 1;
    }
  }
  const progress = micro_total > 0 ? micro_done / micro_total : 0;
  proj.rollup = {
    tasks_total, tasks_done, tasks_blocked, tasks_ready, micro_total, micro_done,
    progress: floatProgress(progress), progress_pct: intPct(progress),
  };
  retireInactiveActivity(proj);
}
function floatProgress(n: number): number { const v = n; return v; }
function intPct(n: number): number { return Math.trunc(n * 100); }

function hasCycle(graph: Map<string, string[]>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const k of graph.keys()) color.set(k, WHITE);
  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of graph.get(u) ?? []) {
      if (!graph.has(v)) continue;
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };
  for (const k of Array.from(graph.keys())) if ((color.get(k) ?? WHITE) === WHITE) { if (dfs(k)) return true; }
  return false;
}

function findTask(tasks: Array<Record<string, unknown>>, id: string): Record<string, unknown> | null {
  for (const t of tasks) if (t && t["id"] === id) return t;
  return null;
}

function safeReadLamportTsAgent(ev: unknown): { lamport: number | undefined; ts: number | undefined; agent: string | undefined } {
  try {
    if (!ev || typeof ev !== "object") return { lamport: undefined, ts: undefined, agent: undefined };
    const rec = ev as Record<string, unknown>;
    let lamport: number | undefined;
    let ts: number | undefined;
    let agent: string | undefined;
    try { const v = rec["lamport"]; if (isSafeInt(v)) lamport = v as number; } catch { /* ignore */ }
    try { const v = rec["ts"]; if (isSafeInt(v)) ts = v as number; } catch { /* ignore */ }
    try { const v = rec["agent"]; if (typeof v === "string") agent = v; } catch { /* ignore */ }
    return { lamport, ts, agent };
  } catch { return { lamport: undefined, ts: undefined, agent: undefined }; }
}

// Handlers replace nested payloads; recompute only changes task status/live.
// Snapshot those mutable records, never the unbounded ordinary replay cache.
// Retirement arrays are replaced by rememberRetired, so its scope map is shallow.
function projectionRollback(proj: PlanProjection, replayKey: string | undefined): () => void {
  const saved = {
    ...proj,
    plan: proj.plan === null ? null : { ...proj.plan },
    tasks: proj.tasks.map((task) => ({
      ...task, microtasks: task.microtasks.map((micro) => ({ ...micro })),
    })),
    memory: { ...proj.memory },
  };
  const cache = proj.replayed_ops as Record<string, unknown>;
  const hadRetired = Object.prototype.hasOwnProperty.call(cache, ACTIVITY_RETIRED);
  const retired = cache[ACTIVITY_RETIRED];
  const savedRetired = retired && typeof retired === "object" ? { ...(retired as RetiredRuns) } : retired;
  return () => {
    Object.assign(proj, saved);
    if (hadRetired) cache[ACTIVITY_RETIRED] = savedRetired;
    else delete cache[ACTIVITY_RETIRED];
    // The replay check established that this receipt did not exist before apply.
    if (replayKey !== undefined) delete cache[replayKey];
  };
}

function applyOpInternal(
  proj: PlanProjection,
  ev: unknown,
  template: PlanningTemplate | undefined,
  lastByAgent: ReadonlyMap<string, number> | undefined,
  owned = false,
): PlanApplyResult & { replayed?: boolean } {
  // Only foldPlan may reuse its private accumulator; public applyOp clones.
  let base: PlanProjection;
  try {
    if (!proj || typeof proj !== "object" || Array.isArray(proj)) base = emptyProjection();
    else base = owned ? proj : cloneProjection(proj);
  } catch { base = emptyProjection(); }
  // Ensure keys exist
  try {
    const baseRec = base as unknown as Record<string, unknown>;
    if (!("plan" in baseRec)) base.plan = null;
    if (!Array.isArray(base.tasks)) base.tasks = [];
    if (!isPlainObjectExport(base.memory)) base.memory = {};
    if (!Array.isArray(base.archived_plans)) base.archived_plans = [];
    if (!base.rollup || typeof base.rollup !== "object") base.rollup = emptyProjection().rollup;
    if (!isPlainObjectExport(base.replayed_ops)) base.replayed_ops = {};
    if (!Array.isArray(base.rejected)) base.rejected = [];
    if (typeof base.last_lamport !== "number" || !Number.isFinite(base.last_lamport)) base.last_lamport = 0;
  } catch { base = emptyProjection(); }

  // Watermark: advance on structurally eligible lamport
  const wm = safeReadLamportTsAgent(ev);
  const lamportWm = wm.lamport;
  if (lamportWm !== undefined && lamportWm >= 1 && lamportWm > base.last_lamport) base.last_lamport = lamportWm;

  // Validate envelope + shape
  let code: PlanOpErrorCode | null = null;
  try { code = opEventErrorCode(ev); } catch { code = "bad_op"; }
  if (code !== null) {
    return { ok: false, code, projection: base };
  }
  // Valid: safe direct reads
  const evRec = ev as Record<string, unknown>;
  const id = String(evRec["id"]);
  const lamport = evRec["lamport"] as number;
  const ts = evRec["ts"] as number;
  const agent = evRec["agent"] as string;
  const op = evRec["op"] as Record<string, unknown>;
  const kind = op["kind"] as string;
  const hasOpId = Object.prototype.hasOwnProperty.call(op, "op_id");
  const opId = hasOpId ? (op["op_id"] as string) : undefined;

  // Replay check before domain
  const replayKey = opId === undefined ? undefined : JSON.stringify([agent, opId]);
  if (replayKey !== undefined && Object.prototype.hasOwnProperty.call(base.replayed_ops, replayKey)) {
    return { ok: true, projection: base, replayed: true };
  }

  let rollback: (() => void) | undefined;
  const fail = (c: PlanOpErrorCode): PlanApplyResult => {
    rollback?.();
    return { ok: false, code: c, projection: base };
  };

  try {
    // Keep the eligible watermark, but roll back every domain/replay mutation
    // on rejection or exception, including failures inside recompute.
    rollback = projectionRollback(base, replayKey);
    if (kind === "plan.open") {
      const plan = base.plan as Record<string, unknown> | null;
      if (plan && plan["state"] === "active") return fail("plan_exists");
      let tplPhaseDefault = "";
      if (template !== undefined) {
        const tid = op["template_id"] as string;
        if (tid !== (template as unknown as Record<string, unknown>)["id"]) return fail("unknown_template");
        const thash = (template as unknown as Record<string, unknown>)["hash"];
        if (typeof thash === "string" && (op["template_hash"] as string) !== thash) return fail("bad_op");
        if (Object.prototype.hasOwnProperty.call(op, "phase")) {
          const pids = phaseIdsFor(template);
          if (pids && !pids.has(op["phase"] as string)) return fail("bad_op");
        } else {
          try {
            const arr = (template as unknown as Record<string, unknown>)["phases"];
            if (Array.isArray(arr) && arr.length > 0) tplPhaseDefault = String((arr[0] as Record<string, unknown>)["id"] ?? "");
          } catch { tplPhaseDefault = ""; }
        }
      } else {
        // No template: phase if present else ""
        tplPhaseDefault = "";
      }
      const newPlan: Record<string, unknown> = {
        id: "p1",
        title: op["title"],
        template_id: op["template_id"],
        template_hash: op["template_hash"],
        brief: op["brief"] !== undefined ? cloneDeep(op["brief"]) : {},
        phase: Object.prototype.hasOwnProperty.call(op, "phase") ? op["phase"] : tplPhaseDefault,
        state: "active",
        rev: lamport,
        opened_lamport: lamport,
        opened_ts: ts,
        closed_outcome: null,
      };
      // Closed plans were already archived at close time (A-U55b). Reopening
      // only resets per-plan tasks; memory and archive history survive.
      if (plan === null || plan["state"] === "closed") base.tasks = [];
      // Sealed/retired activity scopes are plan-local; replay receipts survive.
      delete (base.replayed_ops as Record<string, unknown>)[ACTIVITY_RETIRED];
      base.plan = newPlan as unknown as PlanProjection["plan"];
      recompute(base);
      if (opId !== undefined) {
        const key = JSON.stringify([agent, opId]);
        (base.replayed_ops as Record<string, unknown>)[key] = { kind, op_id: opId };
      }
      return { ok: true, projection: base, replayed: false };
    }

    if (kind === "memory.set") {
      const section = op["section"] as string;
      const mem = base.memory as unknown as Record<string, unknown>;
      const cur = mem[section] as Record<string, unknown> | undefined;
      const curRev = cur && typeof cur === "object" && isSafeInt(cur["rev"]) ? (cur["rev"] as number) : 0;
      if ((op["base_rev"] as number) !== curRev) return fail("stale_rev");
      if (template !== undefined) {
        let found: Record<string, unknown> | null = null;
        try {
          const arr = (template as unknown as Record<string, unknown>)["memory_sections"];
          if (Array.isArray(arr)) {
            for (const s of arr) if (s && typeof s === "object" && (s as Record<string, unknown>)["id"] === section) { found = s as Record<string, unknown>; break; }
          }
        } catch { found = null; }
        if (found) {
          const mc = found["max_chars"];
          if (isSafeInt(mc) && [...(op["text"] as string)].length > (mc as number)) return fail("bad_op");
        }
      }
      mem[section] = { id: section, text: op["text"], rev: lamport, by: agent, ts };
      base.memory = mem as PlanProjection["memory"];
      recompute(base);
      if (opId !== undefined) {
        const key = JSON.stringify([agent, opId]);
        (base.replayed_ops as Record<string, unknown>)[key] = { kind, op_id: opId };
      }
      return { ok: true, projection: base, replayed: false };
    }

    // All other kinds require active plan
    const plan = base.plan as Record<string, unknown> | null;
    if (!plan || plan["state"] !== "active") return fail("no_plan");

    if (kind === "plan.close") {
      if ((op["base_rev"] as number) !== (plan["rev"] as number)) return fail("stale_rev");
      plan["state"] = "closed";
      plan["rev"] = lamport;
      plan["closed_outcome"] = Object.prototype.hasOwnProperty.call(op, "outcome") ? op["outcome"] : null;
      // A-U55b: archive immediately at close with closed_ts = close event ts.
      const tasksSnap = base.tasks as unknown as Array<Record<string, unknown>>;
      const entry = {
        id: String(plan["id"] ?? "p1"),
        title: String(plan["title"] ?? ""),
        template_id: String(plan["template_id"] ?? ""),
        opened_ts: Number(plan["opened_ts"] ?? ts),
        closed_ts: ts,
        tasks_total: tasksSnap.length,
        tasks_done: tasksSnap.filter((t) => t && t["state"] === "done").length,
        outcome: (plan["closed_outcome"] as string | null) ?? null,
      };
      base.archived_plans = [...(base.archived_plans as unknown[]), entry] as PlanProjection["archived_plans"];
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "plan.phase") {
      if ((op["base_rev"] as number) !== (plan["rev"] as number)) return fail("stale_rev");
      if (template !== undefined) {
        const pids = phaseIdsFor(template);
        if (pids && !pids.has(op["phase"] as string)) return fail("bad_op");
      }
      plan["phase"] = op["phase"];
      plan["rev"] = lamport;
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "task.add") {
      if (Object.prototype.hasOwnProperty.call(op, "base_rev") && (op["base_rev"] as number) !== (plan["rev"] as number)) return fail("stale_rev");
      if (template !== undefined) {
        const pids = phaseIdsFor(template);
        if (pids && !pids.has(op["phase"] as string)) return fail("bad_op");
      }
      const tasks = base.tasks as unknown as Array<Record<string, unknown>>;
      if (tasks.length >= PLAN_LIMITS.TASKS_MAX) return fail("limit_exceeded");
      const newNum = tasks.length + 1;
      const newId = `T${String(newNum).padStart(2, "0")}`;
      const deps = (Array.isArray(op["deps"]) ? (op["deps"] as string[]) : []) as string[];
      if (deps.includes(newId)) return fail("dep_cycle");
      const byId = new Map<string, Record<string, unknown>>();
      for (const t of tasks) if (typeof t["id"] === "string") byId.set(t["id"] as string, t);
      for (const d of deps) if (!byId.has(d)) return fail("not_found");
      const trial = new Map<string, string[]>();
      for (const t of tasks) if (typeof t["id"] === "string") trial.set(t["id"] as string, Array.isArray(t["deps"]) ? [...(t["deps"] as string[])] : []);
      trial.set(newId, [...deps]);
      if (hasCycle(trial)) return fail("dep_cycle");
      const microsIn = Array.isArray(op["microtasks"]) ? (op["microtasks"] as Array<Record<string, unknown>>) : [];
      const micros: Array<Record<string, unknown>> = [];
      microsIn.forEach((m, idx) => {
        micros.push({
          id: `${newId}.M${String(idx + 1).padStart(2, "0")}`,
          text: m["text"],
          accept: Object.prototype.hasOwnProperty.call(m, "accept") ? m["accept"] : "",
          state: "pending", outcome: null, took: null, evidence: [], rev: lamport,
        });
      });
      const task: Record<string, unknown> = {
        id: newId,
        title: op["title"],
        type: op["type"],
        phase: op["phase"],
        accept: Object.prototype.hasOwnProperty.call(op, "accept") ? op["accept"] : "",
        deps: [...deps],
        assignee: Object.prototype.hasOwnProperty.call(op, "assignee") ? op["assignee"] : null,
        claim_lamport: null, claim_ts: null,
        estimate: Object.prototype.hasOwnProperty.call(op, "estimate") ? op["estimate"] : null,
        rev: lamport, explicit_state: null, blocked_reason: null, state: "pending", ready: false,
        microtasks: micros,
      };
      tasks.push(task);
      base.tasks = tasks as unknown as PlanProjection["tasks"];
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "task.set") {
      const tasks = base.tasks as unknown as Array<Record<string, unknown>>;
      const task = findTask(tasks, op["task_id"] as string);
      if (!task) return fail("not_found");
      if ((op["base_rev"] as number) !== (task["rev"] as number)) return fail("stale_rev");
      if (template !== undefined && Object.prototype.hasOwnProperty.call(op, "phase")) {
        const pids = phaseIdsFor(template);
        if (pids && !pids.has(op["phase"] as string)) return fail("bad_op");
      }
      if (Object.prototype.hasOwnProperty.call(op, "deps")) {
        const deps = [...(op["deps"] as string[])];
        const byId = new Map<string, Record<string, unknown>>();
        for (const t of tasks) if (typeof t["id"] === "string") byId.set(t["id"] as string, t);
        for (const d of deps) if (!byId.has(d)) return fail("not_found");
        if (deps.includes(op["task_id"] as string)) return fail("dep_cycle");
        const trial = new Map<string, string[]>();
        for (const t of tasks) if (typeof t["id"] === "string") trial.set(t["id"] as string, Array.isArray(t["deps"]) ? [...(t["deps"] as string[])] : []);
        trial.set(op["task_id"] as string, deps);
        if (hasCycle(trial)) return fail("dep_cycle");
      }
      if (Object.prototype.hasOwnProperty.call(op, "title")) task["title"] = op["title"];
      if (Object.prototype.hasOwnProperty.call(op, "type")) task["type"] = op["type"];
      if (Object.prototype.hasOwnProperty.call(op, "phase")) task["phase"] = op["phase"];
      if (Object.prototype.hasOwnProperty.call(op, "accept")) task["accept"] = op["accept"];
      if (Object.prototype.hasOwnProperty.call(op, "deps")) task["deps"] = [...(op["deps"] as string[])];
      if (Object.prototype.hasOwnProperty.call(op, "estimate")) task["estimate"] = op["estimate"];
      if (Object.prototype.hasOwnProperty.call(op, "state")) {
        task["explicit_state"] = op["state"];
        if (op["state"] === null && !Object.prototype.hasOwnProperty.call(op, "reason")) task["blocked_reason"] = null;
      }
      if (Object.prototype.hasOwnProperty.call(op, "reason")) task["blocked_reason"] = op["reason"];
      task["rev"] = lamport;
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "task.claim") {
      const tasks = base.tasks as unknown as Array<Record<string, unknown>>;
      const task = findTask(tasks, op["task_id"] as string);
      if (!task) return fail("not_found");
      if (Object.prototype.hasOwnProperty.call(op, "base_rev") && (op["base_rev"] as number) !== (task["rev"] as number)) return fail("stale_rev");
      const assignee = task["assignee"] as string | null | undefined;
      if (assignee !== null && assignee !== undefined && assignee !== agent) {
        const takeover = Object.prototype.hasOwnProperty.call(op, "takeover") ? op["takeover"] : false;
        if (takeover !== true) return fail("claimed_by_other");
        const candidates: number[] = [];
        const cts = task["claim_ts"];
        if (isSafeInt(cts)) candidates.push(cts as number);
        // Beat receipts remain owner activity after runs retire and across tasks.
        for (const value of Object.values(base.replayed_ops)) {
          if (!value || typeof value !== "object") continue;
          const receipt = value as Record<string, unknown>;
          if (receipt["kind"] === "activity.beat" && receipt["agent"] === assignee && isSafeInt(receipt["beat_ts"])) {
            candidates.push(receipt["beat_ts"]);
          }
        }
        if (lastByAgent) {
          const v = lastByAgent.get(assignee);
          if (v !== undefined) candidates.push(v);
        }
        if (candidates.length === 0) return fail("claimed_by_other");
        const last = Math.max(...candidates);
        if (!(ts - last > SILENT_AFTER_MS)) return fail("claimed_by_other");
      }
      if (assignee !== agent) retireTaskActivity(base, task as unknown as PlanTask);
      task["assignee"] = agent;
      task["claim_lamport"] = lamport;
      task["claim_ts"] = ts;
      task["rev"] = lamport;
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "task.release") {
      const tasks = base.tasks as unknown as Array<Record<string, unknown>>;
      const task = findTask(tasks, op["task_id"] as string);
      if (!task) return fail("not_found");
      if (Object.prototype.hasOwnProperty.call(op, "base_rev") && (op["base_rev"] as number) !== (task["rev"] as number)) return fail("stale_rev");
      const assignee = task["assignee"] as string | null | undefined;
      if (assignee !== null && assignee !== undefined && assignee !== agent) return fail("claimed_by_other");
      retireTaskActivity(base, task as unknown as PlanTask);
      task["assignee"] = null;
      task["claim_lamport"] = null;
      task["claim_ts"] = null;
      task["rev"] = lamport;
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "micro.add") {
      const tasks = base.tasks as unknown as Array<Record<string, unknown>>;
      const task = findTask(tasks, op["task_id"] as string);
      if (!task) return fail("not_found");
      if ((op["base_rev"] as number) !== (task["rev"] as number)) return fail("stale_rev");
      const micros = Array.isArray(task["microtasks"]) ? (task["microtasks"] as Array<Record<string, unknown>>) : [];
      if (micros.length >= PLAN_LIMITS.MICROS_MAX) return fail("limit_exceeded");
      const mid = `${op["task_id"] as string}.M${String(micros.length + 1).padStart(2, "0")}`;
      micros.push({
        id: mid, text: op["text"],
        accept: Object.prototype.hasOwnProperty.call(op, "accept") ? op["accept"] : "",
        state: "pending", outcome: null, took: null, evidence: [], rev: lamport,
      });
      task["microtasks"] = micros;
      task["rev"] = lamport;
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "activity.beat") {
      const task = base.tasks.find((t) => t.id === op["task_id"]);
      if (!task) return fail("not_found");
      if (task.assignee !== agent) return fail("claimed_by_other");
      const micros = Object.prototype.hasOwnProperty.call(op, "micro_id")
        ? task.microtasks.filter((m) => m.id === op["micro_id"]) : task.microtasks;
      if (Object.prototype.hasOwnProperty.call(op, "micro_id") && micros.length === 0) return fail("not_found");
      const runId = op["run_id"] as string;
      if (task.state !== "blocked" && task.state !== "cancelled" && !isRetired(base, task.id, runId)) {
        const eligible = micros.filter((m) => m.state === "active" && !isRetired(base, m.id, runId));
        if (eligible.length > 0) {
          // Supersession fences the old task run on every sibling.
          for (const micro of task.microtasks) {
            if (micro.live && micro.live.run_id !== runId) {
              rememberRetired(base, task.id, micro.live.run_id);
              retireLive(base, micro);
            }
          }
          if (isRetired(base, task.id, runId)) retireTaskActivity(base, task);
          else {
            for (const micro of eligible) {
              if (!isRetired(base, micro.id, runId)) micro.live = { agent, run_id: runId, beat_ts: ts, beat_lamport: lamport };
            }
          }
        }
      }
      // Semantic revisions and progress are deliberately untouched.
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId, agent, beat_ts: ts };
      return { ok: true, projection: base, replayed: false };
    }
    if (kind === "micro.set") {
      const microId = op["micro_id"] as string;
      const taskId = microId.split(".", 1)[0] as string;
      const tasks = base.tasks as unknown as Array<Record<string, unknown>>;
      const task = findTask(tasks, taskId);
      if (!task) return fail("not_found");
      const micros = Array.isArray(task["microtasks"]) ? (task["microtasks"] as Array<Record<string, unknown>>) : [];
      let micro: Record<string, unknown> | null = null;
      for (const m of micros) if (m && m["id"] === microId) { micro = m; break; }
      if (!micro) return fail("not_found");
      const assignee = task["assignee"] as string | null | undefined;
      if (assignee !== null && assignee !== undefined && assignee !== agent) return fail("claimed_by_other");
      micro["state"] = op["state"];
      if (Object.prototype.hasOwnProperty.call(op, "outcome")) micro["outcome"] = op["outcome"];
      if (Object.prototype.hasOwnProperty.call(op, "took")) micro["took"] = op["took"];
      if (Object.prototype.hasOwnProperty.call(op, "evidence")) micro["evidence"] = cloneDeep(op["evidence"]);
      micro["rev"] = lamport;
      task["rev"] = lamport;
      recompute(base);
      if (opId !== undefined) (base.replayed_ops as Record<string, unknown>)[JSON.stringify([agent, opId])] = { kind, op_id: opId };
      return { ok: true, projection: base, replayed: false };
    }

    return fail("bad_op");
  } catch {
    return fail("bad_op");
  }
  void id;
}

export function applyOp(proj: PlanProjection, ev: unknown, template?: PlanningTemplate): PlanApplyResult {
  try {
    return applyOpInternal(proj, ev, template, undefined) as PlanApplyResult;
  } catch {
    try {
      const base = (() => { try { return cloneProjection(proj); } catch { return emptyProjection(); } })();
      return { ok: false, code: "bad_op", projection: base };
    } catch {
      return { ok: false, code: "bad_op", projection: emptyProjection() };
    }
  }
}

function safeUpdateActivity(lastByAgent: Map<string, number>, e: Record<string, unknown>): void {
  try {
    const agent = e["agent"];
    const ts = e["ts"];
    if (typeof agent !== "string" || !AGENT_RE.test(agent)) return;
    if (!isSafeInt(ts)) return;
    if (Math.abs(ts as number) > TS_MAX_ABS) return;
    const prev = lastByAgent.get(agent);
    if (prev === undefined || (ts as number) > prev) lastByAgent.set(agent, ts as number);
  } catch { /* ignore */ }
}

export function foldPlan(events: unknown, template?: PlanningTemplate): PlanFoldResult {
  try {
    if (!Array.isArray(events)) {
      return { projection: emptyProjection(), stats: { applied: 0, replayed: 0, rejected: 0, invalid: 0, errors: [] } };
    }
    // Dangerous own keys on the array itself => empty (also catches __proto__ prototype tampering via Object.assign)
    try {
      let protoBad = false;
      try {
        const proto = Object.getPrototypeOf(events as object);
        if (proto !== Array.prototype && proto !== null) protoBad = true;
      } catch { protoBad = true; }
      if (protoBad || collectionHasDangerous(events)) {
        return { projection: emptyProjection(), stats: { applied: 0, replayed: 0, rejected: 0, invalid: 1, errors: [] } };
      }
    } catch { return { projection: emptyProjection(), stats: { applied: 0, replayed: 0, rejected: 0, invalid: 0, errors: [] } }; }

    let state = emptyProjection();
    let applied = 0;
    let replayedN = 0;
    let rejectedN = 0;
    let invalid = 0;
    const errors: Array<{ id?: string; lamport?: number; code: import("./types").PlanOpErrorCode }> = [];

    // Collect entries safely; do not mutate input
    type Entry = { raw: Record<string, unknown>; id: string; lamport: number };
    const sortable: Entry[] = [];
    // Iterate by index to avoid invoking hostile array iteration quirks; use safe length
    let n = 0;
    try {
      const descs = Object.getOwnPropertyDescriptors(events as object) as Record<string, PropertyDescriptor>;
      const lenDesc = descs["length"];
      const lenVal = lenDesc && !lenDesc.get && !lenDesc.set ? lenDesc.value : undefined;
      n = isSafeInt(lenVal) ? (lenVal as number) : (events as unknown[]).length;
    } catch { n = 0; }

    for (let i = 0; i < n; i++) {
      let entry: unknown;
      try {
        const d = Object.getOwnPropertyDescriptor(events as object, String(i));
        if (!d) continue;
        if (d.get !== undefined || d.set !== undefined) continue;
        entry = d.value;
      } catch { continue; }
      try {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (!isPlainObjectExport(entry)) continue;
        const er = entry as Record<string, unknown>;
        // Safe reads without invoking accessors: use descriptors
        const actG = safeField(er, "act");
        if (!actG.has || actG.value === undefined) {
          // No act: not an op => ignore (not invalid)
          continue;
        }
        const act = actG.value;
        const idG = safeField(er, "id");
        const lamG = safeField(er, "lamport");
        const idV = idG.has ? idG.value : undefined;
        const lamV = lamG.has ? lamG.value : undefined;
        const idStr = typeof idV === "string" ? idV : null;
        const lamNum = isSafeInt(lamV) ? (lamV as number) : null;
        if (act === "op") {
          if (idStr === null || lamNum === null || lamNum < 1) { invalid += 1; continue; }
          // Eligible: must also be JSON-safe? Even if not, keep for rejected path;
          // applyOp will classify. Keep sorted.
          sortable.push({ raw: er, id: idStr, lamport: lamNum });
        } else {
          // Legacy act: only keep if sortable-eligible for activity ordering
          if (idStr === null || lamNum === null || lamNum < 1) continue;
          sortable.push({ raw: er, id: idStr, lamport: lamNum });
        }
      } catch { continue; }
    }

    // Sort by (lamport, id ordinal)
    const ordered = [...sortable].sort((a, b) => {
      if (a.lamport !== b.lamport) return a.lamport - b.lamport;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    // Dedup by id (first wins)
    const seen = new Set<string>();
    const deduped: Entry[] = [];
    for (const e of ordered) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      deduped.push(e);
    }

    const lastByAgent = new Map<string, number>();
    for (const e of deduped) {
      const er = e.raw;
      const actG = safeField(er, "act");
      const act = actG.has ? actG.value : undefined;
      if (act !== "op") {
        safeUpdateActivity(lastByAgent, er);
        continue;
      }
      // Snapshot activity before apply
      const snapshot = new Map(lastByAgent);
      // op_id for rejected record (string else null)
      let opIdForReject: string | null = null;
      try {
        const opG = safeField(er, "op");
        if (opG.has && opG.value && typeof opG.value === "object" && !Array.isArray(opG.value) && isPlainObjectExport(opG.value)) {
          const or = opG.value as Record<string, unknown>;
          const oidG = safeField(or, "op_id");
          if (oidG.has && typeof oidG.value === "string") opIdForReject = oidG.value;
        }
      } catch { opIdForReject = null; }
      const beforeLast = state.last_lamport;
      void beforeLast;
      let result: PlanApplyResult & { replayed?: boolean };
      try {
        result = applyOpInternal(state, er, template, snapshot, true) as PlanApplyResult & { replayed?: boolean };
      } catch {
        result = { ok: false, code: "bad_op", projection: state };
      }
      if (result.ok) {
        state = result.projection;
        if ((result as { replayed?: boolean }).replayed === true) replayedN += 1;
        else applied += 1;
      } else {
        // Ensure rejected record + watermark (applyOpInternal already advanced watermark)
        const rej = result.projection.rejected as unknown as Array<Record<string, unknown>>;
        const newState = result.projection;
        // Append rejection receipt if not already present from internal (internal doesn't append to rejected; fold owns it)
        const receipt = { id: e.id, lamport: e.lamport, op_id: opIdForReject, code: result.code };
        (newState.rejected as unknown as Array<Record<string, unknown>>).push(receipt);
        errors.push({ id: e.id, lamport: e.lamport, code: result.code });
        rejectedN += 1;
        state = newState;
        // Rejected list must stay in processed order (already)
        void rej;
      }
      safeUpdateActivity(lastByAgent, er);
    }

    // Final recompute to ensure derived fresh (preserves rejected/watermark)
    try { recompute(state); } catch { /* ignore */ }
    return { projection: state, stats: { applied, replayed: replayedN, rejected: rejectedN, invalid, errors } };
  } catch {
    try { return { projection: emptyProjection(), stats: { applied: 0, replayed: 0, rejected: 0, invalid: 0, errors: [] } }; }
    catch { return { projection: emptyProjection(), stats: { applied: 0, replayed: 0, rejected: 0, invalid: 0, errors: [] } }; }
  }
}

export type { PlanOpEvent };
