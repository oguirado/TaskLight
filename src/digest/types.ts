// STUB (oracle phase U17): public types per SPEC_U17 section 2 (constants are real, behaviour modules are wrong on purpose).
import type { CapsuleState, CapsuleStatus, Attention, PrivacyTier,
  DigestItem, InferenceSource, Reject } from "../schema";
import type { Hybrid, AiErrorCode } from "../ai";

export const DIGEST_REQUEST_ID = "_digest" as const;   // TaskRequest.projectId [TARGET]

export interface DigestCapsuleIn { projectId: string; tier: PrivacyTier; state: CapsuleState }

export interface DigestLine {             // serialized in this exact key order
  projectId: string; status: CapsuleStatus; attention: Attention;
  waiting_ms: number;                     // now - state.updated_at, floored at 0
  headline?: string; next_action?: string; summary?: string;   // never for private
}
export type RevVector = Readonly<Record<string, number>>;   // projectId -> state.rev
export interface Truncation {
  level: 0 | 1 | 2 | 3; droppedFields: number; omittedProjects: string[];
}
export interface DigestInput {
  lines: DigestLine[]; serialized: string; chars: number;
  truncation: Truncation; revVector: RevVector;
  knownProjectIds: ReadonlySet<string>;   // projects present in `lines`
}
export type DigestOrigin = InferenceSource | "LOCAL_RULES";
export interface RankedItem extends DigestItem { rank: number; by: "model" | "rule" }
export type DigestErrorCode = AiErrorCode | "NO_CAPSULES" | "INPUT_FLOOR_OVER_BUDGET";
export interface DigestRecord {
  needs_you: RankedItem[]; brief: string; origin: DigestOrigin;
  fallback: boolean; truncated: boolean; revVector: RevVector;
  prompt_version: string; builtAt: number;
  error?: DigestErrorCode; rejects?: Reject[]; invalidInputs: number;
}
export type DigestFreshness = "fresh" | "stale";

export interface DigestConfig {
  ondevice_max_input_tokens: number;   // 7300 (char cap, U06 B9)
  prompt_frame_chars: number;          // U07 frame size; value AUSENTE, required
  min_inference_interval_ms: number;   // 20000
  prompt_version: string;              // "v1"
}
export interface DigestDeps {
  hybrid: Pick<Hybrid, "run">;
  buildPrompt(input: DigestInput): string;              // U07
  clock: { now(): number; setTimer(ms: number, fn: () => void): () => void };
  ledger: { inc(c: "on_device" | "in_cloud" | "fallbacks" | "schema_rejects"): void };
}
