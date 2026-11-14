import type { PrivacyTier } from "../schema";
import type { ScreenshotRefuse } from "../privacy/types";
import type { Counts, DayLedger, PanelModel, PanelRow, PrivacyVerdict } from "./types";

const TIER_KEYS: readonly string[] = ["private", "standard", "shared"];

function zeroCounts(): Counts {
  return {
    on_device: 0,
    in_cloud: 0,
    fallbacks: 0,
    refusals: 0,
    schema_rejects: 0,
    unattributed: 0,
  } as Counts;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function buildPanelModel(
  day: DayLedger,
  tiers: Readonly<Record<string, PrivacyTier>>,
  screenshot: Readonly<Record<string, "enabled" | ScreenshotRefuse>>,
  syncState: PanelModel["syncState"],
): PanelModel {
  const dayKey = (day?.dayKey ?? "") as string;
  const byProject: Record<string, Record<string, Counts>> = {};
  try {
    const bp: unknown = (day as DayLedger)?.byProject;
    if (bp !== null && typeof bp === "object") {
      for (const [projectId, tierMap] of Object.entries(bp as Record<string, unknown>)) {
        if (tierMap !== null && typeof tierMap === "object") {
          byProject[projectId] = tierMap as Record<string, Counts>;
        }
      }
    }
  } catch {
    // malformed day input degrades to empty
  }

  const tierOf: Record<string, PrivacyTier> = {};
  try {
    if (tiers !== null && typeof tiers === "object") {
      for (const [projectId, tier] of Object.entries(tiers as Record<string, unknown>)) {
        tierOf[projectId] = tier as PrivacyTier;
      }
    }
  } catch {
    // degrade to empty tier map
  }

  const shotOf: Record<string, "enabled" | ScreenshotRefuse> = {};
  try {
    if (screenshot !== null && typeof screenshot === "object") {
      for (const [projectId, value] of Object.entries(
        screenshot as Record<string, unknown>,
      )) {
        if (value === "enabled" || value === "MULTIMODAL_UNAVAILABLE" ||
          value === "DEVICE_NOT_READY" || value === "INPUT_REJECTED") {
          shotOf[projectId] = value as "enabled" | ScreenshotRefuse;
        }
      }
    }
  } catch {
    // degrade to defaults
  }

  const projectIds = Object.keys(tierOf).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const totals = zeroCounts() as unknown as {
    on_device: number; in_cloud: number; fallbacks: number;
    refusals: number; schema_rejects: number; unattributed: number;
  };
  const rows: PanelRow[] = [];

  for (const projectId of projectIds) {
    const tierNow = tierOf[projectId] as PrivacyTier;
    const tierMap = byProject[projectId] ?? {};
    let on_device = 0;
    let in_cloud = 0;
    let fallbacks = 0;
    let refusals = 0;
    let schema_rejects = 0;
    let unattributed = 0;
    let activeTiers = 0;
    for (const tierKey of TIER_KEYS) {
      const c: unknown = tierMap[tierKey];
      if (c === null || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      const od = num(rec["on_device"]);
      const ic = num(rec["in_cloud"]);
      const fb = num(rec["fallbacks"]);
      const rf = num(rec["refusals"]);
      const sr = num(rec["schema_rejects"]);
      const ua = num(rec["unattributed"]);
      on_device += od;
      in_cloud += ic;
      fallbacks += fb;
      refusals += rf;
      schema_rejects += sr;
      unattributed += ua;
      if (od > 0 || ic > 0 || fb > 0 || rf > 0 || sr > 0 || ua > 0) activeTiers++;
    }
    const counts = {
      on_device,
      in_cloud,
      fallbacks,
      refusals,
      schema_rejects,
      unattributed,
    } as Counts;
    totals.on_device += on_device;
    totals.in_cloud += in_cloud;
    totals.fallbacks += fallbacks;
    totals.refusals += refusals;
    totals.schema_rejects += schema_rejects;
    totals.unattributed += unattributed;

    let verdict: PrivacyVerdict = "not_private";
    if ((tierNow as string) === "private") {
      const priv: unknown = tierMap["private"];
      const p = priv !== null && typeof priv === "object"
        ? (priv as Record<string, unknown>)
        : {};
      const pCloud = num(p["in_cloud"]);
      const pFallbacks = num(p["fallbacks"]);
      const pUnattributed = num(p["unattributed"]);
      if (pCloud > 0 || pFallbacks > 0) verdict = "cloud_seen";
      else if (pUnattributed > 0) verdict = "unverifiable";
      else verdict = "zero_cloud";
    }

    rows.push({
      projectId,
      tierNow,
      counts,
      verdict,
      tierChangedToday: activeTiers > 1,
      screenshot: shotOf[projectId] ?? "enabled",
    });
  }

  return {
    dayKey,
    rows,
    totals: totals as Counts,
    syncState,
  };
}
