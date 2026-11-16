import type { Clock } from "./types";
import type { ModelServices } from "./model_services";
import type { DriftPort } from "../agents";
import type { DriftVerdict } from "../agents/types";
import type { ModeName, ModelFactory } from "../ai/types";
import type { DriftFloor } from "./agent_drift";
import { createPlanAi as createDefaultPlanAi } from "../planai/reviewer";
import type {
  PlanAi,
  PlanAiOptions,
  PlanAiPort,
  PlanAiPortBinding,
  PlanAiTier,
  PlanBrief,
  PlanBriefInput,
  PlanMemoryInput,
  PlanTaskInput,
} from "../planai/types";

export const PLAN_REVIEW_DEBOUNCE_MS = 250;   // [TARGET]
export const PLAN_AI_CONCURRENCY = 2;         // [TARGET]

export interface RoomPlanSnapshot {
  readonly room: string;
  readonly planId: string;
  readonly title: string;
  readonly phase: string;
  readonly status: "active" | "closed";
  readonly rev: number;
  readonly doneMicrotasks: number;
  readonly totalMicrotasks: number;
  readonly tasks: readonly PlanTaskInput[];
  readonly memorySection?: PlanMemoryInput;
}

export interface PlanWiringDeps {
  readonly clock: Clock;
  readonly getServices: () => ModelServices | null;
  readonly getDriftFactory: () => ModelFactory | null;
  readonly driftPortFromFactory: (factory: ModelFactory, mode: ModeName) => DriftPort;
  readonly adaptDriftPort: (port: DriftPort) => PlanAiPort;
  readonly getSnapshots: () => readonly RoomPlanSnapshot[];
  readonly getTier?: (room: string) => PlanAiTier;
  readonly getKillSwitchCloud?: () => boolean;
  readonly createPlanAi?: (opts: PlanAiOptions) => PlanAi;
  readonly onUpdate: () => void;
  readonly debounceMs?: number;
  readonly concurrency?: number;
}

export interface PlanWiring {
  notifyChange(): void;
  taskVerdicts(): ReadonlyMap<string, DriftVerdict>;
  planBriefs(): ReadonlyMap<string, PlanBrief>;
  dispose(): void;
}

function failingBinding(): PlanAiPortBinding {
  const port: PlanAiPort = {
    generate: (): Promise<{ text: string; source: "device" }> => {
      return Promise.reject(new Error("plan provider unavailable"));
    },
  };
  return { port, allowExternal: false };
}

export function createPlanPortResolver(deps: {
  getServices: () => ModelServices | null;
  getDriftFactory: () => ModelFactory | null;
  driftPortFromFactory: (factory: ModelFactory, mode: ModeName) => DriftPort;
  adaptDriftPort: (port: DriftPort) => PlanAiPort;
  getKillSwitchCloud?: () => boolean;
}): (mode: ModeName) => PlanAiPortBinding {
  return (mode: ModeName): PlanAiPortBinding => {
    try {
      let kill = false;
      try {
        kill = deps.getKillSwitchCloud?.() === true;
      } catch {
        kill = true;
      }
      if (kill && mode !== "ONLY_ON_DEVICE") return failingBinding();
      let services: ModelServices | null = null;
      try {
        services = deps.getServices();
      } catch {
        return failingBinding();
      }
      if (services !== null && services !== undefined) {
        let grant: { port: DriftPort; allowExternal: boolean };
        try {
          grant = services.driftPortFor(mode) as { port: DriftPort; allowExternal: boolean };
        } catch {
          return failingBinding();
        }
        let allow = grant?.allowExternal === true;
        if (mode === "ONLY_ON_DEVICE" || kill) allow = false;
        let portable: PlanAiPort;
        try {
          portable = deps.adaptDriftPort(grant.port);
        } catch {
          return failingBinding();
        }
        if (portable === null || portable === undefined || typeof portable.generate !== "function") {
          return failingBinding();
        }
        return { port: portable, allowExternal: allow };
      }
      let factory: ModelFactory | null = null;
      try {
        factory = deps.getDriftFactory();
      } catch {
        return failingBinding();
      }
      if (factory !== null && factory !== undefined) {
        let drift: DriftPort;
        try {
          drift = deps.driftPortFromFactory(factory, mode);
        } catch {
          return failingBinding();
        }
        let portable: PlanAiPort;
        try {
          portable = deps.adaptDriftPort(drift);
        } catch {
          return failingBinding();
        }
        if (portable === null || portable === undefined || typeof portable.generate !== "function") {
          return failingBinding();
        }
        return { port: portable, allowExternal: false };
      }
      return failingBinding();
    } catch {
      return failingBinding();
    }
  };
}

