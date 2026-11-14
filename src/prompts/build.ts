import { ATTENTION, CAPSULE_STATUS, LIMITS, PRIVACY_TIER } from "../schema";
import type { Attention, CapsuleStatus, PrivacyTier, TaskId } from "../schema";
import { DEFAULT_PROMPT_VERSION, PROMPT_LIMITS } from "./limits";
import { PROMPT_PACKS } from "./templates";
import { templateHash } from "./hash";
import { clipHead, clipTail } from "./truncate";
import type {
  Built,
  BuildOpts,
  DegradeCode,
  DigestEntry,
  PrevState,
  PromptEvent,
  PromptInput,
  PromptReject,
} from "./types";

const TASKS: readonly string[] = ["status", "summary", "next_action", "screenshot", "digest"];
const RANK: Record<Attention, number> = { now: 0, high: 1, low: 2, none: 3 };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function inEnum(list: readonly string[], v: unknown): boolean {
  return typeof v === "string" && list.includes(v);
}
function sanitize(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f ? " " : s.charAt(i);
  }
  return out.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}
function sortErrors(errors: PromptReject[]): PromptReject[] {
  return [...errors].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}
function failed(errors: PromptReject[]): Built {
  return { ok: false, errors: sortErrors(errors) };
}

interface PrevDraft {
  status: CapsuleStatus;
  attention: Attention;
  headline?: string;
  summary?: string;
  next_action?: string;
}

export function buildPrompt(input: PromptInput, opts?: BuildOpts): Built {
  try {
    return build(input, opts);
  } catch {
    return failed([{ code: "BAD_INPUT", path: "" }]);
  }
}

function build(input: PromptInput, opts?: BuildOpts): Built {
  const errors: PromptReject[] = [];
  if (opts !== undefined && !isObj(opts)) errors.push({ code: "BAD_INPUT", path: "opts" });

  let budget: number = PROMPT_LIMITS.MAX_PROMPT_CHARS;
  if (opts !== undefined && isObj(opts) && opts.maxChars !== undefined) {
    const m = opts.maxChars;
    if (typeof m !== "number" || !Number.isInteger(m) || m < PROMPT_LIMITS.MIN_PROMPT_CHARS || m > PROMPT_LIMITS.MAX_PROMPT_CHARS) {
      errors.push({ code: "BAD_BUDGET", path: "maxChars" });
    } else {
      budget = m;
    }
  }

  let usedVersion = DEFAULT_PROMPT_VERSION;
  let fallback = false;
  if (opts !== undefined && isObj(opts) && opts.version !== undefined) {
    if (typeof opts.version !== "string") {
      errors.push({ code: "BAD_INPUT", path: "opts.version" });
    } else if (!Object.hasOwn(PROMPT_PACKS, opts.version)) {
      usedVersion = DEFAULT_PROMPT_VERSION;
      fallback = true;
    } else {
      usedVersion = opts.version;
    }
  }
  const pack = Object.hasOwn(PROMPT_PACKS, usedVersion) ? PROMPT_PACKS[usedVersion] : undefined;
  if (pack === undefined) errors.push({ code: "BAD_INPUT", path: "opts.version" });
  // === validation below ===
  return buildValidated(input, usedVersion, fallback, pack, budget, errors);
}

function checkPrevText(value: unknown, path: string, max: number, errors: PromptReject[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > max) errors.push({ code: "BAD_PREV", path });
}

