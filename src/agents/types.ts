export type RoomAct =
  | "open" | "plan" | "step" | "question" | "answer"
  | "handoff" | "ack" | "heartbeat" | "verdict" | "close" | "op";

export type PlanOpKind =
  | "plan.open" | "plan.close" | "plan.phase"
  | "task.add" | "task.set" | "task.claim" | "task.release"
  | "micro.add" | "micro.set" | "memory.set";

export interface RoomOpBody {
  kind: PlanOpKind;
  op_id?: string;
  base_rev?: number;
  [k: string]: unknown;
}
export type StepState = "done" | "active" | "blocked" | "pending";

export interface RoomEvidence { path: string; sha256: string }
export interface RoomPlanBody { title: string; steps: { text: string; accept?: string }[] }
export interface RoomStepBody { index: number; state: StepState; outcome?: string; took?: string }

/** Mirrors the U33 event line. */
export interface RoomEvent {
  id: string; lamport: number; ts: number; room: string; agent: string; act: RoomAct; text: string;
  re?: string; to?: string; evidence?: RoomEvidence[]; plan?: RoomPlanBody; step?: RoomStepBody;
  op?: RoomOpBody;
}

export interface Contract { title: string; steps: { text: string; accept?: string }[]; hash: string; version: number; lamport: number }

export interface AgentState {
  room: string; agent: string; contract?: Contract; previous?: Contract;
  stepStates: StepState[]; outcomes: (string | undefined)[]; took: (string | undefined)[];
  lastSeen: number; openQuestions: RoomEvent[]; lastText?: string; closed: boolean;
}

export interface PlanDiff { added: string[]; removed: string[]; reordered: boolean; edited: { from: string; to: string }[] }

export type DriftSource = "device" | "cloud" | "local" | "remote";
export interface DriftVerdict { verdict: "on_track" | "drift" | "needs_user"; reason: string; source: DriftSource | "rules" }

/** Return shape of `foldRoomWithStats` (name fixed by the U34 oracle, see ORACLE.md J1). */
export interface FoldRoomResult { states: AgentState[]; invalid: number }

export interface TemplateMemorySectionMeta {
  id: string;
  label: string;
  required: boolean;
  max_chars: number;
}
