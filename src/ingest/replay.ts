import { PRIVACY_TIER } from "../schema";
import type { PrivacyTier } from "../schema";
import { canonicalJson } from "./canonical";
import { digestHex, replayDigest } from "./digest";
import { INGEST_LIMITS } from "./limits";
import { hasRedactResidue } from "./redact";
import { safeErrorPath } from "./normalise";
import { EVENT_KIND, EVENT_SOURCE } from "./types";
import type {
  CapsuleEvent, EventKind, EventSource, Ingested, IngestReject,
  IngestRejectCode, RedactResult,
} from "./types";

export interface FixtureProject { projectId: string; tier: PrivacyTier; label: string }
export interface ReplayManifest {
  version: "v1"; projects: FixtureProject[]; eventCount: number; digest: string;
}
export interface ScheduledEvent { atMs: number; event: CapsuleEvent }

const KIND_GROUP: Record<EventSource, readonly string[]> = {
  agent: ["output", "waiting_input", "error", "exit"],
  ci: ["ci_started", "ci_passed", "ci_failed"],
  git: ["commit", "push"],
};

function sortErrors(errors: IngestReject[]): IngestReject[] {
  return [...errors].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x0a && code !== 0x09) return true;
  }
  return false;
}

function validateManifest(raw: unknown): { errors: IngestReject[]; manifest: ReplayManifest | undefined } {
  const errors: Array<{ code: IngestRejectCode; path: string; detail?: string }> = [];
  if (!isPlainObject(raw)) {
    return { errors: [{ code: "NOT_OBJECT", path: "" }], manifest: undefined };
  }
  const expected = ["version", "projects", "eventCount", "digest"];
  for (const key of Object.keys(raw)) {
    if (!expected.includes(key)) errors.push({ code: "UNKNOWN_FIELD", path: safeErrorPath(key) });
  }
  for (const key of expected) {
    if (!Object.hasOwn(raw, key)) errors.push({ code: "MISSING_FIELD", path: key });
  }

  const versionV = raw["version"];
  let versionOk = false;
  if (Object.hasOwn(raw, "version")) {
    if (typeof versionV !== "string") errors.push({ code: "WRONG_TYPE", path: "version" });
    else if (versionV !== "v1") errors.push({ code: "PARSE_ERROR", path: "version" });
    else versionOk = true;
  }

  const projectsV = raw["projects"];
  const projects: FixtureProject[] = [];
  let projectsOk = false;
  if (Object.hasOwn(raw, "projects")) {
    if (!Array.isArray(projectsV)) {
      errors.push({ code: "WRONG_TYPE", path: "projects" });
    } else {
      if (projectsV.length !== INGEST_LIMITS.FIXTURE_PROJECTS) {
        errors.push({ code: "PARSE_ERROR", path: "projects" });
      }
      const seen = new Set<string>();
      for (const p of projectsV) {
        if (!isPlainObject(p)) {
          errors.push({ code: "NOT_OBJECT", path: "projects" });
          continue;
        }
        const pid = p["projectId"];
        const tier = p["tier"];
        const label = p["label"];
        let ok = true;
        if (typeof pid !== "string") {
          errors.push({ code: "WRONG_TYPE", path: "projectId" });
          ok = false;
        } else if (!INGEST_LIMITS.PROJECT_ID_RE.test(pid)) {
          errors.push({ code: "BAD_PROJECT_ID", path: "projectId" });
          ok = false;
        } else if (seen.has(pid)) {
          errors.push({ code: "PARSE_ERROR", path: "projectId" });
          ok = false;
        }
        if (typeof tier !== "string" || !(PRIVACY_TIER as readonly string[]).includes(tier)) {
          errors.push({ code: "PARSE_ERROR", path: "tier" });
          ok = false;
        }
        if (typeof label !== "string") {
          errors.push({ code: "WRONG_TYPE", path: "label" });
          ok = false;
        }
        if (ok) {
          seen.add(pid as string);
          projects.push({ projectId: pid as string, tier: tier as PrivacyTier, label: label as string });
        }
      }
      if (projects.length === INGEST_LIMITS.FIXTURE_PROJECTS && projectsV.length === INGEST_LIMITS.FIXTURE_PROJECTS) {
        projectsOk = true;
      }
    }
  }

  const countV = raw["eventCount"];
  let countOk = false;
  if (Object.hasOwn(raw, "eventCount")) {
    if (typeof countV !== "number") errors.push({ code: "WRONG_TYPE", path: "eventCount" });
    else if (!Number.isSafeInteger(countV) || countV < 0) errors.push({ code: "BAD_INT", path: "eventCount" });
    else if (countV !== INGEST_LIMITS.FIXTURE_EVENTS) errors.push({ code: "PARSE_ERROR", path: "eventCount" });
    else countOk = true;
  }

  const digestV = raw["digest"];
  let digestStr: string | undefined;
  if (Object.hasOwn(raw, "digest")) {
    if (typeof digestV !== "string") errors.push({ code: "WRONG_TYPE", path: "digest" });
    else if (!/^[0-9a-f]{64}$/.test(digestV)) errors.push({ code: "PARSE_ERROR", path: "digest", detail: "digest mismatch" });
    else digestStr = digestV;
  }

  if (errors.length === 0 && versionOk && projectsOk && countOk && digestStr !== undefined) {
    return { errors: [], manifest: { version: "v1", projects, eventCount: INGEST_LIMITS.FIXTURE_EVENTS, digest: digestStr } };
  }
  return { errors: sortErrors(errors), manifest: undefined };
}

