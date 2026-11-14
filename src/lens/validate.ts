import { TASK_SCHEMAS } from "../schema/index";
import { B2_KEYWORDS, LENS_LIMITS } from "./limits";
import { SLOT_ALLOWLIST } from "./slots";
import { lensHash } from "./hash";
import type {
  Lens, LensDescriptor, LensReject, LensRejectCode, LensResult, SlotId,
} from "./types";

const DESCRIPTOR_KEYS = [
  "lens_id", "label", "statuses", "tasks", "task_schemas", "prompt_pack",
  "sources", "kind_groups", "template", "layout", "template_hash",
];

const TASK_IDS: readonly string[] = [
  "status", "summary", "next_action", "screenshot", "digest", "plan",
];

const DEV_SOURCES: readonly string[] = ["agent", "ci", "git"];
const STUDY_SOURCES: readonly string[] = ["tab", "selection", "page", "doc"];

const DEV_KINDS: Readonly<Record<string, readonly string[]>> = {
  agent: ["output", "waiting_input", "error", "exit"],
  ci: ["ci_started", "ci_passed", "ci_failed"],
  git: ["commit", "push"],
};

const STUDY_KINDS: Readonly<Record<string, readonly string[]>> = {
  tab: ["tab_pinned", "tab_focused"],
  selection: ["selection_captured"],
  page: ["page_snapshot"],
  doc: ["doc_added"],
};

const B2_SET: ReadonlySet<string> = new Set<string>(B2_KEYWORDS);

function joinPath(base: string, key: string): string {
  return base === "" ? key : base + "." + key;
}

function sortErrors(errors: LensReject[]): LensReject[] {
  return [...errors].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

/**
 * Portable best-effort Proxy check (review #3 / spec §1).
 *
 * Spec B2 requires a Proxy-backed value to be REMOTE_CODE, but exact
 * detection needs Node's `util.types.isProxy`, which the §1 import
 * direction (`src/lens/` → `src/schema/` only) forbids. There is no
 * pure-JS check that distinguishes an empty-handler proxy from a plain
 * object: every trap forwards to the target, so all observable behaviour
 * is identical (verified: 16 probes agree). This probe therefore catches
 * only proxies whose traps throw or break plain-object invariants; a
 * forwarding proxy of a plain object passes as plain. Exact portable
 * handling awaits the contract amendment review #3 requires (AUSENTE).
 */
function isProxyValue(v: object): boolean {
  try {
    Reflect.ownKeys(v);
    Object.getPrototypeOf(v);
    Object.getOwnPropertyDescriptor(v, "__u25_proxy_probe__");
    return false;
  } catch {
    return true;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  if (isProxyValue(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isRemoteCodeObject(v: object): boolean {
  if (v instanceof RegExp || v instanceof Promise) return true;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto !== Object.prototype && proto !== null;
}

function isNotPlainBuiltin(v: object): boolean {
  return (
    v instanceof Date || v instanceof Map || v instanceof Set ||
    v instanceof WeakMap || v instanceof WeakSet || v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v)
  );
}

function walkPlain(value: unknown, path: string, ancestors: Set<object>, errors: LensReject[]): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push({ code: "NOT_PLAIN", path });
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    errors.push({ code: "REMOTE_CODE", path });
    return;
  }
  const obj = value;
  if (isProxyValue(obj)) {
    errors.push({ code: "REMOTE_CODE", path });
    return;
  }
  if (ancestors.has(obj)) {
    errors.push({ code: "NOT_PLAIN", path });
    return;
  }
  if (Array.isArray(value)) {
    ancestors.add(obj);
    const lenDesc = Object.getOwnPropertyDescriptor(value, "length");
    if (!lenDesc || "get" in lenDesc || "set" in lenDesc || typeof lenDesc.value !== "number") {
      errors.push({ code: "REMOTE_CODE", path: joinPath(path, "length") });
      ancestors.delete(obj);
      return;
    }
    const arrLen = lenDesc.value as number;
    const present = new Set<number>();
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const childPath = typeof key === "string" ? joinPath(path, key) : joinPath(path, String(key));
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) {
        errors.push({ code: "NOT_PLAIN", path: childPath });
        continue;
      }
      const isIndex =
        typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < arrLen;
      if (isIndex) present.add(Number(key));
      if ("get" in desc || "set" in desc) {
        errors.push({ code: "REMOTE_CODE", path: childPath });
        continue;
      }
      if (!isIndex) {
        if (typeof desc.value === "string" && !LENS_LIMITS.IDENT_RE.test(desc.value)) {
          errors.push({ code: "CODE_LIKE", path: childPath });
        } else {
          errors.push({ code: "NOT_PLAIN", path: childPath });
        }
        continue;
      }
      if (desc.enumerable === false) {
        errors.push({ code: "NOT_PLAIN", path: childPath });
        continue;
      }
      walkPlain(desc.value, childPath, ancestors, errors);
    }
    if (present.size < arrLen) {
      if (arrLen <= 10000) {
        for (let i = 0; i < arrLen; i++) {
          if (!present.has(i)) errors.push({ code: "NOT_PLAIN", path: joinPath(path, String(i)) });
        }
      } else {
        errors.push({ code: "NOT_PLAIN", path });
      }
    }
    ancestors.delete(obj);
    return;
  }
  if (isNotPlainBuiltin(obj)) {
    errors.push({ code: "NOT_PLAIN", path });
    return;
  }
  if (isRemoteCodeObject(obj)) {
    errors.push({ code: "REMOTE_CODE", path });
    return;
  }
  ancestors.add(obj);
  for (const key of Reflect.ownKeys(obj)) {
    const childPath = typeof key === "string" ? joinPath(path, key) : joinPath(path, String(key));
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) continue;
    if ("get" in desc || "set" in desc) {
      errors.push({ code: "REMOTE_CODE", path: childPath });
      continue;
    }
    if (typeof key === "symbol" || desc.enumerable === false) {
      errors.push({ code: "NOT_PLAIN", path: childPath });
      continue;
    }
    walkPlain(desc.value, childPath, ancestors, errors);
  }
  ancestors.delete(obj);
}

function cloneDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((x) => cloneDeep(x));
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    const out: Record<string, unknown> = proto === null ? Object.create(null) : {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = cloneDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function freezeDeep(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const v of Object.values(value as Record<string, unknown>)) freezeDeep(v, seen);
  Object.freeze(value);
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  }
  const s = JSON.stringify(v);
  return s === undefined ? "null" : s;
}

function deepEqualCanon(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}

function checkIdent(errors: LensReject[], path: string, v: unknown): void {
  if (typeof v === "string" && !LENS_LIMITS.IDENT_RE.test(v)) {
    errors.push({ code: "CODE_LIKE", path });
  }
}

function walkSchema(node: unknown, base: string, errors: LensReject[]): void {
  if (!isPlainObject(node)) {
    errors.push({ code: "SCHEMA_MISMATCH", path: base });
    return;
  }
  for (const k of Object.keys(node)) {
    if (!B2_SET.has(k)) errors.push({ code: "OFF_B2_KEYWORD", path: joinPath(base, k) });
  }
  if (!Object.hasOwn(node, "nullable") || node["nullable"] !== false) {
    errors.push({ code: "SCHEMA_MISMATCH", path: joinPath(base, "nullable") });
  }
  if (Object.hasOwn(node, "properties")) {
    const props = node["properties"];
    if (!isPlainObject(props)) {
      errors.push({ code: "SCHEMA_MISMATCH", path: joinPath(base, "properties") });
    } else {
      const propKeys = Object.keys(props);
      const req = node["required"];
      const reqOk =
        Array.isArray(req) &&
        req.every((x) => typeof x === "string") &&
        [...(req as string[])].sort().join(" ") === [...propKeys].sort().join(" ");
      if (!reqOk) errors.push({ code: "SCHEMA_MISMATCH", path: joinPath(base, "required") });
      for (const pk of propKeys) {
        walkSchema(props[pk], joinPath(joinPath(base, "properties"), pk), errors);
      }
    }
  }
  if (Object.hasOwn(node, "items")) {
    walkSchema(node["items"], joinPath(base, "items"), errors);
  }
  if (Object.hasOwn(node, "enum")) {
    const en = node["enum"];
    if (!Array.isArray(en) || !en.every((x) => typeof x === "string")) {
      errors.push({ code: "SCHEMA_MISMATCH", path: joinPath(base, "enum") });
    }
  }
}

