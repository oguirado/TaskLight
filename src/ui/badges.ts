import type { TemplateSpec, FieldAllowlist } from "./types";
import { CAPSULE_STATUS, ATTENTION } from "../schema";

/** Template must carry unique slots: root, headline, summary, status, attention, next_action, source,
 *  badge, stale_badge, updated_at, step_1..step_5. */
export function capsuleTemplate(): { template: TemplateSpec; allowlist: FieldAllowlist } {
  const slot = (name: string, tag: "div" | "span" | "p" | "h3" | "time") => ({
    tag,
    slot: name,
  });

  const template: TemplateSpec = {
    templateHash: "u20-capsule-v1",
    root: {
      tag: "div",
      slot: "root",
      children: [
        slot("headline", "h3"),
        slot("summary", "p"),
        slot("status", "span"),
        slot("attention", "span"),
        slot("next_action", "span"),
        slot("source", "span"),
        slot("badge", "span"),
        slot("stale_badge", "span"),
        slot("updated_at", "time"),
        slot("step_1", "div"),
        slot("step_2", "div"),
        slot("step_3", "div"),
        slot("step_4", "div"),
        slot("step_5", "div"),
      ],
    },
  };

  const statusClassMap: Record<string, string> = {};
  for (const s of CAPSULE_STATUS) statusClassMap[s] = `is-status-${s}`;
  const attentionClassMap: Record<string, string> = {};
  for (const a of ATTENTION) attentionClassMap[a] = `is-attention-${a}`;

  const allowlist: FieldAllowlist = {
    status: { kind: "class", slot: "status", classMap: statusClassMap },
    attention: { kind: "class", slot: "attention", classMap: attentionClassMap },
    headline: { kind: "text", slot: "headline", maxChars: 120 },
    summary: { kind: "text", slot: "summary", maxChars: 600 },
    next_action: { kind: "text", slot: "next_action" },
    inference_source: { kind: "attr", slot: "source", attr: "data-source" },
    stale: { kind: "class", slot: "stale_badge", classMap: { true: "is-stale", false: "is-not-stale" } },
    updated_at: { kind: "text", slot: "updated_at" },
  };

  return { template, allowlist };
}
