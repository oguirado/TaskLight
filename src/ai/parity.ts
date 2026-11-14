import { TASK_SCHEMAS, validateTaskOutput } from "../schema";
import type { TaskId, ValidateCtx } from "../schema";
import { parseConfig } from "./config";
import type { AiConfig, HybridParamsShape, ModelFactory, ModelHandle, ModeName,
  ParityCase, ParityRow, SdkPart } from "./types";

export type { ParityCase, ParityRow } from "./types";

const TASKS: readonly TaskId[] = ["status", "summary", "next_action", "screenshot", "digest"];
const ALLOWED_MIMES: readonly string[] = ["image/png", "image/jpeg"];

/**
 * B10 image rules, applied before any SDK call: an image on a non-screenshot
 * task, a screenshot without an image, or a disallowed mime is invalid input
 * and counts as a reject without sending bytes anywhere. In particular a
 * misplaced image must never reach a cloud handle through parity.
 */
function hasInvalidImage(c: ParityCase): boolean {
  if (c.task !== "screenshot") return c.image !== undefined;
  if (c.image === undefined) return true;
  return !ALLOWED_MIMES.includes(c.image.mimeType);
}

function buildParams(task: TaskId, mode: ModeName, factory: ModelFactory, cfg: AiConfig): HybridParamsShape {
  const sch = TASK_SCHEMAS[task];
  return {
    mode: factory.modeConst(mode),
    inCloudParams: {
      model: cfg.model_name,
      generationConfig: {
        responseMimeType: sch.mimeType,
        responseSchema: sch.schema,
        maxOutputTokens: cfg.max_output_tokens,
      },
    },
    onDeviceParams: { promptOptions: { responseConstraint: sch.schema } },
  };
}

/**
 * Best-effort inspection of params forwarded to the factory. `ModelHandle` has no
 * public params receipt, so this only observes harnesses that expose `params`.
 * Absence means "no observability", not "constraint absent"; the caller falls back to
 * the locally submitted params. See `ParityRow.constraintPresent` for the verifiable
 * scope (submitted params only, never provider enforcement).
 */
function handleParams(h: ModelHandle): HybridParamsShape | undefined {
  const maybe = (h as unknown as { params?: HybridParamsShape }).params;
  return maybe;
}

async function isReject(c: ParityCase, handle: ModelHandle, factory: ModelFactory, forced: ModeName): Promise<boolean> {
  let snapTask: TaskId;
  let snapPrompt: string;
  let snapImage: { mimeType: string; data: string } | undefined;
  let snapCtx: ValidateCtx | undefined;
  try {
    // Snapshot validated inputs before any await; caller may mutate the case.
    snapTask = c.task;
    snapPrompt = c.prompt;
    if (c.image !== undefined) {
      snapImage = { mimeType: c.image.mimeType, data: c.image.data };
    }
    if (c.ctx !== undefined) {
      const src = (c.ctx as { knownProjectIds?: ReadonlySet<string> | undefined } | undefined);
      if (src?.knownProjectIds !== undefined) {
        snapCtx = { knownProjectIds: new Set<string>(src.knownProjectIds as Iterable<string>) };
      } else {
        snapCtx = {};
      }
    }
  } catch {
    return true;
  }
  const snapCase: ParityCase = {
    task: snapTask,
    prompt: snapPrompt,
    ...(snapImage !== undefined ? { image: snapImage } : {}),
    ...(snapCtx !== undefined ? { ctx: snapCtx } : {}),
  };
  if (hasInvalidImage(snapCase)) return true;
  // Defence in depth: the cloud branch never carries an image payload, even
  // if the validation above is bypassed or changes. Pixels stay on-device.
  const callArg: string | SdkPart[] = forced === "ONLY_IN_CLOUD" ? snapPrompt
    : snapImage !== undefined
      ? [snapPrompt, { inlineData: { data: snapImage.data, mimeType: snapImage.mimeType } }]
      : snapPrompt;
  let result: { response: { text(): string; inferenceSource?: unknown } };
  try {
    result = await handle.generateContent(callArg);
  } catch {
    return true;
  }
  let raw: unknown;
  try {
    const response: unknown = (result as { response?: unknown }).response;
    if (response === undefined || response === null) return true;
    raw = (response as { inferenceSource?: unknown }).inferenceSource;
  } catch {
    return true;
  }
  let source: "ON_DEVICE" | "IN_CLOUD";
  if (raw === factory.sourceConst.ON_DEVICE) source = "ON_DEVICE";
  else if (raw === factory.sourceConst.IN_CLOUD) source = "IN_CLOUD";
  else return true;
  if (forced === "ONLY_ON_DEVICE" && source === "IN_CLOUD") return true;
  let text: string;
  try {
    text = result.response.text();
  } catch {
    return true;
  }
  try {
    const validated = validateTaskOutput(snapTask, text, snapCtx);
    return !validated.ok;
  } catch {
    return true;
  }
}