function buildValidated(
  input: PromptInput,
  usedVersion: string,
  fallback: boolean,
  pack: { version: string; templates: Record<TaskId, { header: string; footer: string }> } | undefined,
  budget: number,
  errors: PromptReject[],
): Built {
  if (!isObj(input)) return failed([...errors, { code: "BAD_INPUT", path: "" }]);
  const task = (input as Record<string, unknown>)["task"];
  if (typeof task !== "string" || !TASKS.includes(task)) return failed([...errors, { code: "BAD_INPUT", path: "task" }]);
  if (pack === undefined) return failed(errors);
  const tpl = pack.templates[task as TaskId];
  if (tpl === undefined) return failed([...errors, { code: "BAD_INPUT", path: "task" }]);

  const degraded: DegradeCode[] = [];
  if (fallback) degraded.push("UNKNOWN_VERSION_FALLBACK");
  const thash = templateHash(task as TaskId, usedVersion);
  const finish = (text: string, cloud: boolean, ids: readonly string[], trunc: { droppedEvents: number; clippedChars: number; droppedEntries: number }, deg: DegradeCode[]): Built => ({
    ok: true,
    value: {
      task: task as TaskId, text, chars: text.length, prompt_version: usedVersion, template_hash: thash,
      cloud_eligible: cloud, projectIds: ids, truncation: trunc, degraded: deg,
    },
  });

  if (task === "digest") return digestBuild(input as Record<string, unknown>, tpl, budget, degraded, thash, usedVersion, errors, finish);
  if (task === "screenshot") return shotBuild(input as Record<string, unknown>, tpl, budget, degraded, thash, usedVersion, errors, finish);
  return capsuleBuild(input as Record<string, unknown>, task as TaskId, tpl, budget, degraded, thash, usedVersion, errors, finish);
}

type Finish = (text: string, cloud: boolean, ids: readonly string[], trunc: { droppedEvents: number; clippedChars: number; droppedEntries: number }, deg: DegradeCode[]) => Built;

