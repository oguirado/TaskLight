import type { SlotId, WriteKind } from "./types";

export const SLOT_ALLOWLIST: Readonly<Record<SlotId, { field: string; writes: readonly WriteKind[] }>> = {
  status_chip: { field: "status", writes: ["class"] },
  headline: { field: "headline", writes: ["textContent"] },
  summary: { field: "summary", writes: ["textContent"] },
  next_step: { field: "next_action", writes: ["textContent"] },
  checklist: { field: "steps", writes: ["textContent", "class"] },
  progress: { field: "progress", writes: ["attribute"] },
  focus_banner: { field: "attention", writes: ["textContent"] },
  source_badge: { field: "inference_source", writes: ["class"] },
  stale_badge: { field: "stale", writes: ["class"] },
};