const EVENT_KEYS = ["eventId", "projectId", "source", "kind", "sourceSeq", "ts", "text", "redactions", "truncated", "tier"];

function validateEvent(raw: unknown, tierOf: Map<string, PrivacyTier>): { errors: IngestReject[]; event: CapsuleEvent | undefined } {
  const errors: Array<{ code: IngestRejectCode; path: string; detail?: string }> = [];
  if (!isPlainObject(raw)) {
    return { errors: [{ code: "NOT_OBJECT", path: "" }], event: undefined };
  }
  for (const key of Object.keys(raw)) {
    if (!EVENT_KEYS.includes(key)) errors.push({ code: "UNKNOWN_FIELD", path: safeErrorPath(key) });
  }
  for (const key of EVENT_KEYS) {
    if (!Object.hasOwn(raw, key)) errors.push({ code: "MISSING_FIELD", path: key });
  }

  const eventIdV = raw["eventId"];
  if (Object.hasOwn(raw, "eventId")) {
    if (typeof eventIdV !== "string") errors.push({ code: "WRONG_TYPE", path: "eventId" });
    else if (!/^[0-9a-f]{64}$/.test(eventIdV)) errors.push({ code: "PARSE_ERROR", path: "eventId", detail: "digest mismatch" });
  }
  const projectIdV = raw["projectId"];
  if (Object.hasOwn(raw, "projectId")) {
    if (typeof projectIdV !== "string") errors.push({ code: "WRONG_TYPE", path: "projectId" });
    else {
      if (!INGEST_LIMITS.PROJECT_ID_RE.test(projectIdV)) errors.push({ code: "BAD_PROJECT_ID", path: "projectId" });
      else if (!tierOf.has(projectIdV)) errors.push({ code: "UNKNOWN_PROJECT", path: "projectId" });
    }
  }
  const sourceV = raw["source"];
  const sourceValid = typeof sourceV === "string" && (EVENT_SOURCE as readonly string[]).includes(sourceV);
  if (Object.hasOwn(raw, "source")) {
    if (typeof sourceV !== "string") errors.push({ code: "WRONG_TYPE", path: "source" });
    else if (!sourceValid) errors.push({ code: "BAD_SOURCE", path: "source" });
  }
  const kindV = raw["kind"];
  if (Object.hasOwn(raw, "kind")) {
    if (typeof kindV !== "string") errors.push({ code: "WRONG_TYPE", path: "kind" });
    else if (!(EVENT_KIND as readonly string[]).includes(kindV)) errors.push({ code: "BAD_KIND", path: "kind" });
    else if (sourceValid && typeof sourceV === "string") {
      const group = KIND_GROUP[sourceV as EventSource];
      if (!group.includes(kindV)) errors.push({ code: "BAD_KIND", path: "kind" });
    }
  }
  const seqV = raw["sourceSeq"];
  if (Object.hasOwn(raw, "sourceSeq")) {
    if (typeof seqV !== "number") errors.push({ code: "WRONG_TYPE", path: "sourceSeq" });
    else if (!Number.isSafeInteger(seqV) || seqV < 0) errors.push({ code: "BAD_INT", path: "sourceSeq" });
  }
  const tsV = raw["ts"];
  if (Object.hasOwn(raw, "ts")) {
    if (typeof tsV !== "number") errors.push({ code: "WRONG_TYPE", path: "ts" });
    else if (!Number.isSafeInteger(tsV) || tsV < 0) errors.push({ code: "BAD_INT", path: "ts" });
  }
  const textV = raw["text"];
  if (Object.hasOwn(raw, "text")) {
    if (typeof textV !== "string") errors.push({ code: "WRONG_TYPE", path: "text" });
    else {
      if (hasControlChar(textV)) errors.push({ code: "CONTROL_CHAR", path: "text" });
      if (textV.length > INGEST_LIMITS.EVENT_TEXT_MAX) errors.push({ code: "PARSE_ERROR", path: "text" });
      else if (hasRedactResidue(textV)) errors.push({ code: "REDACT_RESIDUE", path: "text" });
    }
  }
  const redV = raw["redactions"];
  if (Object.hasOwn(raw, "redactions")) {
    if (typeof redV !== "number") errors.push({ code: "WRONG_TYPE", path: "redactions" });
    else if (!Number.isSafeInteger(redV) || redV < 0) errors.push({ code: "BAD_INT", path: "redactions" });
  }
  const truncV = raw["truncated"];
  if (Object.hasOwn(raw, "truncated")) {
    if (typeof truncV !== "boolean") errors.push({ code: "WRONG_TYPE", path: "truncated" });
  }
  const tierV = raw["tier"];
  if (Object.hasOwn(raw, "tier")) {
    if (typeof tierV !== "string" || !(PRIVACY_TIER as readonly string[]).includes(tierV)) {
      errors.push({ code: "PARSE_ERROR", path: "tier" });
    } else if (typeof projectIdV === "string" && tierOf.has(projectIdV)) {
      if (tierOf.get(projectIdV) !== (tierV as PrivacyTier)) {
        errors.push({ code: "PARSE_ERROR", path: "tier" });
      }
    }
  }

  if (errors.length > 0) return { errors: sortErrors(errors), event: undefined };

  const { eventId: _omit, ...rest } = raw as unknown as CapsuleEvent;
  const expectedId = digestHex(canonicalJson(rest));
  if (expectedId !== (eventIdV as string)) {
    return { errors: [{ code: "PARSE_ERROR", path: "eventId", detail: "digest mismatch" }], event: undefined };
  }

  const event: CapsuleEvent = {
    eventId: eventIdV as string,
    projectId: projectIdV as string,
    source: sourceV as EventSource,
    kind: kindV as EventKind,
    sourceSeq: (seqV as number) === 0 ? 0 : (seqV as number),
    ts: (tsV as number) === 0 ? 0 : (tsV as number),
    text: textV as string,
    redactions: (redV as number) === 0 ? 0 : (redV as number),
    truncated: truncV as boolean,
    tier: tierV as PrivacyTier,
  };
  return { errors: [], event };
}