function capsuleBuild(
  inp: Record<string, unknown>,
  task: TaskId,
  tpl: { header: string; footer: string },
  budget: number,
  degraded: DegradeCode[],
  thash: string,
  usedVersion: string,
  errors: PromptReject[],
  finish: Finish,
): Built {
  const errs = [...errors];
  const projectId = inp["projectId"];
  const tier = inp["tier"];
  if (typeof projectId !== "string" || projectId.length === 0) errs.push({ code: "BAD_INPUT", path: "projectId" });
  if (!inEnum(PRIVACY_TIER as readonly string[], tier)) errs.push({ code: "BAD_INPUT", path: "tier" });
  const prevRaw = inp["prev"];
  let prev: PrevDraft | null = null;
  if (prevRaw === null) {
    prev = null;
  } else if (isObj(prevRaw)) {
    const pr: Record<string, unknown> = prevRaw;
    if (!inEnum(CAPSULE_STATUS as readonly string[], pr["status"])) errs.push({ code: "BAD_PREV", path: "prev.status" });
    if (!inEnum(ATTENTION as readonly string[], pr["attention"])) errs.push({ code: "BAD_PREV", path: "prev.attention" });
    checkPrevText(pr["headline"], "prev.headline", LIMITS.HEADLINE_MAX, errs);
    checkPrevText(pr["summary"], "prev.summary", LIMITS.SUMMARY_MAX, errs);
    checkPrevText(pr["next_action"], "prev.next_action", LIMITS.NEXT_ACTION_MAX, errs);
    if (errs.every((e) => e.path !== "prev.status" && e.path !== "prev.attention")) {
      prev = {
        status: pr["status"] as CapsuleStatus,
        attention: pr["attention"] as Attention,
        ...(typeof pr["headline"] === "string" ? { headline: pr["headline"] } : {}),
        ...(typeof pr["summary"] === "string" ? { summary: pr["summary"] } : {}),
        ...(typeof pr["next_action"] === "string" ? { next_action: pr["next_action"] } : {}),
      };
    }
  } else {
    errs.push({ code: "BAD_INPUT", path: "prev" });
  }
  const deltaRaw = inp["delta"];
  const events: PromptEvent[] = [];
  if (!Array.isArray(deltaRaw)) {
    errs.push({ code: "BAD_INPUT", path: "delta" });
  } else if (deltaRaw.length === 0) {
    errs.push({ code: "EMPTY_DELTA", path: "delta" });
  } else if (deltaRaw.length > PROMPT_LIMITS.MAX_EVENTS_IN) {
    errs.push({ code: "TOO_MANY_EVENTS", path: "delta" });
  } else {
    const seen = new Map<number, number>();
    for (let i = 0; i < deltaRaw.length; i++) {
      const raw: unknown = deltaRaw[i];
      if (!isObj(raw)) { errs.push({ code: "BAD_INPUT", path: `delta[${i}]` }); continue; }
      const seq = raw["seq"];
      const kind = raw["kind"];
      const text = raw["text"];
      let ok = true;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) { errs.push({ code: "BAD_INT", path: `delta[${i}].seq` }); ok = false; }
      if (typeof kind !== "string") { errs.push({ code: "BAD_INPUT", path: `delta[${i}].kind` }); ok = false; }
      if (typeof text !== "string") { errs.push({ code: "BAD_INPUT", path: `delta[${i}].text` }); ok = false; }
      if (ok) {
        const s = seq as number;
        if (seen.has(s)) errs.push({ code: "DUPLICATE_SEQ", path: `delta[${i}].seq` });
        else events.push({ seq: s, kind: kind as string, text: text as string });
        seen.set(s, i);
      }
    }
  }
  if (errs.length > 0) return failed(errs);
  if (typeof projectId !== "string") return failed([{ code: "BAD_INPUT", path: "projectId" }]);

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const prevBlock = prev === null
    ? "PREVIOUS STATE\nnone"
    : ["PREVIOUS STATE", `status: ${prev.status}`, `attention: ${prev.attention}`,
        ...(prev.headline !== undefined ? [`headline: ${sanitize(prev.headline)}`] : []),
        ...(prev.summary !== undefined ? [`summary: ${sanitize(prev.summary)}`] : []),
        ...(prev.next_action !== undefined ? [`next_action: ${sanitize(prev.next_action)}`] : []),
      ].join("\n");
  const identityLine = `prompt_version: ${usedVersion} template_hash: ${thash}`;
  const projectLine = `project: ${sanitize(projectId)}`;
  const emptyLen = [tpl.header, identityLine, projectLine, prevBlock, "<<<EVENTS", "EVENTS>>>", tpl.footer].join("\n").length;
  const reserve = `[${PROMPT_LIMITS.MAX_EVENTS_IN} earlier events omitted]`.length + 1;
  if (emptyLen + reserve > budget) return failed([{ code: "OVER_BUDGET", path: "budget" }]);

  interface Prepared { seq: number; prefix: string; origLen: number; capped: string; line: string }
  const prepared: Prepared[] = sorted.map((e) => {
    const sanText = sanitize(e.text);
    const capped = clipTail(sanText, PROMPT_LIMITS.EVENT_TEXT_MAX);
    const prefix = `[${e.seq}] ${sanitize(e.kind)}: `;
    return { seq: e.seq, prefix, origLen: sanText.length, capped, line: prefix + capped };
  });
  const kept: Prepared[] = [];
  let used = emptyLen;
  for (let i = prepared.length - 1; i >= 0; i--) {
    const p = prepared[i] as Prepared;
    if (used + p.line.length + 1 + reserve <= budget) { kept.unshift(p); used += p.line.length + 1; }
    else break;
  }
  let clippedChars = kept.reduce((a, p) => a + (p.origLen - p.capped.length), 0);
  const lines = kept.map((p) => p.line);
  if (kept.length === 0) {
    const newest = prepared[prepared.length - 1] as Prepared;
    const maxClip = budget - reserve - emptyLen - 1 - newest.prefix.length - 1;
    if (maxClip < 0) return failed([{ code: "OVER_BUDGET", path: "budget" }]);
    const clipped = clipTail(newest.capped, Math.min(newest.capped.length, maxClip));
    lines.push(newest.prefix + "…" + clipped);
    clippedChars = newest.origLen - clipped.length;
  }
  const keptCount = lines.length;
  const dropped = sorted.length - keptCount;
  const parts = [tpl.header, identityLine, projectLine, prevBlock, "<<<EVENTS", ...(dropped > 0 ? [`[${dropped} earlier events omitted]`] : []), ...lines, "EVENTS>>>", tpl.footer];
  const text = parts.join("\n");
  if (text.length > budget) return failed([{ code: "OVER_BUDGET", path: "budget" }]);
  const deg: DegradeCode[] = [...degraded];
  if (clippedChars > 0 || dropped > 0) deg.push("TRUNCATED");
  void task;
  return finish(text, tier !== "private", [projectId], { droppedEvents: dropped, clippedChars, droppedEntries: 0 }, deg);
}

