import type { DigestCapsuleIn, DigestConfig, DigestErrorCode, DigestRecord } from "./types";
import { revVectorOf } from "./freshness";
import { rankNeedsYou } from "./rank";
import { projectCapsule } from "./project";

export function localDigest(caps: readonly DigestCapsuleIn[], cfg: DigestConfig, now: number, error?: DigestErrorCode): DigestRecord {
  let invalid = 0;
  for (const c of caps) {
    let line: unknown = null;
    try { line = projectCapsule(c, now); } catch { line = null; }
    if (line === null) invalid++;
  }
  const needs = rankNeedsYou(null, caps, now);
  const rv = revVectorOf(caps);
  const rec: DigestRecord = {
    needs_you: needs,
    brief: `${needs.length} project(s) need you`,
    origin: "LOCAL_RULES",
    fallback: false,
    truncated: false,
    revVector: rv,
    prompt_version: cfg.prompt_version,
    builtAt: now,
    invalidInputs: invalid,
  };
  if (error !== undefined) rec.error = error;
  return rec;
}
