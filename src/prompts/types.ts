// STUB (oracle phase): spec types, verbatim.
import type { TaskId, CapsuleStatus, Attention, PrivacyTier } from "../schema";

export interface PromptEvent { seq: number; kind: string; text: string }
export interface PrevState {
  status: CapsuleStatus; attention: Attention;
  headline?: string; summary?: string; next_action?: string;
}
export interface CapsuleInput {
  task: "status" | "summary" | "next_action";
  projectId: string; tier: PrivacyTier;
  prev: PrevState | null; delta: readonly PromptEvent[];
}
export interface ScreenshotInput {
  task: "screenshot"; projectId: string; tier: PrivacyTier;
  prev: Pick<PrevState, "status"> | null; caption?: string;
}
export interface DigestEntry {
  projectId: string; tier: PrivacyTier; status: CapsuleStatus; attention: Attention;
  headline?: string; next_action?: string;
}
export interface DigestInput { task: "digest"; entries: readonly DigestEntry[] }
export type PromptInput = CapsuleInput | ScreenshotInput | DigestInput;

export interface BuildOpts { version?: string; maxChars?: number }
export interface Truncation { droppedEvents: number; clippedChars: number; droppedEntries: number }
export type DegradeCode = "UNKNOWN_VERSION_FALLBACK" | "TRUNCATED";
export interface BuiltPrompt {
  task: TaskId; text: string; chars: number;
  prompt_version: string; template_hash: string;
  cloud_eligible: boolean;
  projectIds: readonly string[];
  truncation: Truncation; degraded: readonly DegradeCode[];
}
export type PromptRejectCode =
  | "OVER_BUDGET" | "BAD_BUDGET" | "EMPTY_DELTA" | "TOO_MANY_EVENTS" | "DUPLICATE_SEQ"
  | "BAD_INT" | "BAD_PREV" | "PRIVATE_TEXT" | "EMPTY_DIGEST" | "DUPLICATE_PROJECT" | "BAD_INPUT";
export interface PromptReject { code: PromptRejectCode; path: string; detail?: string }
export type Built = { ok: true; value: BuiltPrompt } | { ok: false; errors: PromptReject[] };

export interface PromptPack {
  version: string;
  templates: Readonly<Record<TaskId, { header: string; footer: string }>>;
}
