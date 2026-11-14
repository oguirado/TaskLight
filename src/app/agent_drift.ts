// U37b: drift port adapter + reviewer. Spec: SPEC_U37 section "U37b".
import { diffPlans, driftRules, reviewDrift } from "../agents";
import type { DriftPort } from "../agents";
import type { AgentState, Contract, DriftVerdict, StepState } from "../agents/types";
import type { HybridParamsShape, ModelFactory, ModeName } from "../ai/types";

export type DriftFloor = "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE";
export interface DriftReviewerOptions {
  port?: DriftPort | ((mode: ModeName) => DriftPort);
  timeoutMs?: number;
  killSwitchCloud?: boolean;
}
export interface DriftReviewer {
  review(state: AgentState, floor?: DriftFloor): Promise<DriftVerdict | undefined>;
}

const MODEL_NAME = "gemini-3.5-flash-lite";
const MAX_OUTPUT_TOKENS = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const abortedError = (signal: AbortSignal): unknown => signal.reason ?? new Error("aborted");

function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Adapts the U06 ModelFactory to U34's DriftPort. create() is called per
 * generate(); the schema is both responseConstraint and responseSchema.
 */
export function driftPortFromFactory(factory: ModelFactory, mode: ModeName): DriftPort {
  return {
    async generate(prompt: string, schema: object, signal: AbortSignal): Promise<{ text: string; source: "device" | "cloud" }> {
      if (signal.aborted) throw abortedError(signal);
      const params: HybridParamsShape = {
        mode: factory.modeConst(mode),
        inCloudParams: {
          model: MODEL_NAME,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        },
        onDeviceParams: { promptOptions: { responseConstraint: schema } },
      };
      const handle = factory.create(params);
      const result = await withAbort(handle.generateContent(prompt), signal);
      const text = result.response.text();
      const src = result.response.inferenceSource;
      if (src === factory.sourceConst.ON_DEVICE) return { text, source: "device" };
      if (src === factory.sourceConst.IN_CLOUD) return { text, source: "cloud" };
      throw new Error("driftPortFromFactory: unrecognised inference source");
    },
  };
}

/** Shape check for contract-like values coming from folded states. */
const isContract = (v: unknown): v is Contract => {
  if (!isRecord(v)) return false;
  if (typeof v["hash"] !== "string" || typeof v["title"] !== "string") return false;
  if (!Array.isArray(v["steps"])) return false;
  for (const s of v["steps"] as unknown[]) {
    if (!isRecord(s) || typeof s["text"] !== "string") return false;
  }
  return true;
};

export function createDriftReviewer(opts?: DriftReviewerOptions): DriftReviewer {
  const portOpt = opts?.port;
  const timeoutMs = opts?.timeoutMs;
  const killSwitchCloud = opts?.killSwitchCloud === true;

  // Real step states of every contract seen, keyed by room/agent/contract-hash (J8).
  const snapshots = new Map<string, StepState[]>();
  // Memoised reviews, keyed by room/agent/prevHash->hash, floor excluded (J9).
  const memo = new Map<string, Promise<DriftVerdict | undefined>>();
  // Serialisation: at most one port call in flight.
  let tail: Promise<void> = Promise.resolve();

  const snapKey = (room: string, agent: string, hash: string): string => JSON.stringify([room, agent, hash]);

  const recordSnapshot = (state: AgentState): void => {
    try {
      const c = state.contract;
      if (c === undefined || typeof c.hash !== "string") return;
      if (!Array.isArray(state.stepStates)) return;
      snapshots.set(snapKey(state.room, state.agent, c.hash), [...state.stepStates]);
    } catch {
      /* never throws */
    }
  };

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run: Promise<T> = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const doReview = async (state: AgentState, floor?: DriftFloor): Promise<DriftVerdict | undefined> => {
    const prev = state.previous as Contract;
    const next = state.contract as Contract;
    const diff = diffPlans(prev, next);
    const realRules = (): DriftVerdict => {
      const snap = snapshots.get(snapKey(state.room, state.agent, prev.hash));
      const stepStates: StepState[] =
        snap !== undefined ? [...snap] : prev.steps.map((): StepState => "pending");
      const rulesState: AgentState = { ...state, contract: prev, stepStates };
      return driftRules(diff, rulesState);
    };
    if (portOpt === undefined || portOpt === null) return realRules();
    let resolved: DriftPort;
    try {
      if (typeof portOpt === "function") {
        const mode: ModeName =
          floor === "PREFER_ON_DEVICE" && !killSwitchCloud ? "PREFER_ON_DEVICE" : "ONLY_ON_DEVICE";
        resolved = portOpt(mode);
      } else {
        resolved = portOpt;
      }
    } catch {
      return realRules();
    }
    try {
      const v = await reviewDrift(resolved, prev, next, timeoutMs === undefined ? undefined : { timeoutMs });
      if (isRecord(v as unknown) && (v as DriftVerdict).source !== "rules") return v as DriftVerdict;
      return realRules();
    } catch {
      return realRules();
    }
  };

  const review = (state: AgentState, floor?: DriftFloor): Promise<DriftVerdict | undefined> => {
    try {
      if (!isRecord(state as unknown)) return Promise.resolve(undefined);
      const st = state as AgentState;
      if (typeof st.room !== "string" || typeof st.agent !== "string") return Promise.resolve(undefined);
      recordSnapshot(st);
      const contract = st.contract;
      const previous = st.previous;
      if (!isContract(contract) || !isContract(previous)) return Promise.resolve(undefined);
      if (previous.hash === contract.hash) return Promise.resolve(undefined);
      const key = JSON.stringify([st.room, st.agent, previous.hash, contract.hash]);
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const run = enqueue(() => doReview(st, floor));
      const p: Promise<DriftVerdict | undefined> = run.then(
        (v) => v,
        (): DriftVerdict | undefined => undefined,
      );
      memo.set(key, p);
      return p;
    } catch {
      return Promise.resolve(undefined);
    }
  };

  return { review };
}
