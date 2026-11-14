import type { PrivacyTier } from "../schema";

export const EVENT_SOURCE = ["agent", "ci", "git"] as const;
export type EventSource = typeof EVENT_SOURCE[number];
export const EVENT_KIND = [
  "output", "waiting_input", "error", "exit",
  "ci_started", "ci_passed", "ci_failed",
  "commit", "push",
] as const;
export type EventKind = typeof EVENT_KIND[number];

export interface RawEnvelope {
  source: EventSource; projectId: string;
  sourceSeq: number;
  ts: number;
  kind: string; text: string;
}
export interface CapsuleEvent {
  eventId: string;
  projectId: string; source: EventSource; kind: EventKind;
  sourceSeq: number; ts: number;
  text: string;
  redactions: number;
  truncated: boolean;
  tier: PrivacyTier;
}
export type RedactClass =
  | "PRIVATE_KEY" | "BEARER" | "JWT" | "KEY_ASSIGN" | "URL_CREDS"
  | "APPCHECK_DEBUG" | "EMAIL" | "HOME_PATH" | "HIGH_ENTROPY";
export interface RedactResult { text: string; redactions: number; classes: RedactClass[] }

export type IngestRejectCode =
  | "TOO_LARGE_RAW" | "PARSE_ERROR" | "NOT_OBJECT" | "MISSING_FIELD" | "UNKNOWN_FIELD"
  | "WRONG_TYPE" | "BAD_SOURCE" | "BAD_KIND" | "BAD_PROJECT_ID" | "UNKNOWN_PROJECT"
  | "BAD_INT" | "SEQ_REGRESSION" | "CONTROL_CHAR" | "REDACT_RESIDUE";
export interface IngestReject { code: IngestRejectCode; path: string; detail?: string }
export type Ingested<T> = { ok: true; value: T } | { ok: false; errors: IngestReject[] };

export interface ProjectRegistry {
  tierOf(projectId: string): PrivacyTier | undefined;
  lastSeq(projectId: string, source: EventSource): number | undefined;
}
