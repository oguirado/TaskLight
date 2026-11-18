/// <reference types="vite/client" />
// U38 G4: the hosted wall loads its stylesheets (tokens first, wall before
// views so views win the cascade, agents last).
import "../../styles/tokens.css";
import "../../styles/wall.css";
import "../../styles/views.css";
import "../../styles/plan.css";
import "../../styles/swarm.css";
import "../../styles/model_selector.css";
import "../../styles/agents.css";
import { boot, onGoogleSignIn, onUserActivation } from "../../src/app/boot";
import { createConnector } from "../../src/app/connector";
import { createAgentLink } from "../../src/app/agent_link";
import type { RoomGapFrame, RoomSyncErrorCode, RoomSyncedFrame } from "../../src/app/agent_link";
import { createAgentStore } from "../../src/app/agent_store";
import { createSyncNotice } from "../../src/views/sync_notice";
import * as Plan from "../../src/plan";
import { createDriftReviewer, driftPortFromFactory } from "../../src/app/agent_drift";
import { createPlanWiring } from "../../src/app/plan_wiring";
import type { PlanWiring, RoomPlanSnapshot } from "../../src/app/plan_wiring";
import { getTemplateMemorySections, resolveStarterTemplate } from "../../src/app/starter_templates";
import type { DriftVerdict } from "../../src/agents/types";
import { buildPlanSnapshots } from "../../src/app/plan_snapshots";
import { createModelServices } from "../../src/app/model_services";
import type { ModelServices } from "../../src/app/model_services";
import { attachModelChannel } from "../../src/app/model_port";
import type { ModelChannel } from "../../src/app/model_port";
import { createModelSheet, effectiveId } from "../../src/ui/model_selector";
import type { ModelSheetIntent } from "../../src/ui/model_selector";
import type { Announcer } from "../../src/ui/types";
import { FIREBASE_IDS } from "../../src/providers/types";
import type { ModelSelection, ProviderDescriptor } from "../../src/providers/types";
import { startAgentWall } from "../../src/app/agent_wall";
import type { AgentWall } from "../../src/app/agent_wall";
import { createLiaisonController } from "../../src/app/liaison";
import type { LiaisonInput, LiaisonProviderPort } from "../../src/app/liaison";
import { mountLiaisonPanel } from "../../src/agentsui/liaison_panel";
import type { LiaisonPanelHandle } from "../../src/agentsui/liaison_panel";
import { isPlaceholderConfig } from "../../src/app/firebase-config.public";
import { readHostEnv } from "../../src/app/index";
import { renderHostState } from "../../src/app/ui";
import type { Clock, FirebasePorts, HybridPort, HostState, RuntimePort, WallPortState } from "../../src/app/types";
import type { ModelFactory } from "../../src/ai/types";
import type { FirebaseApp } from "firebase/app";

const isProd = import.meta.env.MODE === "production";

// Cherry-pick env fields; never hand the whole import.meta.env to the bundle.
// The debug token is dev-only: in production the branch is constant-folded so
// no value is baked into the prod output (B5).
const env = readHostEnv(
  {
    MODE: import.meta.env.MODE as string,
    VITE_RECAPTCHA_SITE_KEY: import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined,
    VITE_APPCHECK_DEBUG_TOKEN: isProd
      ? ""
      : (import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined),
    VITE_EXTENSION_ORIGINS: import.meta.env.VITE_EXTENSION_ORIGINS as string | undefined,
    VITE_USE_LIMITED_USE_TOKENS: import.meta.env.VITE_USE_LIMITED_USE_TOKENS as string | undefined,
  },
  window.location.origin,
);

// Wire real Firebase/U06 ports only when the public config carries real values:
// in a placeholder build the production bundle stays Firebase-free (B5/O13) and
// boot fails closed on CONFIG_INVALID before any port is touched. The Vite
// production define (__U22_FIREBASE_REAL__) is computed from the shipped
// config file; without it (dev/test) the runtime config decides.
declare const __U22_FIREBASE_REAL__: boolean;
const WIRE_REAL =
  typeof __U22_FIREBASE_REAL__ === "boolean"
    ? __U22_FIREBASE_REAL__
    : !isPlaceholderConfig(env.firebaseConfig);

const root = document.getElementById("wall");
if (root === null) throw new Error("wall root missing");

// U52: the only global-timer site; every other timer flows through this clock.
const wallClock: Clock = {
  now: () => Date.now(),
  // Global timers are numbers in the browser; under Node they are Timeout objects.
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => clearInterval(id as unknown as ReturnType<typeof setInterval>),
};

