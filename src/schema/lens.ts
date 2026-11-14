import { CAPSULE_STATUS, LENS_ID_RE, STATUS_RE } from "./enums";
import { LIMITS } from "./limits";
import type { Validated } from "./validate";

export interface LensVocab { readonly lens_id: string; readonly statuses: readonly string[] }

export const DEV_LENS: LensVocab = Object.freeze({ lens_id: "dev", statuses: CAPSULE_STATUS });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function validateLensVocab(l: unknown): Validated<LensVocab> {
  const bad: Validated<LensVocab> = { ok: false, errors: [{ code: "BAD_LENS", path: "lens" }] };
  if (!isPlainObject(l)) return bad;
  const keys = Object.keys(l);
  if (keys.length !== 2 || !keys.includes("lens_id") || !keys.includes("statuses")) return bad;
  const lensId: unknown = l["lens_id"];
  if (typeof lensId !== "string" || !LENS_ID_RE.test(lensId)) return bad;
  const statuses: unknown = l["statuses"];
  if (!Array.isArray(statuses)) return bad;
  if (statuses.length < 1 || statuses.length > LIMITS.LENS_STATUSES_MAX) return bad;
  const seen = new Set<string>();
  for (const s of statuses) {
    if (typeof s !== "string" || !STATUS_RE.test(s)) return bad;
    if (seen.has(s)) return bad;
    seen.add(s);
  }
  return { ok: true, value: { lens_id: lensId, statuses: [...statuses] as string[] } };
}
