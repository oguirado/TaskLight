import { validateCapsuleState } from "../schema";
import { getLens } from "../lens";
import type { DigestCapsuleIn, DigestFreshness, DigestRecord, RevVector } from "./types";

function isValidForRev(c: unknown): boolean {
  if (c === null || typeof c !== "object") return false;
  const stateRaw: unknown = (c as DigestCapsuleIn).state;
  const tierRaw = (c as DigestCapsuleIn).tier as unknown;
  if (!stateRaw || typeof stateRaw !== "object" || Array.isArray(stateRaw)) return false;
  const rec = stateRaw as Record<string, unknown>;
  let lensId: string;
  if (rec["lens_id"] === undefined) lensId = "dev";
  else if (typeof rec["lens_id"] === "string") lensId = rec["lens_id"];
  else return false;
  const lens = getLens(lensId);
  if (lens === undefined) return false;
  const v = validateCapsuleState(stateRaw, tierRaw as never, { lens_id: lens.lens_id, statuses: lens.statuses });
  if (v.ok) return true;
  return v.errors.length > 0 && v.errors.every((e) => e.code === "PRIVATE_TEXT");
}

function setRev(out: Record<string, number>, k: string, v: number): void {
  Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
}

export function revVectorOf(caps: readonly DigestCapsuleIn[]): RevVector {
  const out: Record<string, number> = {};
  for (const c of caps) {
    if (!isValidForRev(c)) continue;
    const pid = (c as DigestCapsuleIn).projectId;
    if (typeof pid !== "string") continue;
    const st = (c as DigestCapsuleIn).state as unknown as Record<string, unknown> | null;
    const rv = st?.["rev"];
    if (typeof rv === "number" && Number.isFinite(rv)) {
      if (!Object.hasOwn(out, pid)) setRev(out, pid, rv);
      else {
        Object.defineProperty(out, pid, { value: rv, enumerable: true, configurable: true, writable: true });
      }
    }
  }
  return out as RevVector;
}

export function digestFreshness(d: DigestRecord, current: RevVector): DigestFreshness {
  const a = d.revVector as Record<string, number>;
  const ka = Object.keys(a);
  const kb = Object.keys(current as Record<string, number>);
  if (ka.length !== kb.length) return "stale";
  for (const k of ka) {
    if (!Object.hasOwn(current, k)) return "stale";
    if (current[k] !== a[k]) return "stale";
  }
  for (const k of kb) {
    if (!Object.hasOwn(a, k)) return "stale";
  }
  return "fresh";
}
