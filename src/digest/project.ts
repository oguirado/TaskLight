import { validateCapsuleState } from "../schema";
import { getLens } from "../lens";
import type { DigestCapsuleIn, DigestLine } from "./types";

export function projectCapsule(c: DigestCapsuleIn, now: number): DigestLine | null {
  if (c === null || typeof c !== "object") return null;
  const projectId = (c as DigestCapsuleIn).projectId;
  if (typeof projectId !== "string") return null;
  const stateRaw: unknown = (c as DigestCapsuleIn).state;
  const tierRaw = (c as DigestCapsuleIn).tier as unknown;
  if (!stateRaw || typeof stateRaw !== "object" || Array.isArray(stateRaw)) return null;
  const rec = stateRaw as Record<string, unknown>;
  let lensId: string;
  if (rec["lens_id"] === undefined) {
    lensId = "dev";
  } else if (typeof rec["lens_id"] === "string") {
    lensId = rec["lens_id"];
  } else {
    return null;
  }
  const lens = getLens(lensId);
  if (lens === undefined) return null;
  const lensVocab = { lens_id: lens.lens_id, statuses: lens.statuses };
  const v = validateCapsuleState(stateRaw, tierRaw as never, lensVocab);
  let status: string;
  let attention: string;
  let updatedAt: number;
  let validated: { headline?: string; next_action?: string; summary?: string } | null = null;
  if (v.ok) {
    status = v.value.status;
    attention = v.value.attention;
    updatedAt = v.value.updated_at;
    validated = {};
    if (v.value.headline !== undefined) validated.headline = v.value.headline;
    if (v.value.next_action !== undefined) validated.next_action = v.value.next_action;
    if (v.value.summary !== undefined) validated.summary = v.value.summary;
  } else {
    const onlyPrivateText = v.errors.length > 0 && v.errors.every((e) => e.code === "PRIVATE_TEXT");
    if (!onlyPrivateText) return null;
    const st = rec["status"];
    const at = rec["attention"];
    const up = rec["updated_at"];
    if (typeof st !== "string" || typeof at !== "string" || typeof up !== "number") return null;
    if (!Number.isFinite(up)) return null;
    status = st;
    attention = at;
    updatedAt = up;
    validated = null;
  }
  const waitingMs = Math.max(0, now - updatedAt);
  const isTextTier = tierRaw === "standard" || tierRaw === "shared";
  if (!isTextTier) {
    const line: DigestLine = { projectId, status: status as never, attention: attention as never, waiting_ms: waitingMs };
    return line;
  }
  const hl = validated?.headline;
  const na = validated?.next_action;
  const su = validated?.summary;
  const line: DigestLine = { projectId, status: status as never, attention: attention as never, waiting_ms: waitingMs };
  if (hl !== undefined) line.headline = hl;
  if (na !== undefined) line.next_action = na;
  if (su !== undefined) line.summary = su;
  return line;
}
