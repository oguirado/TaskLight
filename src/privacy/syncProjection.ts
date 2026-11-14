import type { CapsuleState, PrivacyTier } from "../schema";
import { validateCapsuleState } from "../schema";
import { getLens } from "../lens";
import type { LensVocab } from "../schema";
import type { GuardResult, SyncCapsule } from "./types";

const NON_TEXT_KEYS: readonly string[] = [
  "lens_id",
  "rev",
  "observed_rev",
  "status",
  "attention",
  "inference_source",
  "updated_at",
  "writer_uid",
  "progress",
];

const TEXT_KEYS: readonly string[] = ["headline", "summary", "next_action"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function syncProjection(s: CapsuleState, tier: PrivacyTier): SyncCapsule {
  const raw = s as unknown as Record<string, unknown>;
  const t = tier as string;
  const isStandard = t === "standard" || t === "shared";
  const out: Record<string, unknown> = {};
  for (const key of NON_TEXT_KEYS) {
    if (Object.hasOwn(raw, key)) {
      out[key] = raw[key];
    }
  }
  if (isStandard) {
    for (const key of TEXT_KEYS) {
      if (Object.hasOwn(raw, key)) {
        out[key] = raw[key];
      }
    }
    if (Object.hasOwn(raw, "steps")) {
      const steps: unknown = raw["steps"];
      if (Array.isArray(steps)) {
        out["steps"] = steps.map((el: unknown) => {
          if (el !== null && typeof el === "object" && !Array.isArray(el)) {
            return { ...(el as Record<string, unknown>) };
          }
          return el;
        });
      } else {
        out["steps"] = steps;
      }
    }
  }
  return out as unknown as SyncCapsule;
}

function resolveLensFor(s: unknown): LensVocab | undefined {
  try {
    if (!isPlainObject(s)) return undefined;
    const id: unknown = s["lens_id"];
    if (id !== "dev" && id !== "study") return undefined;
    const fetched = getLens(id);
    if (fetched === undefined) return undefined;
    return { lens_id: fetched.lens_id as string, statuses: fetched.statuses as readonly string[] };
  } catch {
    return undefined;
  }
}

export function guardSyncWrite(s: unknown, tier: PrivacyTier): GuardResult {
  try {
    const lens = resolveLensFor(s);
    const result =
      lens !== undefined ? validateCapsuleState(s, tier, lens) : validateCapsuleState(s, tier);
    if (result.ok) {
      return { ok: true, value: result.value as unknown as SyncCapsule };
    }
    return { ok: false, rejects: result.errors };
  } catch {
    return { ok: false, rejects: [{ code: "NOT_OBJECT", path: "" }] };
  }
}
