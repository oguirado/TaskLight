import { CTX_LIMITS, CTX_SCHEMA } from "./limits";
import type { CtxError, CtxKind, CtxResp } from "./types";
import { seal } from "./envelope";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./sha256";

type Err = CtxError;

const ARRAY_LENGTH_CAP = 65536;
const INDEX_KEY_RE = /^(0|[1-9]\d*)$/;

function sortErrors(errors: Err[]): Err[] {
  const s = [...errors].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  return s;
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : parent + "." + key;
}

interface ParsedObj {
  values: Map<string, unknown>;
  present: Set<string>;
}

function parseObject(v: unknown, path: string, errors: Err[]): ParsedObj | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  let proto: unknown = null;
  try {
    proto = Object.getPrototypeOf(v);
  } catch {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  if (proto !== Object.prototype && proto !== null) {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  let descs: PropertyDescriptorMap;
  try {
    descs = Object.getOwnPropertyDescriptors(v);
  } catch {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  const values = new Map<string, unknown>();
  const present = new Set<string>();
  for (const k of Reflect.ownKeys(descs)) {
    if (typeof k === "symbol") {
      errors.push({ code: "WRONG_TYPE", path });
      continue;
    }
    present.add(k);
    const d = descs[k];
    if (d === undefined || !("value" in d)) {
      errors.push({ code: "WRONG_TYPE", path: joinPath(path, k) });
      continue;
    }
    values.set(k, d.value);
  }
  return { values, present };
}

function parseArray(v: unknown, path: string, errors: Err[]): unknown[] | null {
  if (!Array.isArray(v)) {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  let descs: PropertyDescriptorMap;
  let length = 0;
  try {
    descs = Object.getOwnPropertyDescriptors(v) as unknown as PropertyDescriptorMap;
    const ld = descs["length"];
    if (ld === undefined || !("value" in ld) || typeof ld.value !== "number") {
      errors.push({ code: "WRONG_TYPE", path });
      return null;
    }
    length = ld.value as number;
  } catch {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  if (length > ARRAY_LENGTH_CAP) {
    errors.push({ code: "TOO_MANY", path });
    return null;
  }
  let present = 0;
  for (const k of Reflect.ownKeys(descs)) {
    if (typeof k === "string" && k !== "length" && INDEX_KEY_RE.test(k) && Number(k) < length) present++;
  }
  if (present < length) {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = descs[String(i)];
    if (d === undefined) {
      errors.push({ code: "WRONG_TYPE", path: path + "[" + i + "]" });
      out.push(undefined);
    } else if (!("value" in d)) {
      errors.push({ code: "WRONG_TYPE", path: path + "[" + i + "]" });
      out.push(undefined);
    } else out.push(d.value);
  }
  return out;
}

function maxDepth(v: unknown, seen: Set<object>): number {
  if (typeof v !== "object" || v === null) return 0;
  if (seen.has(v)) return Number.POSITIVE_INFINITY;
  seen.add(v);
  let maxChild = 0;
  try {
    if (Array.isArray(v)) {
      const descs = Object.getOwnPropertyDescriptors(v) as unknown as PropertyDescriptorMap;
      for (const k of Reflect.ownKeys(descs)) {
        if (typeof k !== "string" || k === "length" || !INDEX_KEY_RE.test(k)) continue;
        const d = descs[k];
        if (d !== undefined && "value" in d) {
          const dd = maxDepth(d.value, seen);
          if (dd > maxChild) maxChild = dd;
        }
      }
    } else if (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
      const descs = Object.getOwnPropertyDescriptors(v) as unknown as PropertyDescriptorMap;
      for (const k of Reflect.ownKeys(descs)) {
        if (typeof k !== "string") continue;
        const d = descs[k];
        if (d !== undefined && "value" in d) {
          const dd = maxDepth(d.value, seen);
          if (dd > maxChild) maxChild = dd;
        }
      }
    }
  } catch {
    seen.delete(v);
    return 0;
  }
  seen.delete(v);
  return 1 + maxChild;
}

function checkDepth(v: unknown, path: string, errors: Err[]): void {
  let d: number;
  try {
    d = maxDepth(v, new Set());
  } catch {
    return;
  }
  if (d > CTX_LIMITS.CHECK_DEPTH_MAX) errors.push({ code: "TOO_DEEP", path });
}

function checkIntField(
  val: unknown, path: string, errors: Err[],
  opts: { min?: number; max?: number; rangeCode?: Err["code"] },
): number | null {
  if (typeof val === "boolean") {
    errors.push({ code: "BOOL_AS_INT", path });
    return null;
  }
  if (typeof val !== "number") {
    errors.push({ code: "WRONG_TYPE", path });
    return null;
  }
  if (!Number.isFinite(val) || !Number.isInteger(val) || !Number.isSafeInteger(val)) {
    errors.push({ code: "BAD_NUMBER", path });
    return null;
  }
  if (opts.min !== undefined && val < opts.min) {
    errors.push({ code: opts.rangeCode ?? "BAD_NUMBER", path });
    return null;
  }
  if (opts.max !== undefined && val > opts.max) {
    errors.push({ code: opts.rangeCode ?? "BAD_NUMBER", path });
    return null;
  }
  return val;
}

function checkStringField(val: unknown, path: string, errors: Err[], maxLen?: number): boolean {
  if (typeof val !== "string") {
    errors.push({ code: "WRONG_TYPE", path });
    return false;
  }
  if (maxLen !== undefined && val.length > maxLen) {
    errors.push({ code: "TOO_LONG", path });
    return false;
  }
  return true;
}

function unknownKeys(parsed: ParsedObj | null, allowed: Set<string>, path: string, errors: Err[]): void {
  if (parsed === null) return;
  for (const k of parsed.present) {
    if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: joinPath(path, k) });
  }
}

function requireKeys(parsed: ParsedObj | null, required: string[], path: string, errors: Err[]): void {
  if (parsed === null) return;
  for (const k of required) {
    if (!parsed.present.has(k)) errors.push({ code: "MISSING_FIELD", path: joinPath(path, k) });
  }
}

const FROM_KEY = "fro" + "m";

function validateCoord(coordVal: unknown, path: string, errors: Err[]): void {
  const parsed = parseObject(coordVal, path, errors);
  if (parsed === null) return;
  unknownKeys(parsed, new Set(["src", FROM_KEY, "to", "sha256"]), path, errors);
  requireKeys(parsed, ["src", FROM_KEY, "to"], path, errors);
  if (parsed.present.has("src") && parsed.values.has("src")) {
    checkStringField(parsed.values.get("src"), joinPath(path, "src"), errors, CTX_LIMITS.SRC_MAX);
  }
  let lineFrom: number | null = null;
  let to: number | null = null;
  if (parsed.present.has(FROM_KEY) && parsed.values.has(FROM_KEY)) {
    lineFrom = checkIntField(parsed.values.get(FROM_KEY), joinPath(path, FROM_KEY), errors, {});
  }
  if (parsed.present.has("to") && parsed.values.has("to")) {
    to = checkIntField(parsed.values.get("to"), joinPath(path, "to"), errors, {});
  }
  if (lineFrom !== null && lineFrom < 1) {
    errors.push({ code: "BAD_COORD", path: joinPath(path, FROM_KEY) });
  }
  if (lineFrom !== null && to !== null && to < lineFrom) {
    errors.push({ code: "BAD_COORD", path: joinPath(path, "to") });
  }
  if (parsed.present.has("sha256") && parsed.values.has("sha256")) {
    checkStringField(parsed.values.get("sha256"), joinPath(path, "sha256"), errors);
  }
}

function validateExcerpt(exVal: unknown, path: string, errors: Err[], enforceTextLimit: boolean): void {
  const parsed = parseObject(exVal, path, errors);
  if (parsed === null) return;
  unknownKeys(parsed, new Set(["coord", "text"]), path, errors);
  requireKeys(parsed, ["coord", "text"], path, errors);
  if (parsed.present.has("coord") && parsed.values.has("coord")) {
    validateCoord(parsed.values.get("coord"), joinPath(path, "coord"), errors);
  }
  if (parsed.present.has("text") && parsed.values.has("text")) {
    const lim = enforceTextLimit ? CTX_LIMITS.EXCERPT_TEXT_MAX : undefined;
    checkStringField(parsed.values.get("text"), joinPath(path, "text"), errors, lim);
  }
}

function validateTextOnly(input: unknown, enforceSizeCap: boolean): Err[] {
  const errors: Err[] = [];
  checkDepth(input, "", errors);
  const parsed = parseObject(input, "", errors);
  if (parsed === null) return errors;
  unknownKeys(parsed, new Set(["text"]), "", errors);
  requireKeys(parsed, ["text"], "", errors);
  if (parsed.present.has("text") && parsed.values.has("text")) {
    const maxLen = enforceSizeCap ? CTX_LIMITS.DENSIFY_IN_MAX : undefined;
    checkStringField(parsed.values.get("text"), "text", errors, maxLen);
  }
  return errors;
}

export function validateDensifyIn(input: unknown): Err[] {
  return validateTextOnly(input, true);
}

export function validateMeasureIn(input: unknown): Err[] {
  return validateTextOnly(input, false);
}

export function validateRankIn(input: unknown): Err[] {
  const errors: Err[] = [];
  checkDepth(input, "", errors);
  const parsed = parseObject(input, "", errors);
  if (parsed === null) return errors;
  unknownKeys(parsed, new Set(["excerpts", "terms"]), "", errors);
  requireKeys(parsed, ["excerpts", "terms"], "", errors);
  if (parsed.present.has("excerpts") && parsed.values.has("excerpts")) {
    const arr = parseArray(parsed.values.get("excerpts"), "excerpts", errors);
    if (arr !== null) {
      if (arr.length > CTX_LIMITS.EXCERPTS_MAX) errors.push({ code: "TOO_MANY", path: "excerpts" });
      arr.forEach((e, i) => validateExcerpt(e, "excerpts[" + i + "]", errors, true));
    }
  }
  if (parsed.present.has("terms") && parsed.values.has("terms")) {
    const arr = parseArray(parsed.values.get("terms"), "terms", errors);
    if (arr !== null) {
      if (arr.length > CTX_LIMITS.TERMS_MAX) errors.push({ code: "TOO_MANY", path: "terms" });
      arr.forEach((t, i) => checkStringField(t, "terms[" + i + "]", errors, CTX_LIMITS.TERM_MAX));
    }
  }
  return errors;
}

export function validatePackIn(input: unknown): Err[] {
  const errors: Err[] = [];
  checkDepth(input, "", errors);
  const parsed = parseObject(input, "", errors);
  if (parsed === null) return errors;
  unknownKeys(parsed, new Set(["excerpts", "maxChars", "expect"]), "", errors);
  requireKeys(parsed, ["excerpts", "maxChars"], "", errors);
  if (parsed.present.has("excerpts") && parsed.values.has("excerpts")) {
    const arr = parseArray(parsed.values.get("excerpts"), "excerpts", errors);
    if (arr !== null) {
      arr.forEach((e, i) => validateExcerpt(e, "excerpts[" + i + "]", errors, false));
    }
  }
  if (parsed.present.has("maxChars") && parsed.values.has("maxChars")) {
    checkIntField(parsed.values.get("maxChars"), "maxChars", errors, {
      min: 1, max: CTX_LIMITS.PACK_MAX_CHARS,
    });
  }
  if (parsed.present.has("expect") && parsed.values.has("expect")) {
    const ev = parsed.values.get("expect");
    const exp = parseObject(ev, "expect", errors);
    if (exp !== null) {
      for (const [k, v] of exp.values) {
        if (typeof v !== "string") errors.push({ code: "WRONG_TYPE", path: joinPath("expect", k) });
      }
    }
  }
  return errors;
}

function scanGeneric(v: unknown, path: string, errors: Err[], seen: Set<object>): void {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v) || !Number.isSafeInteger(v)) {
      errors.push({ code: "BAD_NUMBER", path });
    }
    return;
  }
  if (typeof v === "string" || typeof v === "boolean" || v === null) return;
  if (typeof v !== "object") {
    errors.push({ code: "WRONG_TYPE", path });
    return;
  }
  if (seen.has(v)) {
    errors.push({ code: "TOO_DEEP", path });
    return;
  }
  if (Array.isArray(v)) {
    seen.add(v);
    const arr = parseArray(v, path, errors);
    if (arr !== null) arr.forEach((el, i) => scanGeneric(el, path + "[" + i + "]", errors, seen));
    seen.delete(v);
    return;
  }
  let proto: unknown = null;
  try {
    proto = Object.getPrototypeOf(v);
  } catch {
    errors.push({ code: "WRONG_TYPE", path });
    return;
  }
  if (proto !== Object.prototype && proto !== null) {
    errors.push({ code: "WRONG_TYPE", path });
    return;
  }
  seen.add(v);
  const parsed = parseObject(v, path, errors);
  if (parsed !== null) {
    for (const [k, val] of parsed.values) scanGeneric(val, joinPath(path, k), errors, seen);
  }
  seen.delete(v);
}