type TaskJob = {
  kind: "task";
  key: string;
  room: string;
  planId: string;
  task: PlanTaskInput;
  memory: PlanMemoryInput | undefined;
  floor: DriftFloor;
  revKey: string;
  controller: AbortController;
  released: boolean;
};

type BriefJob = {
  kind: "brief";
  room: string;
  planId: string;
  plan: PlanBriefInput;
  floor: DriftFloor;
  revKey: string;
  controller: AbortController;
  released: boolean;
};

type Job = TaskJob | BriefJob;

function taskKeyOf(room: string, taskId: string): string {
  return `${room}:${taskId}`;
}

function taskRevKey(planId: string, task: PlanTaskInput, memory: PlanMemoryInput | undefined, floor: DriftFloor): string {
  return `${planId}:${floor}:${task.rev}::${memory?.rev ?? ""}`;
}

function briefRevKey(planId: string, rev: number, floor: DriftFloor): string {
  return `${planId}:${floor}:${rev}`;
}

function toBriefInput(snap: RoomPlanSnapshot): PlanBriefInput {
  const byId = new Map<string, PlanTaskInput>();
  for (const t of snap.tasks ?? []) {
    if (t && typeof t.id === "string") byId.set(t.id, t);
  }
  const tasks = (snap.tasks ?? []).map((t) => {
    const waitsFor = Array.isArray(t.deps) ? [...t.deps] : [];
    const ready = waitsFor.every((d) => byId.get(d)?.status === "done");
    return { id: t.id, title: t.title, state: t.status, ready, waitsFor };
  });
  return {
    planId: snap.planId,
    title: snap.title,
    phase: snap.phase,
    status: snap.status,
    rev: snap.rev,
    doneMicrotasks: snap.doneMicrotasks,
    totalMicrotasks: snap.totalMicrotasks,
    tasks,
  };
}

