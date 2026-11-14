import { ATTENTION, CAPSULE_STATUS } from "../schema";
import { DEFAULT_PROMPT_VERSION, PROMPT_LIMITS } from "./limits";
import { PROMPT_PACKS } from "./templates";
import type { TaskId } from "../schema";

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function templateHash(task: TaskId, version: string): string {
  const pack = Object.hasOwn(PROMPT_PACKS, version) ? PROMPT_PACKS[version] : PROMPT_PACKS[DEFAULT_PROMPT_VERSION];
  const tpl = pack?.templates[task];
  const header = tpl?.header ?? "";
  const footer = tpl?.footer ?? "";
  const v = pack?.version ?? version;
  const canon = [v, task, header, footer, CAPSULE_STATUS.join(","), ATTENTION.join(","), JSON.stringify(PROMPT_LIMITS)].join("\n");
  return hashString(canon);
}