// U52 model channel bus: fans out to the latest attached RuntimePort, so the
// page transport follows reconnects while staying silent before any hello.
const busFrameCbs = new Set<(f: unknown) => void>();
const busResetCbs = new Set<() => void>();
const busOff = new Map<(f: unknown) => void, Set<() => void>>();
const busResetOff = new Map<() => void, Set<() => void>>();
let latestModelChannel: ModelChannel | null = null;
const detachLatest = (): void => {
  for (const set of busOff.values()) {
    for (const o of [...set]) {
      try { o(); } catch { /* ignore */ }
    }
  }
  for (const set of busResetOff.values()) {
    for (const o of [...set]) {
      try { o(); } catch { /* ignore */ }
    }
  }
  busOff.clear();
  busResetOff.clear();
};
const bindBusTo = (ch: ModelChannel): void => {
  // Replacement is atomic: detach the previous port's subscriptions first so
  // stale frames or disconnects cannot leak into the new port, then
  // synchronously reset consumers before any new hello can arrive.
  detachLatest();
  latestModelChannel = ch;
  for (const cb of [...busResetCbs]) {
    try { cb(); } catch { /* host callback must not break binding */ }
  }
  for (const cb of busFrameCbs) {
    const off = ch.onFrame(cb);
    let set = busOff.get(cb);
    if (set === undefined) {
      set = new Set();
      busOff.set(cb, set);
    }
    set.add(off);
  }
  for (const cb of busResetCbs) {
    const off = ch.onReset(cb);
    let set = busResetOff.get(cb);
    if (set === undefined) {
      set = new Set();
      busResetOff.set(cb, set);
    }
    set.add(off);
  }
};
const modelBus: ModelChannel = {
  send: (frame: object): boolean => (latestModelChannel !== null ? latestModelChannel.send(frame) : false),
  onFrame: (cb: (f: unknown) => void): (() => void) => {
    busFrameCbs.add(cb);
    let off: (() => void) | null = null;
    if (latestModelChannel !== null) {
      off = latestModelChannel.onFrame(cb);
      let set = busOff.get(cb);
      if (set === undefined) {
        set = new Set();
        busOff.set(cb, set);
      }
      set.add(off);
    }
    return () => {
      busFrameCbs.delete(cb);
      const set = busOff.get(cb);
      if (set !== undefined) {
        for (const o of [...set]) { try { o(); } catch { /* ignore */ } }
        busOff.delete(cb);
      }
    };
  },
  onReset: (cb: () => void): (() => void) => {
    busResetCbs.add(cb);
    if (latestModelChannel !== null) {
      const off = latestModelChannel.onReset(cb);
      let set = busResetOff.get(cb);
      if (set === undefined) {
        set = new Set();
        busResetOff.set(cb, set);
      }
      set.add(off);
    }
    return () => {
      busResetCbs.delete(cb);
      const set = busResetOff.get(cb);
      if (set !== undefined) {
        for (const o of [...set]) { try { o(); } catch { /* ignore */ } }
        busResetOff.delete(cb);
      }
    };
  },
};

// State renders into its own child so the trusted controls survive re-renders.
const stateRoot = document.createElement("div");
stateRoot.id = "wall-state";
root.appendChild(stateRoot);

// U38 V4: boot controls render as styled buttons inside the rail status
// area (`.rail-status`), not as raw elements on top of the page. The wall
// re-renders replace the rail, so a MutationObserver re-anchors the
// controls after every render.
const controls = document.createElement("div");
controls.className = "boot-controls";
const googleBtn = document.createElement("button");
googleBtn.type = "button";
googleBtn.className = "boot-btn";
googleBtn.textContent = "Sign in with Google";
googleBtn.addEventListener("click", (ev) => {
  void onGoogleSignIn(ev.isTrusted);
});
const deviceBtn = document.createElement("button");
deviceBtn.type = "button";
deviceBtn.className = "boot-btn";
deviceBtn.textContent = "Download device model";
deviceBtn.addEventListener("click", (ev) => {
  void onUserActivation(ev.isTrusted);
});
controls.appendChild(googleBtn);
controls.appendChild(deviceBtn);
// U42: with the placeholder Firebase config the buttons cannot do anything (no Firebase
// project), so they are not shown; the "Gemini Nano: checking…" status line stays.
const SHOW_BOOT_CONTROLS = WIRE_REAL;
const ensureBootControls = (): void => {
  if (!SHOW_BOOT_CONTROLS) {
    if (controls.parentNode !== null) controls.remove();
    return;
  }
  const railStatus = root.querySelector(".rail-status");
  if (railStatus !== null) {
    if (controls.parentNode !== railStatus) railStatus.appendChild(controls);
  } else if (controls.parentNode !== root) {
    root.appendChild(controls);
  }
};
ensureBootControls();
new MutationObserver(ensureBootControls).observe(root, { childList: true, subtree: true });