export function createPlanWiring(deps: PlanWiringDeps): PlanWiring {
  const rawDebounce = deps.debounceMs ?? PLAN_REVIEW_DEBOUNCE_MS;
  const debounceMs = Number.isFinite(rawDebounce) && rawDebounce >= 0 ? rawDebounce : PLAN_REVIEW_DEBOUNCE_MS;
  const rawConcurrency = deps.concurrency ?? PLAN_AI_CONCURRENCY;
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0 ? Math.max(1, Math.floor(rawConcurrency)) : PLAN_AI_CONCURRENCY;
  const clock = deps.clock;
  const resolver = createPlanPortResolver({
    getServices: deps.getServices,
    getDriftFactory: deps.getDriftFactory,
    driftPortFromFactory: deps.driftPortFromFactory,
    adaptDriftPort: deps.adaptDriftPort,
    ...(deps.getKillSwitchCloud !== undefined ? { getKillSwitchCloud: deps.getKillSwitchCloud } : {}),
  });

  let disposed = false;
  let timerId: number | null = null;
  const verdicts = new Map<string, DriftVerdict>();
  const briefs = new Map<string, PlanBrief>();
  const seenTaskRev = new Map<string, string>();
  const seenBriefRev = new Map<string, string>();
  const inflightTasks = new Map<string, TaskJob>();
  const inflightBriefs = new Map<string, BriefJob>();
  const currentPlanByRoom = new Map<string, string>();
  let queue: Job[] = [];
  let running = 0;
  let ai: PlanAi | null = null;
  let aiFailed = false;

  function cancelTimer(): void {
    if (timerId !== null) {
      try {
        clock.clearTimeout(timerId);
      } catch {
        /* ignore */
      }
      timerId = null;
    }
  }

  function releaseTask(job: TaskJob): void {
    if (job.released) return;
    job.released = true;
    running -= 1;
    if (inflightTasks.get(job.key) === job) inflightTasks.delete(job.key);
  }

  function releaseBrief(job: BriefJob): void {
    if (job.released) return;
    job.released = true;
    running -= 1;
    if (inflightBriefs.get(job.room) === job) inflightBriefs.delete(job.room);
  }

  function abortTask(key: string): void {
    const job = inflightTasks.get(key);
    if (job !== undefined) {
      releaseTask(job);
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  function abortBrief(room: string): void {
    const job = inflightBriefs.get(room);
    if (job !== undefined) {
      releaseBrief(job);
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  function tierFor(room: string): PlanAiTier {
    try {
      const t = deps.getTier?.(room);
      if (t === "private" || t === "standard" || t === "shared") return t;
    } catch {
      /* fall through */
    }
    return "private";
  }

  function killFor(): boolean {
    try {
      return deps.getKillSwitchCloud?.() === true;
    } catch {
      return true;
    }
  }

  function floorFor(room: string): DriftFloor {
    const tier = tierFor(room);
    const kill = killFor();
    if (tier === "private" || kill) return "ONLY_ON_DEVICE";
    return "PREFER_ON_DEVICE";
  }

  function getAi(): PlanAi | null {
    if (ai !== null) return ai;
    if (aiFailed) return null;
    try {
      const factory = deps.createPlanAi ?? createDefaultPlanAi;
      const aiClock = {
        setTimeout: (cb: () => void, ms: number): unknown => clock.setTimeout(cb, ms),
        clearTimeout: (handle: unknown): void => clock.clearTimeout(handle as number),
      };
      ai = factory({ port: resolver, clock: aiClock });
      return ai;
    } catch {
      aiFailed = true;
      ai = null;
      return null;
    }
  }

  function isCurrentTask(job: TaskJob): boolean {
    if (disposed) return false;
    if (job.controller.signal.aborted) return false;
    if (floorFor(job.room) !== job.floor) return false;
    return seenTaskRev.get(job.key) === job.revKey;
  }

  function isCurrentBrief(job: BriefJob): boolean {
    if (disposed) return false;
    if (job.controller.signal.aborted) return false;
    if (floorFor(job.room) !== job.floor) return false;
    return seenBriefRev.get(job.room) === job.revKey;
  }

  function safeOnUpdate(): void {
    try {
      deps.onUpdate();
    } catch {
      /* isolate host callback */
    }
  }

  function startJob(job: Job): void {
    running += 1;
    if (job.kind === "task") {
      inflightTasks.set(job.key, job);
    } else {
      inflightBriefs.set(job.room, job);
    }
    const finish = (): void => {
      if (job.kind === "task") {
        releaseTask(job);
      } else {
        releaseBrief(job);
      }
    };
    let promise: Promise<unknown>;
    try {
      const planAi = getAi();
      if (planAi === null) {
        finish();
        if (job.kind === "task") {
          if (seenTaskRev.get(job.key) === job.revKey) seenTaskRev.delete(job.key);
        } else {
          if (seenBriefRev.get(job.room) === job.revKey) seenBriefRev.delete(job.room);
        }
        pump();
        return;
      }
      const floor = job.floor;
      const tier = tierFor(job.kind === "task" ? job.room : job.room);
      if (job.kind === "task") {
        const ctx: { tier: PlanAiTier; floor: DriftFloor; memory?: PlanMemoryInput; signal: AbortSignal } = {
          tier,
          floor,
          signal: job.controller.signal,
        };
        if (job.memory !== undefined) ctx.memory = job.memory;
        promise = Promise.resolve(planAi.reviewTask(job.task, ctx));
      } else {
        promise = Promise.resolve(planAi.briefPlan(job.plan, { tier, floor, signal: job.controller.signal }));
      }
    } catch {
      finish();
      if (job.kind === "task") {
        if (seenTaskRev.get(job.key) === job.revKey) seenTaskRev.delete(job.key);
      } else {
        if (seenBriefRev.get(job.room) === job.revKey) seenBriefRev.delete(job.room);
      }
      pump();
      return;
    }
    promise.then(
      (value) => {
        try {
          if (job.kind === "task") {
            if (isCurrentTask(job)) {
              verdicts.set(job.key, value as DriftVerdict);
              safeOnUpdate();
            }
          } else {
            if (isCurrentBrief(job)) {
              briefs.set(job.room, value as PlanBrief);
              safeOnUpdate();
            }
          }
        } catch {
          /* ignore */
        } finally {
          finish();
          pump();
        }
      },
      () => {
        try {
          if (job.kind === "task") {
            if (seenTaskRev.get(job.key) === job.revKey) seenTaskRev.delete(job.key);
          } else {
            if (seenBriefRev.get(job.room) === job.revKey) seenBriefRev.delete(job.room);
          }
        } catch {
          /* ignore */
        } finally {
          finish();
          pump();
        }
      },
    );
  }

  function pump(): void {
    if (disposed) return;
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift();
      if (job === undefined) break;
      if (job.controller.signal.aborted) continue;
      if (floorFor(job.room) !== job.floor) continue;
      if (job.kind === "task") {
        if (seenTaskRev.get(job.key) !== job.revKey) continue;
      } else {
        if (seenBriefRev.get(job.room) !== job.revKey) continue;
      }
      startJob(job);
    }
  }

  function onTimer(): void {
    timerId = null;
    if (disposed) return;
    pump();
  }

  function armTimer(): void {
    cancelTimer();
    try {
      timerId = clock.setTimeout(onTimer, debounceMs);
    } catch {
      timerId = null;
    }
  }

  function notifyChange(): void {
    if (disposed) return;
    let snapshots: readonly RoomPlanSnapshot[] | undefined;
    try {
      snapshots = deps.getSnapshots();
    } catch {
      return;
    }
    if (snapshots === undefined || snapshots === null || snapshots.length === 0) {
      cancelTimer();
      for (const job of [...inflightTasks.values()]) {
        releaseTask(job);
        try {
          job.controller.abort();
        } catch {
          /* ignore */
        }
      }
      for (const job of [...inflightBriefs.values()]) {
        releaseBrief(job);
        try {
          job.controller.abort();
        } catch {
          /* ignore */
        }
      }
      inflightTasks.clear();
      inflightBriefs.clear();
      currentPlanByRoom.clear();
      queue = [];
      seenTaskRev.clear();
      seenBriefRev.clear();
      verdicts.clear();
      briefs.clear();
      return;
    }
    try {
      const presentTaskKeys = new Set<string>();
      const presentRooms = new Set<string>();
      const presentPlanByRoom = new Map<string, string>();
      for (const snap of snapshots) {
        if (snap === null || snap === undefined) continue;
        const room = snap.room;
        if (typeof room !== "string" || room.length === 0) continue;
        presentRooms.add(room);
        const planId = typeof snap.planId === "string" ? snap.planId : "";
        presentPlanByRoom.set(room, planId);
        const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        for (const task of tasks) {
          if (task === null || task === undefined || typeof task.id !== "string") continue;
          presentTaskKeys.add(taskKeyOf(room, task.id));
        }
      }
      for (const [room, planId] of [...presentPlanByRoom.entries()]) {
        const previous = currentPlanByRoom.get(room);
        if (previous !== undefined && previous !== planId) {
          for (const key of [...verdicts.keys()]) {
            if (key.startsWith(`${room}:`)) verdicts.delete(key);
          }
          briefs.delete(room);
          for (const key of [...seenTaskRev.keys()]) {
            if (key.startsWith(`${room}:`)) seenTaskRev.delete(key);
          }
          seenBriefRev.delete(room);
        }
      }
      for (const room of [...currentPlanByRoom.keys()]) {
        if (!presentRooms.has(room)) currentPlanByRoom.delete(room);
      }
      for (const [room, planId] of [...presentPlanByRoom.entries()]) {
        currentPlanByRoom.set(room, planId);
      }
      for (const key of [...inflightTasks.keys()]) {
        if (!presentTaskKeys.has(key)) abortTask(key);
      }
      for (const room of [...inflightBriefs.keys()]) {
        if (!presentRooms.has(room)) abortBrief(room);
      }
      for (const key of [...seenTaskRev.keys()]) {
        if (!presentTaskKeys.has(key)) seenTaskRev.delete(key);
      }
      for (const room of [...seenBriefRev.keys()]) {
        if (!presentRooms.has(room)) seenBriefRev.delete(room);
      }
      for (const key of [...verdicts.keys()]) {
        if (!presentTaskKeys.has(key)) verdicts.delete(key);
      }
      for (const room of [...briefs.keys()]) {
        if (!presentRooms.has(room)) briefs.delete(room);
      }
      queue = queue.filter((job) => {
        if (job.kind === "task") {
          return presentTaskKeys.has(job.key) && seenTaskRev.get(job.key) === job.revKey;
        }
        return presentRooms.has(job.room) && seenBriefRev.get(job.room) === job.revKey;
      });
      const fresh: Job[] = [];
      for (const snap of snapshots) {
        if (snap === null || snap === undefined) continue;
        const room = snap.room;
        if (typeof room !== "string" || room.length === 0) continue;
        const floor = floorFor(room);
        const planId = typeof snap.planId === "string" ? snap.planId : "";
        const memory = snap.memorySection;
        const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        for (const task of tasks) {
          if (task === null || task === undefined || typeof task.id !== "string") continue;
          const key = taskKeyOf(room, task.id);
          const revKey = taskRevKey(planId, task, memory, floor);
          if (seenTaskRev.get(key) === revKey) continue;
          abortTask(key);
          const controller = new AbortController();
          seenTaskRev.set(key, revKey);
          fresh.push({ kind: "task", key, room, planId, task, memory, floor, revKey, controller, released: false });
        }
        const briefKey = briefRevKey(planId, snap.rev, floor);
        if (seenBriefRev.get(room) !== briefKey) {
          abortBrief(room);
          const controller = new AbortController();
          seenBriefRev.set(room, briefKey);
          fresh.push({ kind: "brief", room, planId, plan: toBriefInput(snap), floor, revKey: briefKey, controller, released: false });
        } else {
          queue = queue.filter((job) => job.kind !== "brief" || job.room !== room || job.revKey === briefKey);
        }
      }
      queue.push(...fresh);
      if (fresh.length > 0 || (queue.length > 0 && timerId === null)) {
        armTimer();
      }
    } catch {
      /* fail-safe: never throw from notifyChange */
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelTimer();
    for (const job of [...inflightTasks.values()]) {
      releaseTask(job);
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
    }
    for (const job of [...inflightBriefs.values()]) {
      releaseBrief(job);
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
    }
    inflightTasks.clear();
    inflightBriefs.clear();
    currentPlanByRoom.clear();
    queue = [];
  }

  return {
    notifyChange,
    taskVerdicts: (): ReadonlyMap<string, DriftVerdict> => verdicts,
    planBriefs: (): ReadonlyMap<string, PlanBrief> => briefs,
    dispose,
  };
}
