import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalise } from "./normalise";
import { replayDigest } from "./digest";
import { INGEST_LIMITS } from "./limits";
import type { CapsuleEvent, EventSource, ProjectRegistry } from "./types";
import type { FixtureProject, ReplayManifest } from "./replay";
import type { PrivacyTier } from "../schema";

const PROJECT_IDS = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;

const GROUP: Record<EventSource, string[]> = {
  agent: ["output", "waiting_input", "error", "exit"],
  ci: ["ci_started", "ci_passed", "ci_failed"],
  git: ["commit", "push"],
};

const tiers: Record<string, PrivacyTier> = {};
PROJECT_IDS.forEach((p, i) => {
  tiers[p] = i === 1 ? "private" : "standard";
});
const projects: FixtureProject[] = PROJECT_IDS.map((p, i) => ({
  projectId: p,
  tier: tiers[p] as PrivacyTier,
  label: p.charAt(0).toUpperCase() + p.slice(1),
}));

const seqs: Record<string, number> = {};
const reg: ProjectRegistry = {
  tierOf: (p) => tiers[p],
  lastSeq: (p, s) => seqs[`${p}:${s}`],
};

const sources: EventSource[] = ["agent", "ci", "git"];
const events: CapsuleEvent[] = [];
for (let i = 0; i < INGEST_LIMITS.FIXTURE_EVENTS; i++) {
  const projectId = PROJECT_IDS[i % PROJECT_IDS.length] as string;
  const source = sources[i % sources.length] as EventSource;
  const kinds = GROUP[source];
  const kind = kinds[Math.floor(i / 3) % kinds.length] as string;
  const key = `${projectId}:${source}`;
  const sourceSeq = (seqs[key] ?? 0) + 1;
  const ts = 1_700_000_000_000 + i * 250;
  const text = `step ${i} ok`;
  const raw = JSON.stringify({ source, projectId, sourceSeq, ts, kind, text });
  const result = normalise(raw, reg);
  if (!result.ok) {
    throw new Error(`fixture generation failed at ${i}: ${JSON.stringify(result.errors)}`);
  }
  seqs[key] = sourceSeq;
  events.push(result.value);
}

const manifest: ReplayManifest = {
  version: "v1",
  projects,
  eventCount: INGEST_LIMITS.FIXTURE_EVENTS,
  digest: replayDigest(events),
};

const dir = join(process.cwd(), "fixtures", "replay", "v1");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