// Connector (T2 postMessage path). Payloads go only to the sink; never logged.
const connector = createConnector(
  env,
  { accept: () => undefined },
  () => Date.now(),
);
window.addEventListener("message", (ev) => {
  const target = ev.source as {
    postMessage(msg: unknown, targetOrigin: string): void;
  } | null;
  connector.onMessage({
    origin: ev.origin,
    data: ev.data,
    source: target === null ? null : { postMessage: (msg, to) => { target.postMessage(msg, to); } },
  });
});

// U06 is the sole caller of getAI; the wall hands it the attested app via this port.
let fb: FirebasePorts | null = null;
let hy: HybridPort | null = null;
/** Set by hy.create from the attested app; the drift reviewer reads it lazily. */
let driftFactory: ModelFactory | null = null;
let deviceModelState: string | undefined;
/** U52 model services; built inside hy.create, null when construction fails (F4). */
let services: ModelServices | null = null;
let refreshLiaison = (): void => undefined;
let offModelSheet: (() => void) | undefined;
let activeModelRoom: string | undefined;
let roomFloorForModels: (room: string) => unknown = () => undefined;
let refreshModelsWall = (): void => undefined;
let sheetReady = false;

// Host floors and registry resolution are the authority; network reachability
// and the selected chat task cannot grant room permissions.
function modelAvailability(room: string | undefined = activeModelRoom): string {
  if (services === null) return "Models unavailable";
  const floor = room === undefined ? undefined : roomFloorForModels(room);
  const tier = floor === "ONLY_ON_DEVICE" ? "private"
    : floor === "PREFER_ON_DEVICE" ? "standard" : undefined;
  if (tier === undefined) return "Room policy unknown";
  const policy = tier === "private" ? "Cloud blocked by room policy" : "Room policy permits cloud";
  try {
    const selectedId = effectiveId(services.sheet().selection(), "capsule");
    const descriptor = services.registry.list().find(provider => provider.id === selectedId);
    const chain = services.registry.resolve("status", tier);
    if (descriptor === undefined || chain.blocked !== undefined || chain.primary !== selectedId
      || descriptor.blockedReason !== undefined) return `${policy} · Selected model unavailable`;
    // Hybrid health does not attest on-device readiness in a private room.
    if (tier === "private" && descriptor.kind !== "firebase-ondevice") return policy;
    if (descriptor.health === "available") return `${policy} · ${descriptor.label} available`;
    const health = descriptor.health === "needs_setup" ? "Needs setup"
      : descriptor.health === "offline" ? "Offline" : "Blocked";
    return `${policy} · ${descriptor.label}: ${health}`;
  } catch { return `${policy} · Models unavailable`; }
}
if (WIRE_REAL) {
  const { createFirebasePorts } = await import("../../src/app/firebase_ports");
  fb = createFirebasePorts();
  const { firebaseFactory } = await import("../../src/ai/firebase");
  const { createHybrid } = await import("../../src/ai/hybrid");
  let factory: ReturnType<typeof firebaseFactory> | null = null;
  hy = {
    create: (app) => {
      factory = firebaseFactory(app as FirebaseApp);
      driftFactory = factory;
      try {
        offModelSheet?.();
        services?.dispose();
        services = createModelServices({
          factory: factory as ModelFactory,
          origin: window.location.origin,
          clock: wallClock,
          channel: modelBus,
        });
        offModelSheet = services.sheet().subscribe(() => { renderSheet(); refreshModelsWall(); refreshLiaison(); });
        renderSheet();
        refreshModelsWall();
        refreshLiaison();
      } catch {
        services = null;
        renderSheet();
        refreshModelsWall();
      }
    },
    initializeDeviceModel: async (onProgress) => {
      if (services !== null) {
        for (;;) {
          const st = await services.registry.initDevice(onProgress);
          if (st.state === "ready") return;
          if (st.state !== "downloading") throw new Error(`device ${st.state}`);
        }
      }
      if (factory === null) throw new Error("hybrid not created");
      const hybrid = createHybrid({
        factory,
        origin: window.location.origin,
        appCheckReady: true,
        config: {},
      });
      await hybrid.initDevice(onProgress);
    },
  };
}

if (fb === null || hy === null) {
  // Placeholder build: boot fails closed on CONFIG_INVALID without calling ports.
  const unavailable = (): never => {
    throw new Error("firebase ports unavailable in placeholder build");
  };
  fb = {
    initializeApp: unavailable,
    setDebugFlag: unavailable,
    newRecaptchaEnterpriseProvider: unavailable,
    newDebugCompatibleProvider: unavailable,
    initializeAppCheck: unavailable,
    getAuth: unavailable,
    signInAnonymously: unavailable,
    onAuthStateChanged: unavailable,
    signInWithGooglePopup: unavailable,
  };
  hy = {
    create: () => undefined,
    initializeDeviceModel: () => Promise.resolve(),
  };
}

const fbPorts: FirebasePorts = fb;
const hyPort: HybridPort = hy;

