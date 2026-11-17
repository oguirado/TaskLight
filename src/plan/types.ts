import type { RoomEvidence, StepState } from "../agents/types";

export type MicroState = StepState; // "done" | "active" | "blocked" | "pending" (src/agents/types.ts:2)
export type PlanLifecycle = "active" | "closed";
export type TaskStatus = "pending" | "active" | "blocked" | "done" | "cancelled";

export type PlanOpKind =
  | "plan.open" | "plan.close" | "plan.phase"
  | "task.add" | "task.set" | "task.claim" | "task.release"
  | "micro.add" | "micro.set" | "memory.set" | "activity.beat" | "agent.lifecycle";

export type PlanOpErrorCode =
  | "no_plan" | "plan_exists" | "unknown_template" | "bad_template"
  | "bad_op" | "not_found" | "stale_rev" | "dep_cycle"
  | "claimed_by_other" | "limit_exceeded" | "not_conformant";

export type TemplateRejectCode =
  | "NOT_PLAIN" | "MISSING_FIELD" | "UNKNOWN_FIELD" | "WRONG_TYPE" | "BAD_VERSION"
  | "BAD_NAME" | "CONTROL_CHAR" | "CODE_LIKE" | "LIMIT_EXCEEDED" | "DUPLICATE_ID" | "BAD_GRANULARITY";

export interface BriefFieldDef { id: string; label: string; required: boolean }
export interface PhaseDef { id: string; label: string; exit: string }
export interface TaskTypeDef {
  id: string; label: string; accept_required: boolean; evidence_required: boolean; micro_hints: readonly string[];
}
export interface MemorySectionDef { id: string; label: string; required: boolean; max_chars: number; hint: string }
export interface PlanningTemplate {
  id: string; v: 1; hash?: string; name: string; summary: string; lens_id?: string;
  brief_fields: readonly BriefFieldDef[];
  phases: readonly PhaseDef[];
  task_types: readonly TaskTypeDef[];
  granularity: { tasks_max: number; micro_min: number; micro_max: number; rule: string };
  memory_sections: readonly MemorySectionDef[];
}

export interface PlanOpBase { kind: PlanOpKind; op_id?: string; base_rev?: number }
export interface PlanOpenOp extends PlanOpBase {
  kind: "plan.open"; title: string; template_id: string; template_hash: string;
  brief: Readonly<Record<string, string>>; phase?: string;
}
export interface PlanCloseOp extends PlanOpBase { kind: "plan.close"; base_rev: number; outcome?: string }
export interface PlanPhaseOp extends PlanOpBase { kind: "plan.phase"; base_rev: number; phase: string }
export interface TaskAddOp extends PlanOpBase {
  kind: "task.add"; title: string; type: string; phase: string; accept: string;
  deps?: readonly string[]; estimate?: string; assignee?: string | null;
  microtasks?: readonly { text: string; accept?: string }[];
}
export interface TaskSetOp extends PlanOpBase {
  kind: "task.set"; task_id: string; base_rev: number;
  title?: string; type?: string; phase?: string; accept?: string;
  deps?: readonly string[]; estimate?: string | null; state?: "blocked" | "cancelled" | null; reason?: string | null;
}
export interface TaskClaimOp extends PlanOpBase { kind: "task.claim"; task_id: string; takeover?: boolean }
export interface TaskReleaseOp extends PlanOpBase { kind: "task.release"; task_id: string; claim_lamport?: number }
export interface MicroAddOp extends PlanOpBase { kind: "micro.add"; task_id: string; base_rev: number; text: string; accept?: string }
export interface MicroSetOp extends PlanOpBase {
  kind: "micro.set"; micro_id: string; base_rev?: never; state: MicroState;
  outcome?: string; took?: string; evidence?: readonly RoomEvidence[]; claim_lamport?: number;
}
export interface MemorySetOp extends PlanOpBase { kind: "memory.set"; section: string; text: string; base_rev: number }
export interface ActivityBeatOp extends PlanOpBase {
  kind: "activity.beat"; task_id: string; micro_id?: string; run_id: string;
  note?: string; op_id: string; base_rev?: never;
}