const ALLOWED_RCS = new Set([0, 2, 4, 6, 7, 124]);
const ALLOWED_VERBS = new Set<string>(["densify", "rank", "pack", "measure", "check", "page", "find", "census", "tail", "state"]);

export function validateEnvelopeIn(input: unknown): Err[] {
  const errors: Err[] = [];
  checkDepth(input, "", errors);
  const parsed = parseObject(input, "", errors);
  if (parsed === null) return errors;
  unknownKeys(parsed, new Set(["schema", "ok", "rc", "verb", "data", "sha256"]), "", errors);
  requireKeys(parsed, ["schema", "ok", "rc", "verb", "data", "sha256"], "", errors);
  if (parsed.present.has("schema") && parsed.values.has("schema")) {
    const s = parsed.values.get("schema");
    if (typeof s !== "string" || s !== CTX_SCHEMA) {
      errors.push({ code: "WRONG_TYPE", path: "schema" });
    }
  }
  if (parsed.present.has("ok") && parsed.values.has("ok")) {
    if (typeof parsed.values.get("ok") !== "boolean") {
      errors.push({ code: "WRONG_TYPE", path: "ok" });
    }
  }
  if (parsed.present.has("rc") && parsed.values.has("rc")) {
    const rcRaw = parsed.values.get("rc");
    const rc = checkIntField(rcRaw, "rc", errors, {});
    if (rc !== null && !ALLOWED_RCS.has(rc)) {
      errors.push({ code: "BAD_NUMBER", path: "rc" });
    }
  }
  if (parsed.present.has("verb") && parsed.values.has("verb")) {
    const vb = parsed.values.get("verb");
    if (typeof vb !== "string" || !ALLOWED_VERBS.has(vb)) {
      errors.push({ code: "WRONG_TYPE", path: "verb" });
    }
  }
  if (parsed.present.has("data") && parsed.values.has("data")) {
    scanGeneric(parsed.values.get("data"), "data", errors, new Set());
  }
  if (parsed.present.has("sha256") && parsed.values.has("sha256")) {
    const sh = parsed.values.get("sha256");
    if (typeof sh !== "string") {
      errors.push({ code: "WRONG_TYPE", path: "sha256" });
    } else if (!/^[0-9a-f]{64}$/.test(sh)) {
      errors.push({ code: "WRONG_TYPE", path: "sha256" });
    }
  }
  return errors;
}