/* ------------------------------------------------------------------ */
/* U37c agent wall (room link). Runs without Firebase: with a          */
/* placeholder config boot is skipped (B16) and the reviewer is        */
/* rules-only; the wall hosts still render.                            */
/* ------------------------------------------------------------------ */

const EXT_ID_RE = /^chrome-extension:\/\/([a-p]{32})$/;
let extId: string | null = null;
for (const origin of env.extensionOrigins) {
  const match = EXT_ID_RE.exec(origin.trim());
  if (match !== null && match[1] !== undefined) {
    extId = match[1];
    break;
  }
}

if (extId !== null) {
  const wallHost = document.createElement("div");
  const chatHost = document.createElement("div");
  root.appendChild(wallHost);
  root.appendChild(chatHost);
  const store = createAgentStore({ templates: resolveStarterTemplate });
  const roomFloors = new Map<string, string>();
  roomFloorForModels = room => roomFloors.get(room);
  type SyncFault = { kind: "unknown" } | { kind: "interval"; from: number; to: number };
  interface RecoveryState { startSince: number; faultKeys: Set<string>; sawOverlap: boolean; sawFailure: boolean }
  const helloRooms = new Set<string>();
  const syncedRooms = new Set<string>();
  const roomSyncErrors = new Map<string, RoomSyncErrorCode>();
  let workspaceEpoch: string | undefined;
  const readWorkspaceLink = (): WallPortState | null => {
    let state: WallPortState | null;
    try { state = link.state() ?? null; } catch { state = null; }
    const epoch = state === null ? "unknown" : state.kind === "linked" || state.kind === "resyncing"
      ? `${state.kind}:${state.nonce}` : state.kind;
    if (epoch !== workspaceEpoch) {
      workspaceEpoch = epoch;
      // A prior hello or completed replay cannot certify a new connection.
      helloRooms.clear();
      syncedRooms.clear();
    }
    return state;
  };
  const faults = new Map<string, Map<string, SyncFault>>();
  const recovery = new Map<string, RecoveryState>();
  const noticeHost = document.createElement("div");
  root.appendChild(noticeHost);
  const syncNotice = createSyncNotice(noticeHost);
  const faultKey = (f: SyncFault): string =>
    f.kind === "interval" ? `${String(f.from)}:${String(f.to)}` : "unknown";
  const earliestFaultFrom = (room: string): number | undefined => {
    const set = faults.get(room);
    if (set === undefined || set.size === 0) return undefined;
    let best: number | undefined;
    for (const f of set.values()) {
      // An unknown position requires full history, even alongside known gaps.
      if (f.kind === "unknown") return 0;
      best = best === undefined ? f.from : Math.min(best, f.from);
    }
    return best;
  };
  const isStale = (): boolean => {
    for (const room of helloRooms) if ((faults.get(room)?.size ?? 0) > 0) return true;
    return false;
  };
  const refreshNotice = (): void => {
    const list: { room: string; fromLamport?: number; toLamport?: number }[] = [];
    for (const room of [...faults.keys()].sort()) {
      if (!helloRooms.has(room)) continue;
      const set = faults.get(room);
      if (set === undefined) continue;
      const intervals = [...set.values()].sort((a, b) =>
        (a.kind === "interval" ? a.from : 0) - (b.kind === "interval" ? b.from : 0));
      for (const f of intervals) {
        if (f.kind === "interval") list.push({ room, fromLamport: f.from, toLamport: f.to });
        else list.push({ room });
      }
    }
    syncNotice.update(list);
  };
  const addFault = (room: string, f: SyncFault): void => {
    if (!helloRooms.has(room)) return;
    syncedRooms.delete(room);
    let set = faults.get(room);
    if (set === undefined) {
      set = new Map<string, SyncFault>();
      faults.set(room, set);
    }
    const key = faultKey(f);
    if (set.has(key)) return;
    set.set(key, { ...f });
    refreshNotice();
  };
  const eventLamport = (ev: unknown): number | undefined => {
    if (typeof ev === "object" && ev !== null && !Array.isArray(ev)) {
      const lam = (ev as Record<string, unknown>)["lamport"];
      if (typeof lam === "number" && Number.isSafeInteger(lam) && lam >= 1) return lam;
    }
    return undefined;
  };
  const foldDiagnosticLamport = (room: string): number | undefined => {
    try {
      const res = store.plan(room);
      if (res === undefined) return undefined;
      if (res.errors !== undefined) {
        for (const e of res.errors) if (typeof e.lamport === "number" && Number.isSafeInteger(e.lamport)) return e.lamport;
      }
      const rejected = res.projection.rejected;
      if (Array.isArray(rejected)) {
        for (const r of rejected) {
          if (typeof r.lamport === "number" && Number.isSafeInteger(r.lamport)) return r.lamport;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  };
  const foldHasFailure = (room: string): boolean => {
    try {
      const res = store.plan(room);
      if (res !== undefined) {
        if (res.invalidOps > 0) return true;
        if ((res.rejectedOps ?? 0) > 0) return true;
        if ((res.errors?.length ?? 0) > 0) return true;
        if ((res.projection.rejected?.length ?? 0) > 0) return true;
      }
    } catch {
      return false;
    }
    try {
      const display = store.events(room);
      const folded = Plan.foldPlan(display as unknown, resolveStarterTemplate);
      const stats = folded.stats;
      if (stats.invalid > 0 || stats.rejected > 0 || stats.errors.length > 0) return true;
      if (folded.projection.rejected.length > 0) return true;
      return false;
    } catch {
      return false;
    }
  };
  const recoverySince = (): Record<string, number> => {
    const base = store.since();
    const out: Record<string, number> = { ...base };
    for (const room of faults.keys()) {
      const early = earliestFaultFrom(room);
      if (early === undefined) continue;
      out[room] = Math.min(base[room] ?? 0, Math.max(0, early - 1));
    }
    return out;
  };
  let wall: AgentWall | undefined;
  const refreshWall = (): void => {
    refreshLiaison();
    if (isStale()) {
      // M4: retain the review gate while still repainting connection/sync guidance.
      wall?.refreshModels?.();
      return;
    }
    try {
      wall?.refresh();
      refreshLiaison();
    } catch {
      /* wall failures never break room callbacks */
    }
  };
  const templateMemorySections = (templateId: string) => {
    try {
      const sections = getTemplateMemorySections(templateId);
      if (sections === undefined) return undefined;
      return sections.map((s) => ({ id: s.id, label: s.label, required: s.required, max_chars: s.maxChars }));
    } catch {
      return undefined;
    }
  };
  const getSnapshots = (): readonly RoomPlanSnapshot[] => buildPlanSnapshots(store.plans());
  let planWiring: PlanWiring | null = null;
  try {
    planWiring = createPlanWiring({
      clock: wallClock,
      getServices: () => services,
      getDriftFactory: () => driftFactory,
      driftPortFromFactory,
      adaptDriftPort: (port) => port as unknown as import("../../src/planai/types").PlanAiPort,
      getSnapshots,
      getTier: (room) => roomFloors.get(room) === "PREFER_ON_DEVICE" ? "standard" : "private",
      onUpdate: () => refreshWall(),
    });
  } catch {
    planWiring = null;
  }
  const notifyPlan = (): void => {
    try {
      planWiring?.notifyChange();
    } catch {
      /* plan failures never break room callbacks */
    }
  };
  const planVerdicts = (): ReadonlyMap<string, DriftVerdict> => {
    const out = new Map<string, DriftVerdict>();
    try {
      const source = planWiring?.taskVerdicts();
      if (source !== undefined) {
        for (const [key, value] of source) out.set(`plan:${key}`, value);
      }
    } catch {
      /* return best-effort feed */
    }
    return out;
  };
  const planBriefs = (): ReadonlyMap<string, { text: string; source: string }> => {
    const out = new Map<string, { text: string; source: string }>();
    try {
      const source = planWiring?.planBriefs();
      if (source !== undefined) {
        for (const [room, value] of source) out.set(room, { text: value.brief, source: value.source });
      }
    } catch {
      /* return best-effort feed */
    }
    return out;
  };
  const link = createAgentLink({
    extId,
    connect: (id) => {
      const port = (globalThis as unknown as { chrome: { runtime: { connect(c: string): RuntimePort } } }).chrome.runtime.connect(id);
      bindBusTo(attachModelChannel(port));
      return port;
    },
    clock: wallClock,
    since: () => recoverySince(),
    onRoomEvent: (frame) => {
      roomFloors.set(frame.room, frame.floor);
      renderSheet();
      refreshModelsWall();
      refreshLiaison();
      if (!helloRooms.has(frame.room)) return;
      const ingested = store.ingestChecked(frame.event);
      if (ingested === "invalid") {
        const lam = eventLamport(frame.event);
        addFault(frame.room, lam !== undefined ? { kind: "interval", from: lam, to: lam } : { kind: "unknown" });
        const rec = recovery.get(frame.room);
        if (rec !== undefined) rec.sawFailure = true;
      } else if (ingested === "accepted" && foldHasFailure(frame.room)) {
        const lam = foldDiagnosticLamport(frame.room) ?? eventLamport(frame.event);
        addFault(frame.room, lam !== undefined ? { kind: "interval", from: lam, to: lam } : { kind: "unknown" });
        const rec = recovery.get(frame.room);
        if (rec !== undefined) rec.sawFailure = true;
      }
      notifyPlan();
      refreshWall();
    },
    onRoomGap: (frame: RoomGapFrame) => {
      const room = frame.room;
      if (!helloRooms.has(room)) return;
      const rec = recovery.get(room);
      if (rec !== undefined) {
        const set = faults.get(room);
        if (set !== undefined) {
          for (const f of set.values()) {
            if (f.kind === "interval"
              && frame.from_lamport <= f.to && frame.to_lamport >= f.from) {
              rec.sawOverlap = true;
              break;
            }
          }
        }
      }
      addFault(room, { kind: "interval", from: frame.from_lamport, to: frame.to_lamport });
      notifyPlan();
      refreshWall();
    },
    onRoomSyncError: ({ room, code }) => {
      if (roomSyncErrors.get(room) === code) return;
      roomSyncErrors.set(room, code);
      syncedRooms.delete(room);
      refreshWall();
    },
    onRoomSyncRecovered: room => { roomSyncErrors.delete(room); },
    onRoomSynced: (frame: RoomSyncedFrame) => {
      const state = readWorkspaceLink();
      if (frame.more || state?.kind !== "linked" || !helloRooms.has(frame.room)) return;
      const room = frame.room;
      try {
        const rec = recovery.get(room);
        if (rec === undefined) return;
        recovery.delete(room);
        const early = earliestFaultFrom(room);
        if (early === undefined) return;
        if (early === 0 ? rec.startSince !== 0 : rec.startSince >= early) return;
        if (rec.sawOverlap || rec.sawFailure) return;
        if (foldHasFailure(room)) return;
        const set = faults.get(room);
        if (set === undefined) return;
        if (set.size !== rec.faultKeys.size) return;
        for (const [key, fault] of set) {
          if (!rec.faultKeys.has(key)) return;
          if (fault.kind === "interval" && frame.upto < fault.to) return;
        }
        faults.delete(room);
        refreshNotice();
        notifyPlan();
      } finally {
        // Ordinary terminal replay is completion too; recovery faults are optional.
        if (!roomSyncErrors.has(room) && (faults.get(room)?.size ?? 0) === 0) syncedRooms.add(room);
        refreshWall();
      }
    },
    onRoomHello: (frame) => {
      readWorkspaceLink();
      helloRooms.clear();
      syncedRooms.clear();
      recovery.clear();
      for (const room of frame.rooms) helloRooms.add(room.room);
      roomFloors.clear();
      for (const room of frame.rooms) roomFloors.set(room.room, room.floor);
      renderSheet();
      refreshModelsWall();
      refreshLiaison();
      for (const room of [...faults.keys()]) {
        if (!helloRooms.has(room)) continue;
        const early = earliestFaultFrom(room);
        if (early === undefined) continue;
        const set = faults.get(room);
        if (set === undefined) continue;
        recovery.set(room, {
          startSince: Math.max(0, early - 1),
          faultKeys: new Set(set.keys()),
          sawOverlap: false,
          sawFailure: false,
        });
      }
      refreshNotice();
      notifyPlan();
      refreshWall();
    },
  });
  const reviewer = WIRE_REAL
    ? createDriftReviewer({
        port: ((mode: import("../../src/ai/types").ModeName) => {
          if (services !== null) return services.driftPortFor(mode);
          if (driftFactory === null) throw new Error("drift factory unavailable");
          return driftPortFromFactory(driftFactory, mode);
        }) as unknown as import("../../src/app/agent_drift").DriftReviewerOptions["port"],
      } as unknown as import("../../src/app/agent_drift").DriftReviewerOptions)
    : createDriftReviewer({});
  const modelStatus = (): import("../../src/views/types").WallVM["model"] | undefined => {
    if (!WIRE_REAL) return undefined;
    if (deviceModelState === "initialized") return { state: "ready", label: "Gemini Nano: ready" };
    if (deviceModelState === "failed") return { state: "unavailable", label: "Gemini Nano: not available on this device — enable the on-device model flags in Chrome. Rules is the active reviewer." };
    return undefined;
  };
  wall = startAgentWall({
    modelStatus, wallHost, chatHost, link, store, reviewer, clock: wallClock,
    workspaceStatus: () => {
      const state = readWorkspaceLink();
      return { link: state, rooms: [...helloRooms], synced: [...syncedRooms], roomErrors: Object.fromEntries(roomSyncErrors) };
    },
    userAgent: "wall-user", planVerdicts, planBriefs, templateMemorySections,
    modelAvailability: room => {
      activeModelRoom = room;
      renderSheet();
      return modelAvailability(room);
    },
    onOpenModels: trigger => {
      services?.sheet().onOpen();
      sheet.open(trigger);
      renderSheet();
    },
  });
  refreshModelsWall = () => wall?.refreshModels?.();
  // Each mounted panel belongs to one task, executor, host floor and model
  // selection. Replacing it aborts pending work and discards stale output.
  let liaisonPanel: LiaisonPanelHandle | undefined;
  let liaisonHost: HTMLElement | undefined;
  let liaisonTrigger: HTMLButtonElement | undefined;
  let liaisonKey = "";
  let pageClosed = false;
  const clearLiaison = (): void => {
    liaisonPanel?.destroy();
    liaisonPanel = undefined;
    liaisonHost?.remove();
    liaisonTrigger?.remove();
    liaisonHost = undefined;
    liaisonTrigger = undefined;
    liaisonKey = "";
  };
  const getLiaisonContext = (): LiaisonInput => {
    const selected = wall?.selection?.();
    const handle = wall?.chat?.();
    if (selected == null || handle == null) throw new Error("No selected task composer");
    const projection = store.plan(selected.room)?.projection;
    const task = projection?.tasks.find(t => t.id === selected.taskId);
    if (task === undefined) throw new Error("Selected task unavailable");
    const floor = roomFloors.get(selected.room);
    // An absent/unknown host floor remains invalid; the controller blocks it
    // before persistence or inference rather than assuming a privacy tier.
    const tier = floor === "ONLY_ON_DEVICE" ? "private"
      : floor === "PREFER_ON_DEVICE" ? "standard" : undefined;
    return {
      room: selected.room, task_id: selected.taskId,
      human: { id: `human:${selected.room}:${selected.taskId}`, text: handle.getDraft() },
      tier: tier as LiaisonInput["tier"],
      rules: task.accept, projection,
      history: store.events(selected.room)
        .filter(e => e.agent === selected.assignee || e.to === selected.assignee)
        .slice(-20).map(e => ({ id: e.id, text: e.text })),
      cursor: store.since()[selected.room] ?? 0,
    };
  };
  const liaisonRegistry: LiaisonProviderPort = {
    select: selection => (services?.registry as unknown as LiaisonProviderPort | undefined)?.select(selection),
    resolve: (task, tier) => (services?.registry as unknown as LiaisonProviderPort | undefined)?.resolve(task, tier)
      ?? { primary: "firebase-hybrid", hop: null, blocked: undefined },
    generate: async request => {
      if (services === null) return { ok: false, code: "NEEDS_SETUP", providerId: "firebase-hybrid", fallback: false };
      services.refreshFlags();
      return (services.registry as unknown as LiaisonProviderPort).generate(request);
    },
  };
  refreshLiaison = (): void => {
    if (pageClosed) return;
    const selected = wall?.selection?.();
    if (selected == null || wall?.chat?.() == null) { clearLiaison(); return; }
    const key = JSON.stringify([selected, roomFloors.get(selected.room), services?.sheet().selection()]);
    if (key !== liaisonKey) {
      clearLiaison();
      liaisonKey = key;
      const controller = createLiaisonController({ registry: liaisonRegistry });
      controller.setContext(getLiaisonContext());
      liaisonTrigger = document.createElement("button");
      liaisonTrigger.type = "button";
      liaisonTrigger.textContent = "Liaison";
      liaisonHost = document.createElement("div");
      const host = liaisonHost;
      liaisonTrigger.addEventListener("click", () => {
        host.hidden = !host.hidden;
        liaisonTrigger?.setAttribute("aria-expanded", String(!host.hidden));
        liaisonPanel?.refresh();
      });
      liaisonTrigger.setAttribute("aria-expanded", "true");
      chatHost.append(liaisonTrigger, host);
      liaisonPanel = mountLiaisonPanel(host, {
        controller, getContext: getLiaisonContext,
        getChatHandle: context => {
          const current = wall?.selection?.();
          return current?.room === context.room && current.taskId === context.task_id
            ? wall?.chat?.() ?? undefined : undefined;
        },
        // Explicit human action activates the existing delivery control; the
        // wall retains recipient validation, deduplication and receipts.
        onSend: context => {
          const current = wall?.selection?.();
          if (current?.room !== context.room || current.taskId !== context.task_id) return;
          chatHost.querySelector<HTMLButtonElement>(".chat-send")?.click();
        },
        onPlan: () => wallHost.querySelector<HTMLButtonElement>('[data-nav="wall"]')?.click(),
        onMemory: () => wallHost.querySelector<HTMLButtonElement>('[data-nav="memory"]')?.click(),
        trigger: liaisonTrigger,
      });
    } else {
      liaisonPanel?.refresh();
    }
  };
  const offLiaisonSelection = wall.onSelection?.(() => refreshLiaison()) ?? (() => undefined);
  refreshLiaison();
  const teardown = (): void => {
    if (pageClosed) return;
    pageClosed = true;
    offLiaisonSelection();
    clearLiaison();
    refreshLiaison = () => undefined;
    refreshModelsWall = () => undefined;
    offModelSheet?.();
    sheet.dispose?.();
    modelAnnouncementsClosed = true;
    modelAnnouncements.clear();
    try { wall?.destroy(); } finally { link.stop(); }
    window.removeEventListener("pagehide", teardown);
  };
  window.addEventListener("pagehide", teardown);
  // The first render has already built the rail; anchor the boot controls.
  // Later re-renders are covered by the MutationObserver above.
  ensureBootControls();
  link.start();
}

/* ------------------------------------------------------------------ */
/* U52 Models sheet (W2-R): snapshot from the registry, intents through */
/* the services feed; host presence follows model_hello on the port.    */
/* ------------------------------------------------------------------ */

let hostPresent = false;
const sheetMount = document.createElement("div");
root.appendChild(sheetMount);
// Keep the live region outside the sheet so outcomes remain audible after it closes.
const modelStatus = document.createElement("div");
modelStatus.className = "model-announcer visually-hidden";
modelStatus.setAttribute("role", "status");
modelStatus.setAttribute("aria-live", "polite");
modelStatus.setAttribute("aria-atomic", "true");
root.appendChild(modelStatus);
let modelAnnouncementsClosed = false;
let modelAnnouncementScheduled = false;
let modelAnnouncementCount = 0;
const modelAnnouncements = new Set<string>();
const modelAnnouncer: Announcer = {
  say(_key, text): void {
    if (modelAnnouncementsClosed || text === "") return;
    modelAnnouncements.add(text);
    if (modelAnnouncementScheduled) return;
    modelAnnouncementScheduled = true;
    // Populate only after mounting, batching related outcomes into one polite update.
    queueMicrotask(() => {
      modelAnnouncementScheduled = false;
      if (modelAnnouncementsClosed || !modelStatus.isConnected) {
        modelAnnouncements.clear();
        return;
      }
      const message = [...modelAnnouncements].join("; ");
      modelAnnouncements.clear();
      if (modelStatus.textContent === message) return;
      modelStatus.textContent = message;
      modelAnnouncementCount += 1;
    });
  },
  flushedCount: (): number => modelAnnouncementCount,
};

const roomPolicyNotice = document.createElement("p");
roomPolicyNotice.className = "model-room-policy";
roomPolicyNotice.id = "model-room-policy";
roomPolicyNotice.setAttribute("role", "status");

function renderSheet(): void {
  if (!sheetReady) return;
  const unavailableProviders: ProviderDescriptor[] = FIREBASE_IDS.map(id => ({
    id, kind: id, label: id, health: "needs_setup",
  }));
  sheet.render({
    providers: services !== null ? services.registry.list() : unavailableProviders,
    selection: services !== null ? services.sheet().selection() : {},
    device: services !== null ? services.sheet().device() : { state: "not_initialised" },
    hostPresent,
  });
  roomPolicyNotice.textContent = modelAvailability();
  const dialog = sheetMount.querySelector<HTMLElement>("#model-sheet");
  dialog?.setAttribute("aria-describedby", roomPolicyNotice.id);
  if (roomPolicyNotice.parentElement !== dialog) dialog?.querySelector(".model-sheet-head")?.after(roomPolicyNotice);
}

const sheet = createModelSheet({
  doc: document,
  mount: sheetMount,
  announcer: modelAnnouncer,
  onIntent(i: ModelSheetIntent): void {
    if (services === null) return;
    if (i.t === "select") {
      const cur = services.sheet().selection();
      const next: ModelSelection = i.scope === "all"
        ? { ...cur, all: i.id }
        : { ...cur, groups: { ...(cur.groups ?? {}), [i.scope]: i.id } };
      services.sheet().select(next);
      renderSheet();
    } else if (i.t === "reset") {
      services.sheet().reset();
      renderSheet();
    } else {
      void services.registry.refresh().then(() => { renderSheet(); refreshModelsWall(); });
      renderSheet();
    }
  },
});

modelBus.onFrame((f: unknown) => {
  if (typeof f !== "object" || f === null) return;
  const rec = f as Record<string, unknown>;
  const t = rec["t"];
  // Only an unsolicited hello announces the host; rid'd hellos are list
  // replies owned by the transport (refreshing on them would loop forever).
  if (t === "model_hello" && Array.isArray(rec["endpoints"])) {
    hostPresent = true;
    if (rec["rid"] === undefined) {
      void services?.registry.refresh().then(() => { renderSheet(); refreshModelsWall(); });
      renderSheet();
    }
  } else if (t === "model_nack" && rec["code"] === "host_absent") {
    hostPresent = false;
    renderSheet();
  }
});
modelBus.onReset(() => {
  hostPresent = false;
  renderSheet();
});

sheetReady = true;
renderSheet();

if (!isPlaceholderConfig(env.firebaseConfig)) {
  void boot(env, fbPorts, hyPort, (s: HostState) => {
    deviceModelState = "deviceModel" in s ? s.deviceModel : undefined;
    renderHostState(stateRoot, s);
  });
}