function checkExactKeys(
  errors: LensReject[], obj: Record<string, unknown>, expected: readonly string[],
  base: string, unknownCode: LensRejectCode, missingCode: LensRejectCode,
): void {
  const expSet = new Set<string>(expected);
  for (const k of Object.keys(obj)) {
    if (!expSet.has(k)) errors.push({ code: unknownCode, path: joinPath(base, k) });
  }
  for (const k of expected) {
    if (!Object.hasOwn(obj, k)) errors.push({ code: missingCode, path: joinPath(base, k) });
  }
}

function getStr(obj: Record<string, unknown>, k: string): string | undefined {
  const v = obj[k];
  return typeof v === "string" ? v : undefined;
}

function getArr(obj: Record<string, unknown>, k: string): unknown[] | undefined {
  const v = obj[k];
  return Array.isArray(v) ? v : undefined;
}

function getObj(obj: Record<string, unknown>, k: string): Record<string, unknown> | undefined {
  const v = obj[k];
  return isPlainObject(v) ? v : undefined;
}

function strArr(v: unknown[] | undefined): string[] | undefined {
  if (!v) return undefined;
  if (!v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

function validateSchemaShapes(
  errors: LensReject[], task: string, entry: Record<string, unknown>,
  statuses: string[] | undefined,
): void {
  const base = "task_schemas." + task;
  if (!isPlainObject(entry)) {
    errors.push({ code: "SCHEMA_MISMATCH", path: base });
    return;
  }
  if (Object.keys(entry).sort().join(" ") !== "mimeType schema") {
    errors.push({ code: "SCHEMA_MISMATCH", path: base });
  }
  const mime = getStr(entry, "mimeType");
  const schema = getObj(entry, "schema");
  if (mime === undefined || schema === undefined) {
    if (Object.hasOwn(entry, "mimeType") && typeof entry["mimeType"] !== "string") {
      errors.push({ code: "WRONG_TYPE", path: base + ".mimeType" });
    }
    if (Object.hasOwn(entry, "schema") && !isPlainObject(entry["schema"])) {
      errors.push({ code: "WRONG_TYPE", path: base + ".schema" });
    }
    return;
  }
  walkSchema(schema, base + ".schema", errors);
  if (task === "status") {
    if (mime !== "text/x.enum") errors.push({ code: "SCHEMA_MISMATCH", path: base + ".mimeType" });
    if (getStr(schema, "type") !== "string") errors.push({ code: "SCHEMA_MISMATCH", path: base + ".schema.type" });
    const en = schema["enum"];
    if (!Array.isArray(en) || !deepEqualCanon(en, statuses ?? [])) {
      errors.push({ code: "SCHEMA_MISMATCH", path: base + ".schema.enum" });
    }
    for (const k of Object.keys(schema)) {
      if (k !== "type" && k !== "enum" && k !== "nullable") {
        if (B2_SET.has(k)) errors.push({ code: "SCHEMA_MISMATCH", path: joinPath(base + ".schema", k) });
      }
    }
  } else if (task === "plan") {
    if (mime !== "application/json") errors.push({ code: "SCHEMA_MISMATCH", path: base + ".mimeType" });
    const expectedPlanSchema: unknown = {
      type: "object",
      nullable: false,
      required: ["steps", "progress"],
      properties: {
        steps: {
          type: "array",
          nullable: false,
          items: {
            type: "object",
            nullable: false,
            required: ["text", "state"],
            properties: {
              text: { type: "string", nullable: false },
              state: { type: "string", enum: ["todo", "doing", "done"], nullable: false },
            },
          },
        },
        progress: { type: "number", nullable: false },
      },
    };
    if (!deepEqualCanon(schema, expectedPlanSchema)) {
      errors.push({ code: "SCHEMA_MISMATCH", path: base + ".schema" });
    }
  } else if (task === "summary" || task === "next_action" || task === "digest" || task === "screenshot") {
    const expected: unknown =
      task === "summary" ? TASK_SCHEMAS.summary :
      task === "next_action" ? TASK_SCHEMAS.next_action :
      task === "digest" ? TASK_SCHEMAS.digest : TASK_SCHEMAS.screenshot;
    if (!deepEqualCanon(entry, expected)) {
      errors.push({ code: "SCHEMA_MISMATCH", path: base });
    }
  }
}

export function isLensStatus(lens: Lens, s: string): boolean {
  return lens.statuses.includes(s);
}

export function kindAllowed(lens: Lens, source: string, kind: string): boolean {
  if (!Object.hasOwn(lens.kind_groups, source)) return false;
  const groups = lens.kind_groups as unknown as Record<string, unknown>;
  const g = groups[source];
  if (!Array.isArray(g)) return false;
  return (g as readonly string[]).includes(kind);
}

export function validateLens(d: unknown): LensResult<Lens> {
  try {
    return validateImpl(d);
  } catch {
    return { ok: false, errors: [{ code: "NOT_PLAIN", path: "" }] };
  }
}

function validateImpl(d: unknown): LensResult<Lens> {
  const errors: LensReject[] = [];
  walkPlain(d, "", new Set<object>(), errors);
  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };
  if (!isPlainObject(d)) return { ok: false, errors: [{ code: "WRONG_TYPE", path: "" }] };
  const root: Record<string, unknown> = d;

  checkExactKeys(errors, root, DESCRIPTOR_KEYS, "", "UNKNOWN_FIELD", "MISSING_FIELD");

  if (Object.hasOwn(root, "lens_id") && typeof root["lens_id"] !== "string") {
    errors.push({ code: "WRONG_TYPE", path: "lens_id" });
  }
  if (Object.hasOwn(root, "label") && typeof root["label"] !== "string") {
    errors.push({ code: "WRONG_TYPE", path: "label" });
  }
  if (Object.hasOwn(root, "statuses") && !Array.isArray(root["statuses"])) {
    errors.push({ code: "WRONG_TYPE", path: "statuses" });
  }
  if (Object.hasOwn(root, "tasks") && !Array.isArray(root["tasks"])) {
    errors.push({ code: "WRONG_TYPE", path: "tasks" });
  }
  if (Object.hasOwn(root, "task_schemas") && !isPlainObject(root["task_schemas"])) {
    errors.push({ code: "WRONG_TYPE", path: "task_schemas" });
  }
  if (Object.hasOwn(root, "prompt_pack") && !isPlainObject(root["prompt_pack"])) {
    errors.push({ code: "WRONG_TYPE", path: "prompt_pack" });
  }
  if (Object.hasOwn(root, "sources") && !Array.isArray(root["sources"])) {
    errors.push({ code: "WRONG_TYPE", path: "sources" });
  }
  if (Object.hasOwn(root, "kind_groups") && !isPlainObject(root["kind_groups"])) {
    errors.push({ code: "WRONG_TYPE", path: "kind_groups" });
  }
  if (Object.hasOwn(root, "template") && !Array.isArray(root["template"])) {
    errors.push({ code: "WRONG_TYPE", path: "template" });
  }
  if (Object.hasOwn(root, "layout") && !isPlainObject(root["layout"])) {
    errors.push({ code: "WRONG_TYPE", path: "layout" });
  }
  if (Object.hasOwn(root, "template_hash") && typeof root["template_hash"] !== "string") {
    errors.push({ code: "WRONG_TYPE", path: "template_hash" });
  }

  const lensId = getStr(root, "lens_id");
  const label = getStr(root, "label");
  const statusesArr = getArr(root, "statuses");
  const statuses = strArr(statusesArr);
  const tasksArr = getArr(root, "tasks");
  const taskSchemas = getObj(root, "task_schemas");
  const promptPack = getObj(root, "prompt_pack");
  const sourcesArr = getArr(root, "sources");
  const kindGroups = getObj(root, "kind_groups");
  const templateArr = getArr(root, "template");
  const layout = getObj(root, "layout");
  const templateHash = getStr(root, "template_hash");

  // B3 label + B5 id
  if (label !== undefined) {
    if (label.length > LENS_LIMITS.LABEL_MAX || label.includes("<") || label.includes(">") || label.includes("://") || label.includes("javascript:")) {
      errors.push({ code: "CODE_LIKE", path: "label" });
    }
  }
  checkIdent(errors, "lens_id", lensId);
  if (lensId !== undefined && !(LENS_LIMITS.LENS_ID_RE.test(lensId) && (lensId === "dev" || lensId === "study"))) {
    errors.push({ code: "BAD_LENS_ID", path: "lens_id" });
  }

  // B6 statuses
  if (statusesArr !== undefined) {
    if (statusesArr.length < LENS_LIMITS.STATUSES_MIN) {
      errors.push({ code: "TOO_FEW_STATUSES", path: "statuses" });
    }
    if (statusesArr.length > LENS_LIMITS.STATUSES_MAX) {
      errors.push({ code: "TOO_MANY_STATUSES", path: "statuses" });
    }
    const seen = new Set<string>();
    statusesArr.forEach((v, i) => {
      const p = "statuses." + i;
      if (typeof v !== "string") {
        errors.push({ code: "BAD_STATUS", path: p });
        return;
      }
      if (!LENS_LIMITS.STATUS_RE.test(v)) errors.push({ code: "BAD_STATUS", path: p });
      if (seen.has(v)) errors.push({ code: "DUPLICATE_STATUS", path: p });
      else seen.add(v);
    });
  }

  // B8 tasks
  const taskSet = new Set<string>();
  if (tasksArr !== undefined) {
    tasksArr.forEach((v, i) => {
      const p = "tasks." + i;
      checkIdent(errors, p, v);
      if (typeof v !== "string" || !TASK_IDS.includes(v)) {
        errors.push({ code: "UNKNOWN_TASK", path: p });
      } else {
        taskSet.add(v);
      }
    });
    if (Array.isArray(tasksArr) && !tasksArr.includes("status")) {
      errors.push({ code: "MISSING_TASK", path: "tasks" });
    }
  }

  // B9/B10 schemas
  if (taskSchemas !== undefined) {
    for (const key of Object.keys(taskSchemas)) {
      const entry = taskSchemas[key] as unknown;
      if (isPlainObject(entry)) {
        validateSchemaShapes(errors, key, entry, statuses);
      } else {
        errors.push({ code: "SCHEMA_MISMATCH", path: "task_schemas." + key });
      }
    }
    if (tasksArr !== undefined) {
      for (const t of taskSet) {
        if (!Object.hasOwn(taskSchemas, t)) {
          errors.push({ code: "SCHEMA_MISMATCH", path: "task_schemas." + t });
        }
      }
      for (const key of Object.keys(taskSchemas)) {
        if (!taskSet.has(key)) {
          errors.push({ code: "SCHEMA_MISMATCH", path: "task_schemas." + key });
        }
      }
    }
  }

  // B11 prompt pack
  if (promptPack !== undefined) {
    checkExactKeys(errors, promptPack, ["id", "version"], "prompt_pack", "UNKNOWN_FIELD", "MISSING_FIELD");
    const pid = getStr(promptPack, "id");
    const ver = getStr(promptPack, "version");
    checkIdent(errors, "prompt_pack.version", ver);
    checkIdent(errors, "prompt_pack.id", pid);
    if (pid !== undefined && lensId !== undefined && pid !== lensId) {
      errors.push({ code: "SCHEMA_MISMATCH", path: "prompt_pack.id" });
    }
    if (ver !== undefined && !LENS_LIMITS.IDENT_RE.test(ver)) {
      errors.push({ code: "CODE_LIKE", path: "prompt_pack.version" });
    }
    if (Object.hasOwn(promptPack, "id") && typeof promptPack["id"] !== "string") {
      errors.push({ code: "WRONG_TYPE", path: "prompt_pack.id" });
    }
    if (Object.hasOwn(promptPack, "version") && typeof promptPack["version"] !== "string") {
      errors.push({ code: "WRONG_TYPE", path: "prompt_pack.version" });
    }
  }

  // B12 sources / kinds
  const allowedSources: readonly string[] | undefined =
    lensId === "dev" ? DEV_SOURCES : lensId === "study" ? STUDY_SOURCES : undefined;
  const sourceSet = new Set<string>();
  if (sourcesArr !== undefined) {
    sourcesArr.forEach((v, i) => {
      const p = "sources." + i;
      checkIdent(errors, p, v);
      if (typeof v !== "string") {
        errors.push({ code: "BAD_SOURCE", path: p });
        return;
      }
      sourceSet.add(v);
      if (allowedSources !== undefined && !allowedSources.includes(v)) {
        errors.push({ code: "BAD_SOURCE", path: p });
      }
    });
  }
  if (kindGroups !== undefined) {
    const expected = lensId === "dev" ? DEV_KINDS : lensId === "study" ? STUDY_KINDS : undefined;
    if (sourcesArr !== undefined) {
      const kKeys = Object.keys(kindGroups);
      const sList = strArr(sourcesArr) ?? sourcesArr.filter((x): x is string => typeof x === "string");
      const equalSets = kKeys.length === sList.length && kKeys.every((k) => (sList as string[]).includes(k));
      if (!equalSets) errors.push({ code: "BAD_KIND_GROUP", path: "kind_groups" });
    }
    for (const k of Object.keys(kindGroups)) {
      checkIdent(errors, "kind_groups." + k, k);
      const g = kindGroups[k] as unknown;
      if (!Array.isArray(g)) {
        errors.push({ code: "BAD_KIND_GROUP", path: "kind_groups." + k });
        continue;
      }
      if (g.length < 1) {
        errors.push({ code: "BAD_KIND_GROUP", path: "kind_groups." + k });
      }
      (g as unknown[]).forEach((v, i) => {
        if (typeof v !== "string") {
          errors.push({ code: "BAD_KIND_GROUP", path: "kind_groups." + k + "." + i });
        } else {
          checkIdent(errors, "kind_groups." + k + "." + i, v as string);
        }
      });
      if (expected !== undefined) {
        const exp = expected[k] as readonly string[] | undefined;
        if (exp === undefined || !deepEqualCanon(g, [...exp])) {
          errors.push({ code: "BAD_KIND_GROUP", path: "kind_groups." + k });
        }
      }
    }
    const seenKind = new Set<string>();
    for (const k of Object.keys(kindGroups)) {
      const g = kindGroups[k] as unknown;
      if (Array.isArray(g)) {
        for (const v of g as unknown[]) {
          if (typeof v === "string") {
            if (seenKind.has(v)) errors.push({ code: "BAD_KIND_GROUP", path: "kind_groups." + k });
            else seenKind.add(v);
          }
        }
      }
    }
  }

  // B13 template
  const seenSlots = new Set<string>();
  let hasChecklist = false;
  let hasFocusSlot = false;
  if (templateArr !== undefined) {
    (templateArr as unknown[]).forEach((b, i) => {
      const p = "template." + i;
      if (!isPlainObject(b)) {
        errors.push({ code: "BAD_TEMPLATE", path: p });
        return;
      }
      const bobj = b as Record<string, unknown>;
      if (Object.keys(bobj).sort().join(" ") !== "field slot write") {
        errors.push({ code: "BAD_TEMPLATE", path: p });
      }
      const slot = getStr(bobj, "slot");
      const field = getStr(bobj, "field");
      const write = getStr(bobj, "write");
      checkIdent(errors, p + ".slot", slot);
      checkIdent(errors, p + ".field", field);
      if (typeof write === "string" && !/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(write)) {
        errors.push({ code: "CODE_LIKE", path: p + ".write" });
      }
      if (slot === undefined || !Object.hasOwn(SLOT_ALLOWLIST, slot)) {
        errors.push({ code: "BAD_TEMPLATE", path: p + ".slot" });
      } else {
        const allow = SLOT_ALLOWLIST[slot as SlotId];
        if (field !== allow.field) errors.push({ code: "BAD_TEMPLATE", path: p + ".field" });
        if (write === undefined || !(allow.writes as readonly string[]).includes(write)) {
          errors.push({ code: "BAD_TEMPLATE", path: p + ".write" });
        }
        if (seenSlots.has(slot)) errors.push({ code: "BAD_TEMPLATE", path: p + ".slot" });
        else seenSlots.add(slot);
        if (slot === "checklist") hasChecklist = true;
        if (slot === "focus_banner") hasFocusSlot = true;
      }
    });
    if (hasChecklist && tasksArr !== undefined && !tasksArr.includes("plan")) {
      errors.push({ code: "BAD_TEMPLATE", path: "template" });
    }
  }

  // B14 layout
  if (layout !== undefined) {
    checkExactKeys(errors, layout, ["step_rows", "focus_banner", "order"], "layout", "UNKNOWN_FIELD", "MISSING_FIELD");
    const stepRows = layout["step_rows"];
    if (Object.hasOwn(layout, "step_rows") && typeof stepRows !== "number") {
      errors.push({ code: "WRONG_TYPE", path: "layout.step_rows" });
    } else if (Object.hasOwn(layout, "step_rows")) {
      const expectedRows = hasChecklist ? 5 : 0;
      if (stepRows !== expectedRows) errors.push({ code: "BAD_LAYOUT", path: "layout.step_rows" });
    }
    const focusFlag = layout["focus_banner"];
    if (Object.hasOwn(layout, "focus_banner") && typeof focusFlag !== "boolean") {
      errors.push({ code: "WRONG_TYPE", path: "layout.focus_banner" });
    } else if (Object.hasOwn(layout, "focus_banner") && focusFlag !== hasFocusSlot) {
      errors.push({ code: "BAD_LAYOUT", path: "layout.focus_banner" });
    }
    const order = layout["order"];
    if (Object.hasOwn(layout, "order") && typeof order !== "string") {
      errors.push({ code: "WRONG_TYPE", path: "layout.order" });
    } else if (Object.hasOwn(layout, "order") && order !== "attention_then_project") {
      errors.push({ code: "BAD_LAYOUT", path: "layout.order" });
    }
    checkIdent(errors, "layout.order", typeof order === "string" ? order : undefined);
  }

  // B15 hash
  if (templateHash !== undefined) {
    if (!/^[0-9a-f]{8}$/.test(templateHash)) {
      errors.push({ code: "HASH_MISMATCH", path: "template_hash" });
    } else {
      const rest: Record<string, unknown> = {};
      for (const k of Object.keys(root)) {
        if (k !== "template_hash") rest[k] = root[k];
      }
      let computed = "";
      try {
        computed = lensHash((rest as unknown) as Omit<LensDescriptor, "template_hash">);
      } catch {
        computed = "";
      }
      if (computed !== templateHash) errors.push({ code: "HASH_MISMATCH", path: "template_hash" });
    }
  }

  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };
  const copy = cloneDeep(root);
  freezeDeep(copy, new Set<object>());
  return { ok: true, value: copy as Lens };
}