export type AgentLifecycle = "deployed" | "alive" | "finished" | "failed";
export interface AgentResult {
  verdict: "ADMIT" | "HOLD" | "NO_PUDE" | "OK" | "FAIL";
  summary?: string; receipt?: string;
  evidence?: readonly { path: string; sha256: string }[];
}
export interface AgentLifecycleOp extends PlanOpBase {
  kind: "agent.lifecycle"; state: AgentLifecycle; run_id: string; op_id: string; result?: AgentResult;
  swarm?: string; harness?: string; reason?: string; parent_agent?: string; parent_run_id?: string; base_rev?: never;
}
export interface AgentLifecycleRecord {
  lifecycle: AgentLifecycle; run_id: string; swarm?: string; harness?: string; reason?: string;
  parent_agent?: string; parent_run_id?: string;
  deployed_ts: number; last_alive_ts?: number; ts: number; lamport: number;
  retired_run_ids: readonly string[];
}

export type PlanOpBody =
  | PlanOpenOp | PlanCloseOp | PlanPhaseOp | TaskAddOp | TaskSetOp
  | TaskClaimOp | TaskReleaseOp | MicroAddOp | MicroSetOp | MemorySetOp | ActivityBeatOp | AgentLifecycleOp;

export interface PlanOpEvent {
  id: string; lamport: number; ts: number; room: string; agent: string; act: "op"; text: string; op: PlanOpBody;
}

export interface PlanMicrotask {
  id: string; text: string; accept: string; state: MicroState;
  outcome: string | null; took: string | null; evidence: readonly RoomEvidence[]; rev: number;
  live?: { agent: string; run_id: string; beat_ts: number; beat_lamport: number };
}
export interface PlanTask {
  id: string; title: string; type: string; phase: string; accept: string;
  deps: readonly string[]; assignee: string | null; claim_lamport: number | null; claim_ts: number | null;
  estimate: string | null; explicit_state: "blocked" | "cancelled" | null; blocked_reason: string | null;
  state: TaskStatus; ready: boolean; rev: number; microtasks: readonly PlanMicrotask[];
}
export interface PlanMemorySection { id: string; text: string; rev: number; by: string; ts: number }
export interface PlanState {
  id: "p1"; title: string; template_id: string; template_hash: string;
  brief: Readonly<Record<string, string>>; phase: string; state: PlanLifecycle;
  rev: number; opened_lamport: number; opened_ts: number; closed_outcome: string | null;
}
export interface PlanConformanceFinding { code: string; severity: "error"; path: string; message: string }
export interface PlanConformance { ok: boolean; findings: readonly PlanConformanceFinding[] }
export interface PlanProjection {
  // Compatibility snapshots may omit fields; reducers emit complete lifecycle records.
  agent_lifecycle?: Readonly<Record<string, Partial<AgentLifecycleRecord>>>;
  plan: PlanState | null; tasks: readonly PlanTask[];
  memory: Readonly<Record<string, PlanMemorySection>>;
  archived_plans: readonly { id: string; title: string; template_id: string; opened_ts: number;
    closed_ts: number; tasks_total: number; tasks_done: number; outcome: string | null }[];
  rollup: { tasks_total: number; tasks_done: number; tasks_blocked: number; tasks_ready: number;
    micro_total: number; micro_done: number; progress: number; progress_pct: number };
  replayed_ops: Readonly<Record<string, unknown>>;
  rejected: readonly { id: string; lamport: number; op_id: string | null; code: PlanOpErrorCode }[];
  last_lamport: number;
}
export interface PlanFoldStats {
  applied: number; replayed: number; rejected: number; invalid: number;
  errors: readonly { id?: string; lamport?: number; code: PlanOpErrorCode }[];
}
export interface PlanFoldResult { projection: PlanProjection; stats: PlanFoldStats }
export type PlanApplyResult =
  | { ok: true; projection: PlanProjection; replayed: boolean }
  | { ok: false; code: PlanOpErrorCode; detail: string; projection: PlanProjection };
