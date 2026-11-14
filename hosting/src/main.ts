/// <reference types="vite/client" />
// U38 G4: the hosted wall loads its stylesheets (tokens first, wall before
// views so views win the cascade, agents last).
import "../../styles/tokens.css";
import "../../styles/wall.css";
import "../../styles/views.css";
import "../../styles/agents.css";
import { boot, onGoogleSignIn, onUserActivation } from "../../src/app/boot";
import { createConnector } from "../../src/app/connector";
import { createAgentLink } from "../../src/app/agent_link";
import { createAgentStore } from "../../src/app/agent_store";
import { createDriftReviewer, driftPortFromFactory } from "../../src/app/agent_drift";
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
    },
    initializeDeviceModel: async (onProgress) => {
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
  const wallClock: Clock = {
    now: () => Date.now(),
    // Global timers are numbers in the browser; under Node they are Timeout objects.
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id) => clearInterval(id as unknown as ReturnType<typeof setInterval>),
  };
  const store = createAgentStore();
  let wall: AgentWall | undefined;
  const link = createAgentLink({
    extId,
    connect: (id) =>
      (globalThis as unknown as { chrome: { runtime: { connect(c: string): RuntimePort } } }).chrome.runtime.connect(id),
    clock: wallClock,
    since: () => store.since(),
    onRoomEvent: (frame) => {
      store.ingest(frame.event);
      wall?.refresh();
    },
    onRoomHello: () => {
      wall?.refresh();
    },
  });
  const reviewer = WIRE_REAL
    ? createDriftReviewer({
        port: (mode) => {
          if (driftFactory === null) throw new Error("drift factory unavailable");
          return driftPortFromFactory(driftFactory, mode);
        },
      })
    : createDriftReviewer({});
  wall = startAgentWall({ wallHost, chatHost, link, store, reviewer, clock: wallClock, userAgent: "wall-user" });
  // The first render has already built the rail; anchor the boot controls.
  // Later re-renders are covered by the MutationObserver above.
  ensureBootControls();
  link.start();
}

if (!isPlaceholderConfig(env.firebaseConfig)) {
  void boot(env, fbPorts, hyPort, (s: HostState) => {
    renderHostState(stateRoot, s);
  });
}