export function loadFixture(manifestJson: string, eventsJsonl: string): Ingested<{ manifest: ReplayManifest; events: CapsuleEvent[] }> {
  try {
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(manifestJson);
    } catch {
      return { ok: false, errors: [{ code: "PARSE_ERROR", path: "" }] };
    }
    const mv = validateManifest(manifestRaw);
    if (!mv.manifest) {
      return { ok: false, errors: mv.errors.length > 0 ? mv.errors : [{ code: "PARSE_ERROR", path: "" }] };
    }
    const manifest = mv.manifest;
    const tierOf = new Map<string, PrivacyTier>(manifest.projects.map((p) => [p.projectId, p.tier]));

    const lines = (eventsJsonl ?? "").split("\n").filter((l) => l.length > 0);
    const errors: IngestReject[] = [];
    const events: CapsuleEvent[] = [];
    for (const line of lines) {
      let rawLine: unknown;
      try {
        rawLine = JSON.parse(line);
      } catch {
        errors.push({ code: "PARSE_ERROR", path: "" });
        continue;
      }
      const ev = validateEvent(rawLine, tierOf);
      if (ev.event) events.push(ev.event);
      else errors.push(...ev.errors);
    }

    if (lines.length !== INGEST_LIMITS.FIXTURE_EVENTS || events.length !== lines.length) {
      errors.push({ code: "PARSE_ERROR", path: "eventCount" });
    }
    const seen = new Set<string>();
    for (const e of events) {
      if (seen.has(e.eventId)) errors.push({ code: "PARSE_ERROR", path: "eventId", detail: "digest mismatch" });
      seen.add(e.eventId);
    }
    for (const p of manifest.projects) {
      if (!events.some((e) => e.projectId === p.projectId)) {
        errors.push({ code: "UNKNOWN_PROJECT", path: "projectId" });
      }
    }

    let recomputed = "";
    try {
      recomputed = replayDigest(events);
    } catch {
      errors.push({ code: "PARSE_ERROR", path: "digest", detail: "digest mismatch" });
    }
    if (recomputed !== "" && recomputed !== manifest.digest) {
      errors.push({ code: "PARSE_ERROR", path: "digest", detail: "digest mismatch" });
    }

    if (errors.length > 0) {
      return { ok: false, errors: sortErrors(errors) };
    }
    return { ok: true, value: { manifest, events } };
  } catch {
    return { ok: false, errors: [{ code: "PARSE_ERROR", path: "" }] };
  }
}

export function replaySchedule(events: readonly CapsuleEvent[], speed: number): ScheduledEvent[] {
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 16) return [];
  if (events.length === 0) return [];
  const sorted = [...events].sort((x, y) => {
    if (x.ts !== y.ts) return x.ts - y.ts;
    if (x.projectId !== y.projectId) return x.projectId < y.projectId ? -1 : 1;
    if (x.source !== y.source) return x.source < y.source ? -1 : 1;
    return x.sourceSeq - y.sourceSeq;
  });
  const t0 = sorted[0]?.ts ?? 0;
  return sorted.map((event) => ({ atMs: (event.ts - t0) / speed, event }));
}
