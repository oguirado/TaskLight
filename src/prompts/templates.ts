import { ATTENTION, CAPSULE_STATUS } from "../schema";
import type { PromptPack } from "./types";

const FOOTER = "Respond only with the required JSON or enum value.";
const STATUSES = CAPSULE_STATUS.join(", ");
const ATTENTIONS = ATTENTION.join(", ");

function makePack(version: string): PromptPack {
  const templates: PromptPack["templates"] = Object.freeze({
    status: Object.freeze({ header: `Determine the current capsule status for a project.\nAllowed statuses: ${STATUSES}.`, footer: FOOTER }),
    summary: Object.freeze({ header: `Summarize the current state of a project.\nAllowed statuses: ${STATUSES}.\nAllowed attention: ${ATTENTIONS}.`, footer: FOOTER }),
    next_action: Object.freeze({ header: `Determine the next required action for a project.\nAllowed attention: ${ATTENTIONS}.`, footer: FOOTER }),
    screenshot: Object.freeze({ header: `Determine the capsule status visible in a screenshot caption.\nAllowed statuses: ${STATUSES}.`, footer: FOOTER }),
    digest: Object.freeze({ header: `Rank projects needing attention, highest priority first.\nAllowed attention: ${ATTENTIONS}.`, footer: FOOTER }),
  });
  return Object.freeze({ version, templates });
}

export const PROMPT_PACKS: Readonly<Record<string, PromptPack>> = Object.freeze({ v1: makePack("v1") });