/**
 * Runs forced ONLY_ON_DEVICE / ONLY_IN_CLOUD parity (B20).
 * Invocation context: callers must run this from a gesture-capable context
 * (e.g. a click/key handler via `initDevice` in the hybrid shell), because
 * every forced ONLY_ON_DEVICE handle is initialised here with
 * `initializeDeviceModel` (B12 semantics). If initialisation fails the
 * promise rejects with that setup error; the failure is never counted as
 * output rejects and never derives a T4 row.
 */
export async function runParity(cases: ParityCase[], factory: ModelFactory,
  cfg?: Partial<AiConfig>): Promise<ParityRow[]> {
  if (cases.length === 0) return [];
  const full = parseConfig((cfg ?? {}) as unknown as Record<string, unknown>).cfg;
  // Snapshot each case before any await. A case whose accessors throw
  // (prompt / image / ctx getters or a throwing set iterator) counts as a
  // reject for its task, mirroring run() B18 -> SDK_ERROR -> reject, never
  // as a whole-run abort. The task is re-read for bucketing so the poisoned
  // case still lands in its own task row.
  type Entry = { snap: ParityCase | undefined; poisoned: boolean; task: TaskId | undefined };
  const entries: Entry[] = [];
  for (const c of cases) {
    try {
      let snapImage: { mimeType: string; data: string } | undefined;
      if (c.image !== undefined) snapImage = { mimeType: c.image.mimeType, data: c.image.data };
      let snapCtx: ValidateCtx | undefined;
      if (c.ctx !== undefined) {
        const src = (c.ctx as { knownProjectIds?: ReadonlySet<string> | undefined } | undefined);
        if (src?.knownProjectIds !== undefined) snapCtx = { knownProjectIds: new Set<string>(src.knownProjectIds as Iterable<string>) };
        else snapCtx = {};
      }
      const task: TaskId = c.task;
      const prompt: string = c.prompt;
      const snap: ParityCase = {
        task,
        prompt,
        ...(snapImage !== undefined ? { image: snapImage } : {}),
        ...(snapCtx !== undefined ? { ctx: snapCtx } : {}),
      };
      entries.push({ snap, poisoned: false, task });
    } catch {
      let poisonedTask: TaskId | undefined;
      try { poisonedTask = (c as { task?: TaskId }).task; } catch { poisonedTask = undefined; }
      entries.push({ snap: undefined, poisoned: true, task: poisonedTask });
    }
  }
  const byTask = new Map<TaskId, Entry[]>();
  for (const e of entries) {
    if (e.task === undefined) continue;
    const list = byTask.get(e.task);
    if (list) list.push(e);
    else byTask.set(e.task, [e]);
  }
  const rows: ParityRow[] = [];
  for (const task of TASKS) {
    const list = byTask.get(task);
    if (!list) continue;
    const onParams = buildParams(task, "ONLY_ON_DEVICE", factory, full);
    const onHandle = factory.create(onParams);
    const onStored = handleParams(onHandle);
    const onConstraint = onStored
      ? onStored.onDeviceParams?.promptOptions?.responseConstraint === TASK_SCHEMAS[task].schema
      : onParams.onDeviceParams.promptOptions.responseConstraint === TASK_SCHEMAS[task].schema;
    // B20: initialise the forced on-device handle before any generateContent;
    // a setup failure rejects with the init error (never counted as rejects).
    await onHandle.initializeDeviceModel();
    let onRejects = 0;
    for (const e of list) {
      if (e.poisoned) { onRejects += 1; continue; }
      // snap is defined for non-poisoned entries
      if (await isReject(e.snap as ParityCase, onHandle, factory, "ONLY_ON_DEVICE")) onRejects += 1;
    }
    const onRate = onRejects / list.length;
    rows.push({
      task, source: "ON_DEVICE", n: list.length, rejects: onRejects,
      rate: onRate, t4: onRate > 0.05, constraintPresent: onConstraint,
    });
    if (task === "screenshot") continue;
    const cloudParams = buildParams(task, "ONLY_IN_CLOUD", factory, full);
    const cloudHandle = factory.create(cloudParams);
    const cloudStored = handleParams(cloudHandle);
    const cloudConstraint = cloudStored
      ? cloudStored.onDeviceParams?.promptOptions?.responseConstraint === TASK_SCHEMAS[task].schema
      : cloudParams.onDeviceParams.promptOptions.responseConstraint === TASK_SCHEMAS[task].schema;
    let cloudRejects = 0;
    for (const e of list) {
      if (e.poisoned) { cloudRejects += 1; continue; }
      if (await isReject(e.snap as ParityCase, cloudHandle, factory, "ONLY_IN_CLOUD")) cloudRejects += 1;
    }
    const cloudRate = cloudRejects / list.length;
    rows.push({
      task, source: "IN_CLOUD", n: list.length, rejects: cloudRejects,
      rate: cloudRate, t4: cloudRate > 0.05, constraintPresent: cloudConstraint,
    });
  }
  return rows;
}
