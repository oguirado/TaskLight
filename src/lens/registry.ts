import type { Lens, LensId, LensRegistry, LensReject, LensResult } from "./types";
import { validateLens } from "./validate";
import { DEV_LENS_DESCRIPTOR } from "./lenses/dev";
import { STUDY_LENS_DESCRIPTOR } from "./lenses/study";

export class LensRegistryError extends Error {}

function sortErrors(errors: LensReject[]): LensReject[] {
  return [...errors].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

function makeRegistry(map: Map<LensId, Lens>, ids: readonly LensId[]): LensRegistry {
  return {
    get(id: string): Lens | undefined {
      if (!Object.hasOwn(Object.fromEntries(map), id)) return undefined;
      return map.get(id as LensId);
    },
    ids(): readonly LensId[] {
      return ids;
    },
  };
}

export function buildRegistry(ds: readonly unknown[]): LensResult<LensRegistry> {
  try {
    if (!Array.isArray(ds)) {
      return { ok: false, errors: [{ code: "WRONG_TYPE", path: "" }] };
    }
    const errors: LensReject[] = [];
    const map = new Map<LensId, Lens>();
    for (const item of ds as unknown[]) {
      const r = validateLens(item);
      if (!r.ok) {
        for (const e of r.errors) errors.push(e);
        continue;
      }
      const lens = r.value;
      if (map.has(lens.lens_id)) {
        errors.push({ code: "DUPLICATE_LENS", path: "lens_id" });
      } else {
        map.set(lens.lens_id, lens);
      }
    }
    if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };
    const ids = Object.freeze([...map.keys()].sort() as LensId[]);
    return { ok: true, value: makeRegistry(map, ids) };
  } catch {
    return { ok: false, errors: [{ code: "NOT_PLAIN", path: "" }] };
  }
}

function buildLenses(): LensRegistry {
  const r = buildRegistry([DEV_LENS_DESCRIPTOR, STUDY_LENS_DESCRIPTOR]);
  if (!r.ok) throw new LensRegistryError("invalid built-in lens descriptor");
  return r.value;
}

export const LENSES: LensRegistry = buildLenses();

export function getLens(id: string): Lens | undefined {
  return LENSES.get(id);
}