function digestBuild(
  inp: Record<string, unknown>,
  tpl: { header: string; footer: string },
  budget: number,
  degraded: DegradeCode[],
  thash: string,
  usedVersion: string,
  errors: PromptReject[],
  finish: Finish,
): Built {
  const errs = [...errors];
  const entriesRaw = inp["entries"];
  const entries: DigestEntry[] = [];
  if (!Array.isArray(entriesRaw)) {
    errs.push({ code: "BAD_INPUT", path: "entries" });
  } else if (entriesRaw.length === 0) {
    errs.push({ code: "EMPTY_DIGEST", path: "entries" });
  } else if (entriesRaw.length > PROMPT_LIMITS.DIGEST_MAX_ENTRIES_IN) {
    errs.push({ code: "BAD_INPUT", path: "entries" });
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < entriesRaw.length; i++) {
      const raw: unknown = entriesRaw[i];
      if (!isObj(raw)) { errs.push({ code: "BAD_INPUT", path: `entries[${i}]` }); continue; }
      const pid = raw["projectId"];
      const tier = raw["tier"];
      const status = raw["status"];
      const attention = raw["attention"];
      const headline = raw["headline"];
      const nextAction = raw["next_action"];
      let ok = true;
      if (typeof pid !== "string" || pid.length === 0) { errs.push({ code: "BAD_INPUT", path: `entries[${i}].projectId` }); ok = false; }
      if (!inEnum(PRIVACY_TIER as readonly string[], tier)) { errs.push({ code: "BAD_INPUT", path: `entries[${i}].tier` }); ok = false; }
      if (!inEnum(CAPSULE_STATUS as readonly string[], status)) { errs.push({ code: "BAD_INPUT", path: `entries[${i}].status` }); ok = false; }
      if (!inEnum(ATTENTION as readonly string[], attention)) { errs.push({ code: "BAD_INPUT", path: `entries[${i}].attention` }); ok = false; }
      if (headline !== undefined && typeof headline !== "string") { errs.push({ code: "BAD_INPUT", path: `entries[${i}].headline` }); ok = false; }
      if (nextAction !== undefined && typeof nextAction !== "string") { errs.push({ code: "BAD_INPUT", path: `entries[${i}].next_action` }); ok = false; }
      if (tier === "private" && (headline !== undefined || nextAction !== undefined)) {
        errs.push({ code: "PRIVATE_TEXT", path: headline !== undefined ? `entries[${i}].headline` : `entries[${i}].next_action` });
        ok = false;
      }
      if (!ok) continue;
      const id = pid as string;
      if (seen.has(id)) { errs.push({ code: "DUPLICATE_PROJECT", path: `entries[${i}].projectId` }); continue; }
      seen.add(id);
      entries.push({
        projectId: id, tier: tier as PrivacyTier, status: status as CapsuleStatus, attention: attention as Attention,
        ...(typeof headline === "string" ? { headline } : {}),
        ...(typeof nextAction === "string" ? { next_action: nextAction } : {}),
      });
    }
  }
  if (errs.length > 0) return failed(errs);

  const sorted = [...entries].sort((a, b) =>
    RANK[a.attention] - RANK[b.attention] || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
  const identityLine = `prompt_version: ${usedVersion} template_hash: ${thash}`;
  const fixed = [tpl.header, identityLine, "<<<PROJECTS", "PROJECTS>>>", tpl.footer].join("\n").length;
  if (fixed > budget) return failed([{ code: "OVER_BUDGET", path: "budget" }]);
  const kept: DigestEntry[] = [];
  const lines: string[] = [];
  let used = fixed;
  for (const e of sorted) {
    const extra = lineFor(e).length + 1;
    if (used + extra <= budget) { kept.push(e); lines.push(lineFor(e)); used += extra; }
    else break;
  }
  if (kept.length === 0) return failed([{ code: "OVER_BUDGET", path: "budget" }]);
  const text = [tpl.header, identityLine, "<<<PROJECTS", ...lines, "PROJECTS>>>", tpl.footer].join("\n");
  if (text.length > budget) return failed([{ code: "OVER_BUDGET", path: "budget" }]);
  const dropped = sorted.length - kept.length;
  const deg: DegradeCode[] = [...degraded];
  if (dropped > 0) deg.push("TRUNCATED");
  return finish(text, true, kept.map((e) => e.projectId), { droppedEvents: 0, clippedChars: 0, droppedEntries: dropped }, deg);
}

