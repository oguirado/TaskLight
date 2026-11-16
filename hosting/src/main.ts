/// <reference types="vite/client" />
// U38 G4: the hosted wall loads its stylesheets (tokens first, wall before
// views so views win the cascade, agents last).
import "../../styles/tokens.css";
import "../../styles/wall.css";
import "../../styles/views.css";
import "../../styles/plan.css";
import "../../styles/model_selector.css";
import "../../styles/agents.css";
import { boot, onGoogleSignIn, onUserActivation } from "../../src/app/boot";
import { createConnector } from "../../src/app/connector";
import { createAgentLink } from "../../src/app/agent_link";
import { createAgentStore } from "../../src/app/agent_store";
import { createDriftReviewer, driftPortFromFactory } from "../../src/app/agent_drift";
import { createPlanWiring } from "../../src/app/plan_wiring";
import type { PlanWiring, RoomPlanSnapshot } from "../../src/app/plan_wiring";
import { getTemplateMemorySections } from "../../src/app/starter_templates";
import type { DriftVerdict } from "../../src/agents/types";
import type { PlanProjectionResult } from "../../src/app/agent_store";
import type { PlanMicrotask, PlanTask } from "../../src/plan";
import { createModelServices } from "../../src/app/model_services";
import type { ModelServices } from "../../src/app/model_services";
import { attachModelChannel } from "../../src/app/model_port";
import type { ModelChannel } from "../../src/app/model_port";
import { createModelSheet } from "../../src/ui/model_selector";
import type { ModelSheetIntent } from "../../src/ui/model_selector";
import type { ModelSelection } from "../../src/providers/types";
import { startAgentWall } from "../../src/app/agent_wall";
import type { AgentWall } from "../../src/app/agent_wall";
import { isPlaceholderConfig } from "../../src/app/firebase-config.public";
import { readHostEnv } from "../../src/app/index";
import { renderHostState } from "../../src/app/ui";
import type { Clock, FirebasePorts, HybridPort, HostState, RuntimePort } from "../../src/app/types";
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
/** U52 model services; built inside hy.create, null when construction fails (F4). */
let services: ModelServices | null = null;
let offModelSheet: (() => void) | undefined;
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
        offModelSheet = services.sheet().subscribe(renderSheet);
        renderSheet();
      } catch {
        services = null;
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
  const store = createAgentStore();
  const roomFloors = new Map<string, string>();
  let wall: AgentWall | undefined;
  const templateMemorySections = (templateId: string) => {
    try {
      const sections = getTemplateMemorySections(templateId);
      if (sections === undefined) return undefined;
      return sections.map((s) => ({ id: s.id, label: s.label, required: s.required, max_chars: s.maxChars }));
    } catch {
      return undefined;
    }
  };
  const getSnapshots = (): readonly RoomPlanSnapshot[] => {
    try {
      const plans: PlanProjectionResult[] = typeof store.plans === "function" ? store.plans() : [];
      const out: RoomPlanSnapshot[] = [];
      for (const entry of Array.isArray(plans) ? plans : []) {
        try {
          const projection = entry.projection;
          const plan = projection?.plan ?? null;
          const srcTasks: readonly PlanTask[] = Array.isArray(projection?.tasks) ? projection.tasks : [];
          let doneMicrotasks = 0;
          let totalMicrotasks = 0;
          const tasks = srcTasks.map((t: PlanTask) => {
            const micros: readonly PlanMicrotask[] = Array.isArray(t.microtasks) ? t.microtasks : [];
            totalMicrotasks += micros.length;
            for (const m of micros) if (m?.state === "done") doneMicrotasks += 1;
            return {
              id: t.id,
              title: t.title,
              type: t.type,
              phase: t.phase,
              accept: t.accept,
              status: t.state,
              deps: Array.isArray(t.deps) ? [...t.deps] : [],
              rev: typeof t.rev === "number" ? t.rev : 0,
              microtasks: micros.map((m: PlanMicrotask) => {
                const micro: { id: string; text: string; state: PlanMicrotask["state"]; accept?: string; outcome?: string } = {
                  id: m.id,
                  text: m.text,
                  state: m.state,
                };
                if (typeof m.accept === "string" && m.accept.length > 0) micro.accept = m.accept;
                if (typeof m.outcome === "string" && m.outcome.length > 0) micro.outcome = m.outcome;
                return micro;
              }),
            };
          });
          const snap: RoomPlanSnapshot = {
            room: entry.room,
            planId: plan?.id ?? "p1",
            title: plan?.title ?? "",
            phase: plan?.phase ?? "plan",
            status: plan?.state ?? "active",
            rev: typeof plan?.rev === "number" ? plan.rev : 0,
            doneMicrotasks,
            totalMicrotasks,
            tasks,
          };
          const mem = projection?.memory;
          if (mem !== null && typeof mem === "object") {
            const ids = Object.keys(mem).sort();
            if (ids.length > 0) {
              const first = mem[ids[0] as string];
              if (first !== undefined) {
                const meta = plan?.template_id !== undefined ? getTemplateMemorySections(plan.template_id)?.find((s) => s.id === first.id) : undefined;
                snapWithMemory(snap, { id: first.id, label: meta?.label ?? first.id, text: first.text, rev: typeof first.rev === "number" ? first.rev : 0 });
              }
            }
          }
          out.push(snap);
        } catch {
          /* skip malformed plan entries */
        }
      }
      return out;
    } catch {
      return [];
    }
  };
  function snapWithMemory(snap: RoomPlanSnapshot, memory: NonNullable<RoomPlanSnapshot["memorySection"]>): void {
    (snap as unknown as Record<string, unknown>)["memorySection"] = memory;
  }
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
      onUpdate: () => wall?.refresh(),
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
    since: () => store.since(),
    onRoomEvent: (frame) => {
      roomFloors.set(frame.room, frame.floor);
      store.ingest(frame.event);
      notifyPlan();
      wall?.refresh();
    },
    onRoomHello: (frame) => {
      for (const room of frame.rooms) roomFloors.set(room.room, room.floor);
      notifyPlan();
      wall?.refresh();
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
  wall = startAgentWall({ wallHost, chatHost, link, store, reviewer, clock: wallClock, userAgent: "wall-user", planVerdicts, planBriefs, templateMemorySections });
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
const silentAnnouncer = {
  say: (): void => undefined,
  flushedCount: (): number => 0,
};

function renderSheet(): void {
  sheet.render({
    providers: services !== null ? services.registry.list() : [],
    selection: services !== null ? services.sheet().selection() : {},
    device: services !== null ? services.sheet().device() : { state: "not_initialised" },
    hostPresent,
  });
}

const sheet = createModelSheet({
  doc: document,
  mount: sheetMount,
  announcer: silentAnnouncer,
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
      void services.registry.refresh().then(() => renderSheet());
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
      void services?.registry.refresh().then(() => renderSheet());
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

const sheetTrigger = document.createElement("button");
sheetTrigger.type = "button";
sheetTrigger.className = "status-line";
sheetTrigger.setAttribute("aria-controls", "model-sheet");
sheetTrigger.setAttribute("aria-expanded", "false");
sheetTrigger.addEventListener("click", () => {
  services?.sheet().onOpen();
  sheet.open(sheetTrigger);
  renderSheet();
});
const ensureSheetTrigger = (): void => {
  const railStatus = root.querySelector(".rail-status");
  if (railStatus !== null) {
    if (sheetTrigger.parentNode !== railStatus) railStatus.appendChild(sheetTrigger);
  } else if (sheetTrigger.parentNode !== root) {
    root.appendChild(sheetTrigger);
  }
};
ensureSheetTrigger();
new MutationObserver(ensureSheetTrigger).observe(root, { childList: true, subtree: true });
renderSheet();

if (!isPlaceholderConfig(env.firebaseConfig)) {
  void boot(env, fbPorts, hyPort, (s: HostState) => {
    renderHostState(stateRoot, s);
  });
}
