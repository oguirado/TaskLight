export const PLANAI_LIMITS = Object.freeze({
  INPUT_JSON_MAX: 1500,        // matches TPL_LIMITS.PROMPT_JSON_MAX (src/template/limits.ts:4)
  MICROTASKS_MAX: 12,          // STRATEGY_v9 §2, §4
  TASK_TITLE_MAX: 120,         // STRATEGY_v9 §4
  ACCEPT_MAX: 160,             // STRATEGY_v9 §4
  MICRO_TEXT_MAX: 80,          // STRATEGY_v9 §4
  OUTCOME_MAX: 240,            // STRATEGY_v9 §4
  MEMORY_TEXT_MAX: 2000,       // STRATEGY_v9 §3
  REASON_MAX: 160,             // matches LIMITS.REASON_MAX (src/schema/limits.ts:7)
  BRIEF_LINE_MAX: 160,         // matches LIMITS.NEXT_ACTION_MAX (src/schema/limits.ts:4); <= LIMITS.BRIEF_MAX (600, :6)
  DEFAULT_TIMEOUT_MS: 10_000,  // [TARGET] aligned with SPEC_U52 §3 DEVICE_STATUS_BOUND_MS
  MEMO_MAX: 256,               // [TARGET] bounded in-memory LRU/FIFO cap
} as const);
import type { DriftSource, DriftVerdict, StepState } from "../agents/types";
import type { DriftFloor } from "../app/agent_drift";
import type { ModeName } from "../ai/types";

export type PlanAiTier = "private" | "standard" | "shared"; // mirrors PrivacyTier (SPEC_U52 §4.2)

export interface PlanMicrotaskInput {
  id: string;
  text: string;
  state: StepState;            // "pending" | "active" | "blocked" | "done" (src/agents/types.ts:2)
  accept?: string;
  outcome?: string;
}

export interface PlanTaskInput {
  id: string;                  // e.g. "T01".."T40"
  title: string;
  type: string;
  phase: string;
  accept: string;
  status: StepState | "cancelled";
  deps: readonly string[];
  rev: number;
  microtasks: readonly PlanMicrotaskInput[];
}

export interface PlanMemoryInput {
  id: string;
  label: string;
  text: string;
  rev: number;
}

export interface PlanRollupTask {
  id: string;
  title: string;
  state: StepState | "cancelled";
  ready: boolean;
  waitsFor: readonly string[];
}

export interface PlanBriefInput {
  planId: string;
  title: string;
  phase: string;
  status: "active" | "closed";
  rev: number;
  doneMicrotasks: number;
  totalMicrotasks: number;
  tasks: readonly PlanRollupTask[];
}

export interface PlanBrief {
  brief: string;               // single-line, <= PLANAI_LIMITS.BRIEF_LINE_MAX
  source: DriftSource | "rules";
}

export type PlanAiFallbackReason =
  | "no_port"
  | "privacy_blocked"
  | "source_rejected"
  | "timeout"
  | "aborted"
  | "port_error"
  | "bad_json"
  | "schema_reject";

export interface PlanAiPort {
  generate(prompt: string, schema: object, signal: AbortSignal, room?: string): Promise<{ text: string; source: DriftSource }>;
}

export interface PlanAiPortBinding {
  port: PlanAiPort;
  allowExternal: boolean;
}

export type PlanAiPortResolver =
  | PlanAiPort
  | ((mode: ModeName) => PlanAiPort | PlanAiPortBinding);

export interface PlanAiClock {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PlanAiOptions {
  port?: PlanAiPortResolver;
  clock?: PlanAiClock;
  timeoutMs?: number;
  killSwitchCloud?: boolean;
  onFallback?: (job: "task_review" | "plan_brief", reason: PlanAiFallbackReason) => void;
}

export interface ReviewContext {
  tier?: PlanAiTier;
  floor?: DriftFloor;          // overrides default floor derived from tier
  memory?: PlanMemoryInput;    // at most 1 section (STRATEGY_v9 §2)
  signal?: AbortSignal;
  room?: string;
}

export interface BriefContext {
  tier?: PlanAiTier;
  floor?: DriftFloor;
  signal?: AbortSignal;
  room?: string;
}

export interface PlanAi {
  reviewTask(task: PlanTaskInput, ctx?: ReviewContext): Promise<DriftVerdict>;
  briefPlan(plan: PlanBriefInput, ctx?: BriefContext): Promise<PlanBrief>;
}
