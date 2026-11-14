import { canonicalJson } from "./canonical";
import { digestHex } from "./digest";
import { INGEST_LIMITS } from "./limits";
import { PRIVACY_TIER } from "../schema";
import { hasRedactResidue, redact } from "./redact";
import { EVENT_KIND, EVENT_SOURCE } from "./types";
import type {
  CapsuleEvent, EventKind, EventSource, Ingested, IngestReject,
  IngestRejectCode, ProjectRegistry, RedactResult,
} from "./types";

export interface NormaliseOptions { redactFn?: (text: string) => RedactResult }

const EXPECTED_KEYS = ["source", "projectId", "sourceSeq", "ts", "kind", "text"] as const;

/** B8: error paths never echo arbitrary input property names; only safe identifiers pass through. */
export function safeErrorPath(key: string): string {
  const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.length < 32 && !hasRedactResidue(key);
  return safe ? key : "unknown";
}

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

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x0a && code !== 0x09) return true;
  }
  return false;
}

function truncateText(s: string): { text: string; truncated: boolean } {
  const max = INGEST_LIMITS.EVENT_TEXT_MAX;
  if (s.length <= max) return { text: s, truncated: false };
  let cut = max - 1;
  const spans: Array<{ start: number; end: number }> = [];
  const markerRe = /\[REDACTED:[A-Z_]+\]/g;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(s)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  let changed = true;
  while (changed) {
    changed = false;
    if (cut > 0) {
      const code = s.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cut -= 1;
        changed = true;
      }
    }
    for (const span of spans) {
      if (span.start < cut && cut < span.end) {
        cut = span.start;
        changed = true;
      }
    }
  }
  return { text: s.slice(0, cut) + "…", truncated: true };
}

