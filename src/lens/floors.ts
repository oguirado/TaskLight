import type { PrivacyTier } from "../schema/index";
import type { LensMode, LensSource } from "./types";

const PREFER: LensMode = "PREFER_ON_DEVICE";
const ONLY: LensMode = "ONLY_ON_DEVICE";

function row(standard: LensMode | null, shared: LensMode | null, priv: LensMode | null) {
  return Object.freeze({ private: priv, standard, shared }) as Readonly<Record<PrivacyTier, LensMode | null>>;
}

export const SOURCE_FLOORS: Readonly<Record<LensSource, Readonly<Record<PrivacyTier, LensMode | null>>>> =
  Object.freeze({
    agent: row(null, null, ONLY),
    ci: row(null, null, ONLY),
    git: row(null, null, ONLY),
    tab: row(PREFER, PREFER, ONLY),
    selection: row(PREFER, PREFER, ONLY),
    page: row(ONLY, ONLY, ONLY),
    doc: row(ONLY, ONLY, ONLY),
  });

const RANK: Record<LensMode, number> = {
  ONLY_IN_CLOUD: 0,
  PREFER_IN_CLOUD: 1,
  PREFER_ON_DEVICE: 2,
  ONLY_ON_DEVICE: 3,
};

export function effectiveMode(floor: LensMode | null, requested: LensMode): LensMode {
  if (floor === null) return requested;
  const rf = RANK[floor];
  const rr = RANK[requested];
  if (rf === undefined || rr === undefined) return requested;
  return rf > rr ? floor : requested;
}
