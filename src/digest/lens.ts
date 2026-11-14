import { validateCapsuleState, LIMITS } from "../schema";
import type { Attention, CapsuleState, PrivacyTier, Validated, Reject } from "../schema";
import { getLens } from "../lens";
import type { LensId } from "../lens";

export interface LensDigestInput {
  projectId: string;
  lens_id: LensId;
  status: string;
  attention: Attention;
  headline?: string;
}
export interface LensDigestCapsule {
  projectId: string;
  state: CapsuleState;
  tier: PrivacyTier;
  lens_id: string;
}

export function buildDigestInputs(caps: readonly LensDigestCapsule[]): Validated<LensDigestInput[]> {
  const errors: Reject[] = [];
  if (caps.length > LIMITS.NEEDS_YOU_MAX) {
    errors.push({ code: "TOO_MANY_ITEMS", path: "" });
  }
  const seen = new Set<string>();
  let dup = false;
  for (const c of caps) {
    if (c && typeof c.projectId === "string") {
      if (seen.has(c.projectId)) dup = true;
      else seen.add(c.projectId);
    }
  }
  if (dup) errors.push({ code: "DUPLICATE_PROJECT", path: "" });
  const validated: Array<{ cap: LensDigestCapsule; value: CapsuleState } | null> = [];
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i]!;
    let bad = false;
    const stateLens = (c.state as unknown as Record<string, unknown> | null)?.["lens_id"];
    if (typeof stateLens === "string" && c.lens_id !== stateLens) {
      errors.push({ code: "LENS_MISMATCH", path: `caps[${i}].lens_id` });
      bad = true;
    }
    const lens = getLens(c.lens_id);
    if (lens === undefined) {
      errors.push({ code: "BAD_LENS", path: `caps[${i}].lens_id` });
      bad = true;
      validated.push(null);
      continue;
    }
    const v = validateCapsuleState(c.state, c.tier, { lens_id: lens.lens_id, statuses: lens.statuses });
    if (!v.ok) {
      for (const e of v.errors) errors.push(e);
      bad = true;
      validated.push(null);
    } else {
      if (bad) validated.push(null);
      else validated.push({ cap: c, value: v.value });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const out: LensDigestInput[] = [];
  for (const item of validated) {
    if (item === null) continue;
    const { cap, value } = item;
    const isText = cap.tier === "standard" || cap.tier === "shared";
    const li: LensDigestInput = { projectId: cap.projectId, lens_id: cap.lens_id as LensId, status: value.status, attention: value.attention };
    if (isText && value.headline !== undefined) li.headline = value.headline;
    out.push(li);
  }
  return { ok: true, value: out };
}