export function normalise(raw: string, reg: ProjectRegistry, opts?: NormaliseOptions): Ingested<CapsuleEvent> {
  try {
    if (typeof raw !== "string") {
      return { ok: false, errors: [{ code: "PARSE_ERROR", path: "" }] };
    }
    if (raw.length > INGEST_LIMITS.RAW_ENVELOPE_MAX) {
      return { ok: false, errors: [{ code: "TOO_LARGE_RAW", path: "" }] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, errors: [{ code: "PARSE_ERROR", path: "" }] };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, errors: [{ code: "NOT_OBJECT", path: "" }] };
    }
    const obj = parsed as Record<string, unknown>;
    const errors: Array<{ code: IngestRejectCode; path: string }> = [];

    for (const key of Object.keys(obj)) {
      if (!(EXPECTED_KEYS as readonly string[]).includes(key)) {
        errors.push({ code: "UNKNOWN_FIELD", path: safeErrorPath(key) });
      }
    }
    for (const key of EXPECTED_KEYS) {
      if (!Object.hasOwn(obj, key)) {
        errors.push({ code: "MISSING_FIELD", path: key });
      }
    }

    let sourceStr: string | undefined;
    let projectIdStr: string | undefined;
    let kindStr: string | undefined;
    let textStr: string | undefined;
    let tsNum: number | undefined;
    let seqNum: number | undefined;

    if (Object.hasOwn(obj, "source")) {
      const v = obj["source"];
      if (typeof v !== "string") errors.push({ code: "WRONG_TYPE", path: "source" });
      else sourceStr = v;
    }
    if (Object.hasOwn(obj, "projectId")) {
      const v = obj["projectId"];
      if (typeof v !== "string") errors.push({ code: "WRONG_TYPE", path: "projectId" });
      else projectIdStr = v;
    }
    if (Object.hasOwn(obj, "kind")) {
      const v = obj["kind"];
      if (typeof v !== "string") errors.push({ code: "WRONG_TYPE", path: "kind" });
      else kindStr = v;
    }
    if (Object.hasOwn(obj, "text")) {
      const v = obj["text"];
      if (typeof v !== "string") errors.push({ code: "WRONG_TYPE", path: "text" });
      else textStr = v;
    }
    if (Object.hasOwn(obj, "ts")) {
      const v = obj["ts"];
      if (typeof v !== "number") errors.push({ code: "WRONG_TYPE", path: "ts" });
      else tsNum = v;
    }
    if (Object.hasOwn(obj, "sourceSeq")) {
      const v = obj["sourceSeq"];
      if (typeof v !== "number") errors.push({ code: "WRONG_TYPE", path: "sourceSeq" });
      else seqNum = v;
    }

    const sourceValid = sourceStr !== undefined && (EVENT_SOURCE as readonly string[]).includes(sourceStr);

    if (sourceStr !== undefined && !sourceValid) {
      errors.push({ code: "BAD_SOURCE", path: "source" });
    }
    if (kindStr !== undefined) {
      const kindKnown = (EVENT_KIND as readonly string[]).includes(kindStr);
      if (!kindKnown) {
        errors.push({ code: "BAD_KIND", path: "kind" });
      } else if (sourceValid) {
        const group = KIND_GROUP[sourceStr as EventSource];
        if (!group.includes(kindStr)) {
          errors.push({ code: "BAD_KIND", path: "kind" });
        }
      }
    }

    let tier: import("./types").CapsuleEvent["tier"] | undefined;
    if (projectIdStr !== undefined) {
      if (!INGEST_LIMITS.PROJECT_ID_RE.test(projectIdStr)) {
        errors.push({ code: "BAD_PROJECT_ID", path: "projectId" });
      } else {
        let found: unknown;
        try {
          found = reg.tierOf(projectIdStr);
        } catch {
          found = undefined;
        }
        if (found === undefined || !(PRIVACY_TIER as readonly unknown[]).includes(found)) {
          errors.push({ code: "UNKNOWN_PROJECT", path: "projectId" });
        } else {
          tier = found as typeof tier;
        }
      }
    }

    if (tsNum !== undefined) {
      if (!Number.isSafeInteger(tsNum) || tsNum < 0) {
        errors.push({ code: "BAD_INT", path: "ts" });
      }
    }
    if (seqNum !== undefined) {
      if (!Number.isSafeInteger(seqNum) || seqNum < 0) {
        errors.push({ code: "BAD_INT", path: "sourceSeq" });
      }
    }

    if (
      sourceValid && sourceStr !== undefined &&
      seqNum !== undefined && Number.isSafeInteger(seqNum) && seqNum >= 0 &&
      projectIdStr !== undefined && tier !== undefined
    ) {
      let last: number | undefined;
      let seqKnown = true;
      try {
        last = reg.lastSeq(projectIdStr, sourceStr as EventSource);
      } catch {
        seqKnown = false;
      }
      if (!seqKnown || (last !== undefined && seqNum <= last)) {
        errors.push({ code: "SEQ_REGRESSION", path: "sourceSeq" });
      }
    }

    if (textStr !== undefined && hasControlChar(textStr)) {
      errors.push({ code: "CONTROL_CHAR", path: "text" });
    }

    if (errors.length > 0) {
      return { ok: false, errors: sortErrors(errors) };
    }

    // Shape is valid; every field is present with the right type and value.
    const source = sourceStr as EventSource;
    const kind = kindStr as EventKind;
    const projectId = projectIdStr as string;
    const sourceSeq = (seqNum as number) === 0 ? 0 : (seqNum as number);
    const ts = (tsNum as number) === 0 ? 0 : (tsNum as number);
    const text = textStr as string;
    const eventTier = tier as import("./types").CapsuleEvent["tier"];

    const fn = opts?.redactFn ?? redact;
    let redacted: RedactResult;
    try {
      redacted = fn(text);
    } catch {
      return { ok: false, errors: [{ code: "REDACT_RESIDUE", path: "text" }] };
    }
    if (hasRedactResidue(redacted.text)) {
      return { ok: false, errors: [{ code: "REDACT_RESIDUE", path: "text" }] };
    }

    const capped = truncateText(redacted.text);
    const residueText = capped.text.endsWith("…") ? capped.text.slice(0, -1) : capped.text;
    if (hasRedactResidue(residueText)) {
      return { ok: false, errors: [{ code: "REDACT_RESIDUE", path: "text" }] };
    }
    const base: Omit<CapsuleEvent, "eventId"> = {
      projectId,
      source,
      kind,
      sourceSeq,
      ts,
      text: capped.text,
      redactions: redacted.redactions,
      truncated: capped.truncated,
      tier: eventTier,
    };
    const eventId = digestHex(canonicalJson(base));
    return { ok: true, value: { ...base, eventId } };
  } catch {
    return { ok: false, errors: [{ code: "PARSE_ERROR", path: "" }] };
  }
}