function lineFor(e: DigestEntry): string {
  const parts = [`${sanitize(e.projectId)}`, e.status, e.attention];
  if (e.tier !== "private") {
    if (e.headline !== undefined) parts.push(`headline: ${sanitize(e.headline)}`);
    if (e.next_action !== undefined) parts.push(`next_action: ${sanitize(e.next_action)}`);
  }
  return parts.join(" ");
}

function shotBuild(
  inp: Record<string, unknown>,
  tpl: { header: string; footer: string },
  budget: number,
  degraded: DegradeCode[],
  thash: string,
  usedVersion: string,
  errors: PromptReject[],
  finish: Finish,
): Built {
  const errs = [...errors];
  const projectId = inp["projectId"];
  const tier = inp["tier"];
  if (typeof projectId !== "string" || projectId.length === 0) errs.push({ code: "BAD_INPUT", path: "projectId" });
  if (!inEnum(PRIVACY_TIER as readonly string[], tier)) errs.push({ code: "BAD_INPUT", path: "tier" });
  const prevRaw = inp["prev"];
  let prevStatus: CapsuleStatus | null = null;
  if (prevRaw === null) {
    prevStatus = null;
  } else if (isObj(prevRaw)) {
    const st = prevRaw["status"];
    if (!inEnum(CAPSULE_STATUS as readonly string[], st)) errs.push({ code: "BAD_PREV", path: "prev.status" });
    else prevStatus = st as CapsuleStatus;
  } else {
    errs.push({ code: "BAD_INPUT", path: "prev" });
  }
  const captionRaw = inp["caption"];
  if (captionRaw !== undefined && typeof captionRaw !== "string") errs.push({ code: "BAD_INPUT", path: "caption" });
  if (errs.length > 0) return failed(errs);
  if (typeof projectId !== "string") return failed([{ code: "BAD_INPUT", path: "projectId" }]);
  const prevBlock = prevStatus === null ? "PREVIOUS STATE\nnone" : `PREVIOUS STATE\nstatus: ${prevStatus}`;
  const identityLine = `prompt_version: ${usedVersion} template_hash: ${thash}`;
  const projectLine = `project: ${sanitize(projectId)}`;
  const sanCaption = typeof captionRaw === "string" ? sanitize(captionRaw) : null;
  const caption = sanCaption === null ? null : clipHead(sanCaption, PROMPT_LIMITS.CAPTION_MAX);
  const clippedChars = sanCaption === null || caption === null ? 0 : sanCaption.length - caption.length;
  const parts = [tpl.header, identityLine, projectLine, prevBlock, ...(caption !== null ? [`caption: ${caption}`] : []), tpl.footer];
  const text = parts.join("\n");
  if (text.length > budget) return failed([{ code: "OVER_BUDGET", path: "budget" }]);
  const deg: DegradeCode[] = [...degraded];
  if (clippedChars > 0) deg.push("TRUNCATED");
  return finish(text, false, [projectId], { droppedEvents: 0, clippedChars, droppedEntries: 0 }, deg);
}

