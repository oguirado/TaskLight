import { expect } from "vitest";
import type { HybridParamsShape, ModelFactory, ModelHandle, ModeName, SdkPart } from "../../../src/ai/types";
import { TASK_SCHEMAS, VALID } from "./schemaMock";

export const TASKS = ["status", "summary", "next_action", "screenshot", "digest"] as const;
export type T = (typeof TASKS)[number];
export const MODES: ModeName[] = ["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"];

export const ON = { sentinel: "ON_DEVICE" };
export const CLOUD = { sentinel: "IN_CLOUD" };
const modeObjs = new Map<ModeName, object>(MODES.map((m) => [m, { sentinelMode: m }]));

export interface Reply { text?: string | (() => string); inferenceSource?: unknown; throws?: unknown }
export interface Call { handle: FakeHandle; task: T; req: string | SdkPart[]; seq: number }
export interface FakeHandle extends ModelHandle {
  params: HybridParamsShape; task: T; index: number;
  calls: Array<string | SdkPart[]>; inits: number; initCb: ((p: number) => void) | undefined;
}
export interface Fake extends ModelFactory {
  handles: FakeHandle[]; createdParams: HybridParamsShape[]; calls: Call[];
  modeConstCalls: number; initLog: number[];
  reply: (task: T, params: HybridParamsShape) => Reply;
  initMode: "auto" | "manual"; initRejects: Array<(e: unknown) => void>; initResolves: Array<() => void>;
  initFail: (h: FakeHandle) => boolean;
  last(task: T): FakeHandle; forTask(task: T): FakeHandle[];
}

export const taskOf = (p: HybridParamsShape): T => {
  const t = TASKS.find((k) => TASK_SCHEMAS[k]?.schema === p.inCloudParams.generationConfig.responseSchema);
  if (!t) throw new Error("harness: params.responseSchema is not a TASK_SCHEMAS reference");
  return t;
};
export const modeNameOf = (p: HybridParamsShape): ModeName | undefined =>
  MODES.find((m) => modeObjs.get(m) === p.mode);

export function makeFake(): Fake {
  let seq = 0;
  const f: Fake = {
    handles: [], createdParams: [], calls: [], modeConstCalls: 0, initLog: [],
    initMode: "auto", initRejects: [], initResolves: [], initFail: () => false,
    // default reply: schema-valid text from the source implied by the resolved mode
    reply: (task, p) => ({
      text: VALID[task] ?? "",
      inferenceSource: modeNameOf(p) === "ONLY_IN_CLOUD" || modeNameOf(p) === "PREFER_IN_CLOUD" ? CLOUD : ON,
    }),
    modeConst(m) { f.modeConstCalls++; return modeObjs.get(m); },
    sourceConst: { ON_DEVICE: ON, IN_CLOUD: CLOUD },
    create(params) {
      const task = taskOf(params);
      const h: FakeHandle = {
        params, task, index: f.handles.length, calls: [], inits: 0, initCb: undefined,
        async generateContent(req) {
          h.calls.push(req);
          f.calls.push({ handle: h, task, req, seq: seq++ });
          const r = f.reply(task, params);
          if ("throws" in r) throw r.throws;
          return { response: { text: () => { const t = typeof r.text === "function" ? r.text() : r.text; return t ?? ""; },
            ...("inferenceSource" in r ? { inferenceSource: r.inferenceSource } : {}) } };
        },
        initializeDeviceModel(cb) {
          h.inits++; h.initCb = cb; f.initLog.push(h.index);
          if (f.initMode === "manual") {
            return new Promise<void>((res, rej) => { f.initResolves.push(res); f.initRejects.push(rej); });
          }
          return f.initFail(h) ? Promise.reject(new Error("init failed")) : Promise.resolve();
        },
      };
      f.handles.push(h); f.createdParams.push(params);
      return h;
    },
    last(task) { const l = f.forTask(task); const h = l[l.length - 1]; if (!h) throw new Error("no handle " + task); return h; },
    forTask(task) { return f.handles.filter((h) => h.task === task); },
  };
  return f;
}

export const OK_ORIGIN = "https://hybrid-app.web.app";
export function req<K extends T>(task: K, o: { tier?: "private" | "standard" | "shared"; prompt?: string; image?: { mimeType: string; data: string }; ctx?: { knownProjectIds?: ReadonlySet<string> } } = {}) {
  return {
    task, projectId: "p1", tier: o.tier ?? "standard", prompt: o.prompt ?? "PROMPT-" + task,
    ...(o.image ? { image: o.image } : {}), ...(o.ctx ? { ctx: o.ctx } : {}),
  };
}
export const PNG = { mimeType: "image/png", data: "AAAA" };
export function expectNever<T>(v: T) { expect(v).toBeDefined(); }
