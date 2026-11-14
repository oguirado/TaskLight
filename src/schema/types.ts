import type { Attention, InferenceSource, StepState } from "./enums";

export type LensStatus = string;

export interface StatusOutput     { status: LensStatus }
export interface SummaryOutput    { headline: string; summary: string }
export interface NextActionOutput { next_action: string; attention: Attention }
export interface ScreenshotOutput { status: LensStatus; note: string }
export interface DigestItem       { projectId: string; reason: string; attention: Attention }
export interface DigestOutput     { needs_you: DigestItem[]; brief: string }
export interface PlanStep   { text: string; state: StepState }
export interface PlanOutput { steps: PlanStep[]; progress: number }
export interface TaskOutputMap {
  status: StatusOutput; summary: SummaryOutput; next_action: NextActionOutput;
  screenshot: ScreenshotOutput; digest: DigestOutput; plan: PlanOutput;
}

export type TextField = "headline" | "summary" | "next_action";
export interface CapsuleState {
  lens_id: string;
  rev: number; observed_rev: number; status: LensStatus;
  headline?: string; summary?: string; next_action?: string;
  steps?: PlanStep[]; progress?: number;
  attention: Attention; inference_source: InferenceSource;
  updated_at: number;
  writer_uid: string;
}
export type PatchFields = Partial<Pick<CapsuleState,
  "status" | "headline" | "summary" | "next_action" | "attention" | "steps" | "progress">>;
export interface CapsulePatch {
  lens_id: string;
  projectId: string; base_rev: number; observed_rev: number;
  prompt_version: string; template_hash: string;
  inference_source: InferenceSource; fields: PatchFields;
}

export interface JsonSchema {
  type: "object" | "array" | "string" | "number";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  nullable?: boolean;
}
export interface TaskSchema { mimeType: "application/json" | "text/x.enum"; schema: JsonSchema }
