import type { PrivacyTier, TaskId } from "../schema";
import { AI_DEFAULTS, type AiConfig, type ModeName } from "./types";

const MODES: readonly string[] = ["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"];
const TASKS: readonly TaskId[] = ["status", "summary", "next_action", "screenshot", "digest"];

function isModeName(v: unknown): v is ModeName {
  return typeof v === "string" && MODES.includes(v);
}
function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function resolveMode(task: TaskId, tier: PrivacyTier, cfg: AiConfig): ModeName {
  const raw: unknown = (cfg as unknown as Record<string, unknown>)[`mode_${task}`];
  const base: ModeName = isModeName(raw) ? raw : AI_DEFAULTS[`mode_${task}` as const];
  if (task === "screenshot") return "ONLY_ON_DEVICE";
  if (tier === "private") return "ONLY_ON_DEVICE";
  if (cfg.kill_switch_cloud === true) return "ONLY_ON_DEVICE";
  return base;
}

export function parseConfig(raw: Record<string, unknown>): { cfg: AiConfig; warnings: string[] } {
  const warnings: string[] = [];
  const cfg: AiConfig = { ...AI_DEFAULTS };
  const modeKeys = TASKS.map((t) => `mode_${t}` as const);
  for (const key of modeKeys) {
    const v: unknown = raw[key];
    if (v === undefined) continue;
    if (isModeName(v)) {
      cfg[key] = v;
    } else {
      warnings.push(`invalid ${key}: falling back to default`);
    }
  }
  const vTokens: unknown = raw["max_output_tokens"];
  if (vTokens !== undefined) {
    if (isPosInt(vTokens)) cfg.max_output_tokens = vTokens;
    else warnings.push("invalid max_output_tokens: falling back to default");
  }
  const vInput: unknown = raw["ondevice_max_input_tokens"];
  if (vInput !== undefined) {
    if (isPosInt(vInput)) cfg.ondevice_max_input_tokens = vInput;
    else warnings.push("invalid ondevice_max_input_tokens: falling back to default");
  }
  const vPrompt: unknown = raw["prompt_version"];
  if (vPrompt !== undefined) {
    if (isNonEmptyString(vPrompt)) cfg.prompt_version = vPrompt;
    else warnings.push("invalid prompt_version: falling back to default");
  }
  const vModel: unknown = raw["model_name"];
  if (vModel !== undefined) {
    if (isNonEmptyString(vModel)) cfg.model_name = vModel;
    else warnings.push("invalid model_name: falling back to default");
  }
  const vKill: unknown = raw["kill_switch_cloud"];
  if (vKill !== undefined) {
    if (typeof vKill === "boolean") cfg.kill_switch_cloud = vKill;
    else warnings.push("invalid kill_switch_cloud: falling back to default");
  }
  return { cfg, warnings };
}
