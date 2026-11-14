// U39 Nano helpers: constraint, prompt, strict label parsing.
import type { RouteTarget } from "./types";
import { ROUTE_TARGETS } from "./types";

const LABELS: readonly string[] = [...ROUTE_TARGETS, "abstain"];
const LABEL_SET: Set<string> = new Set(LABELS);

export function buildConstraint(): { type: "string"; enum: string[] } {
  return { type: "string", enum: [...LABELS] };
}

export function buildClassifierPrompt(text: string): string {
  const safe = typeof text === "string" ? text : "";
  const capped = safe.length > 2000 ? safe.slice(0, 2000) : safe;
  return `Classify the message into exactly one label from: ${LABELS.join(", ")}. Reply with the label only, or "abstain" if none fits.\nMessage: ${capped}`;
}

export function parseLabel(text: string): RouteTarget | "abstain" | null {
  if (typeof text !== "string") return null;
  if (!LABEL_SET.has(text)) return null;
  return text as RouteTarget | "abstain";
}