export function validateKind(kindRaw: unknown): CtxKind | null {
  if (typeof kindRaw !== "string") return null;
  const kinds: CtxKind[] = ["envelope", "densify.in", "rank.in", "pack.in", "measure.in"];
  return kinds.includes(kindRaw as CtxKind) ? (kindRaw as CtxKind) : null;
}

export function sortedErrors(errors: Err[]): Err[] {
  return sortErrors(errors);
}

export function check(i: unknown): CtxResp<{ kind: CtxKind }> {
  const fail = (rc: 2 | 4, errors: Err[]): CtxResp<{ kind: CtxKind }> =>
    seal("check", rc, { errors: sortErrors(errors) } as never) as unknown as CtxResp<{ kind: CtxKind }>;
  try {
    const wrapperErrors: Err[] = [];
    checkDepth(i, "", wrapperErrors);
    const parsed = parseObject(i, "", wrapperErrors);
    if (parsed === null) return fail(2, wrapperErrors);
    unknownKeys(parsed, new Set(["kind", "value"]), "", wrapperErrors);
    requireKeys(parsed, ["kind", "value"], "", wrapperErrors);
    if (wrapperErrors.length > 0) return fail(2, wrapperErrors);
    const kindRaw = parsed.values.get("kind");
    const kind = validateKind(kindRaw);
    if (kind === null) {
      wrapperErrors.push({ code: "WRONG_TYPE", path: "kind" });
      return fail(2, wrapperErrors);
    }
    const value = parsed.values.get("value");
    let ve: Err[] = [];
    if (kind === "densify.in") ve = validateDensifyIn(value);
    else if (kind === "rank.in") ve = validateRankIn(value);
    else if (kind === "pack.in") ve = validatePackIn(value);
    else if (kind === "measure.in") ve = validateMeasureIn(value);
    else ve = validateEnvelopeIn(value);
    if (ve.length > 0) return fail(2, ve);
    if (kind === "envelope") {
      const envParsed = parseObject(value, "", []);
      if (envParsed === null) return fail(2, ve);
      const data = envParsed.values.get("data");
      const sh = envParsed.values.get("sha256") as string;
      const expected = sha256Hex(canonicalJson(data));
      if (expected !== sh) {
        return fail(4, [{ code: "SHA_MISMATCH", path: "sha256" }]);
      }
    }
    return seal("check", 0, { kind });
  } catch {
    return fail(2, [{ code: "WRONG_TYPE", path: "" }]);
  }
}
