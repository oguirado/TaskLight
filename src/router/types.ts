// U39 stub (oracle phase). Types and constants are final; functions elsewhere throw.
import type { RoomAct } from "../agents/types";
import type { LensMode } from "../lens/types";
import type { InferenceSource } from "../schema/index";

export const ROUTE_TARGETS = ["ask_agent", "plan_change", "escalate", "status_query",
  "focus_capsule", "handoff", "ack_noise", "inbox"] as const;
export type RouteTarget = typeof ROUTE_TARGETS[number];
export type RouteStatus = "OK" | "ABSTAIN" | "NO_MATCH" | "ERROR";
export type RouteStage = "exact" | "lexical" | "nano";
export interface RouteRule {
  id: string; target: RouteTarget; terms: string[]; phrases?: string[]; acts?: RoomAct[]; weight?: number;
}
export interface RouteTable {
  version: number; rules: readonly RouteRule[]; bilingual: Readonly<Record<string, string>>;
}
export interface RouteDecision {
  status: RouteStatus; target: RouteTarget; agent?: string; stage?: RouteStage; ruleId?: string;
  scorePpm: number; coveragePpm: number; marginPpm: number; matched: string[];
  source?: InferenceSource;
  reason?: "low_margin" | "low_coverage" | "no_terms" | "nano_abstain" | "nano_off_enum" |
    "nano_timeout" | "nano_unavailable" | "privacy_cloud";
  tableHash: string;
}
export type ClassifierPort = (req: {
  prompt: string; constraint: object; mode: LensMode; signal: AbortSignal;
}) => Promise<{ text: string; source: InferenceSource } | null>;
