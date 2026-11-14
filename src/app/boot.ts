import { isLocalDevOrigin } from "./appcheck";
import { isPlaceholderConfig, isPlaceholderValue } from "./firebase-config.public";
import type { AppCheckKind, DeviceModelState, FirebasePorts, HostEnv, HostState, HybridPort } from "./types";

/** Bounds for injected async waits; a pending port must not stall boot/activation forever. */
const AUTH_LISTENER_TIMEOUT_MS = 10_000;
const SIGN_IN_TIMEOUT_MS = 15_000;
const GOOGLE_SIGN_IN_TIMEOUT_MS = 30_000;
const DEVICE_MODEL_TIMEOUT_MS = 60_000;

interface BootCtx {
  hy: HybridPort | null;
  fb: FirebasePorts | null;
  auth: unknown;
  onState: ((s: HostState) => void) | null;
  appCheck: AppCheckKind | null;
  uid: string | null;
  isAnonymous: boolean;
  bootDone: boolean;
  deviceModel: DeviceModelState;
  deviceModelProgress: number | null;
  degraded: boolean;
  blocked: boolean;
}

function freshCtx(): BootCtx {
  return {
    hy: null,
    fb: null,
    auth: null,
    onState: null,
    appCheck: null,
    uid: null,
    isAnonymous: false,
    bootDone: false,
    deviceModel: "idle",
    deviceModelProgress: null,
    degraded: false,
    blocked: false,
  };
}

/** Current boot context; async continuations capture their own context + generation and check still-current. */
let ctx: BootCtx = freshCtx();
/** Bumped by every boot/reset; a continuation whose generation is stale must not emit or mutate. */
let generation = 0;
/** Per-page owner of the B8 one-shot device initialisation; survives repeated boots. */
let pageDeviceAttempted = false;

function emitBlocked(
  onState: (s: HostState) => void,
  reason: Extract<HostState, { kind: "blocked" }>["reason"],
): HostState {
  const s: HostState = { kind: "blocked", reason };
  onState(s);
  return s;
}

function stateOf(c: BootCtx): HostState | null {
  if (c.appCheck === null) return null;
  const progress = c.deviceModelProgress;
  if (c.degraded) {
    const base = { kind: "degraded", reason: "AUTH_FAILED", appCheck: c.appCheck, deviceModel: c.deviceModel } as {
      kind: "degraded"; reason: "AUTH_FAILED"; appCheck: AppCheckKind; deviceModel: DeviceModelState; deviceModelProgress?: number
    };
    if (progress !== null) base.deviceModelProgress = progress;
    return base;
  }
  if (c.uid === null) return null;
  const base = {
    kind: "ready",
    uid: c.uid,
    isAnonymous: c.isAnonymous,
    appCheck: c.appCheck,
    deviceModel: c.deviceModel,
  } as { kind: "ready"; uid: string; isAnonymous: boolean; appCheck: AppCheckKind; deviceModel: DeviceModelState; deviceModelProgress?: number };
  if (progress !== null) base.deviceModelProgress = progress;
  return base;
}

function pushState(c: BootCtx): void {
  if (c.onState === null) return;
  const s = stateOf(c);
  if (s !== null) c.onState(s);
}

/** Races a promise against a timeout; rejection carries a synthetic reason. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("operation timed out"));
    }, ms);
    void p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Resolves with the first auth-state callback (or null). Always unsubscribes,
 * including on timeout; on timeout the promise rejects (boot degrades).
 */
async function resolveExistingUser(
  fb: FirebasePorts,
  auth: unknown,
): Promise<{ uid: string; isAnonymous: boolean } | null> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsub: (() => void) | null = null;
    const cleanup = (): void => {
      if (unsub !== null) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("auth listener timed out"));
    }, AUTH_LISTENER_TIMEOUT_MS);
    try {
      unsub = fb.onAuthStateChanged(auth, (u) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        resolve(u);
      });
      // Callback fired synchronously during registration: unsubscribe now.
      if (done) cleanup();
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

export async function boot(
  env: HostEnv,
  fb: FirebasePorts,
  hy: HybridPort,
  onState: (s: HostState) => void,
): Promise<HostState> {
  const myGen = ++generation;
  const my = freshCtx();
  my.hy = hy;
  my.fb = fb;
  my.onState = onState;
  ctx = my;
  const isCurrent = (): boolean => generation === myGen && ctx === my;
  onState({ kind: "booting" });

  // Fail-closed guards before any port call.
  if (env.mode === "prod") {
    if (isPlaceholderConfig(env.firebaseConfig)) {
      my.blocked = true;
      return emitBlocked(onState, "CONFIG_INVALID");
    }
    const key = env.recaptchaSiteKey;
    if (key === undefined || key.trim() === "") {
      my.blocked = true;
      return emitBlocked(onState, "MISSING_RECAPTCHA_KEY");
    }
    if (isPlaceholderValue(key)) {
      my.blocked = true;
      return emitBlocked(onState, "CONFIG_INVALID");
    }
    if (env.debugToken !== undefined) {
      my.blocked = true;
      return emitBlocked(onState, "DEBUG_IN_PROD");
    }
  } else if (env.debugToken !== undefined && !isLocalDevOrigin(env.origin)) {
    my.blocked = true;
    return emitBlocked(onState, "DEBUG_ON_PUBLIC_ORIGIN");
  }

  let app: unknown;
  try {
    app = fb.initializeApp(env.firebaseConfig);
  } catch {
    my.blocked = true;
    return emitBlocked(onState, "CONFIG_INVALID");
  }

  let appCheckKind: AppCheckKind;
  try {
    if (env.mode === "dev" && env.debugToken !== undefined) {
      fb.setDebugFlag(env.debugToken);
    }
    if (env.mode === "prod") {
      const provider = fb.newRecaptchaEnterpriseProvider(env.recaptchaSiteKey ?? "");
      appCheckKind = "recaptcha_enterprise";
      fb.initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    } else {
      const provider = fb.newDebugCompatibleProvider();
      appCheckKind = "debug";
      fb.initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    }
  } catch {
    my.blocked = true;
    return emitBlocked(onState, "APPCHECK_INIT_FAILED");
  }
  my.appCheck = appCheckKind;

  // Auth: reuse an existing user, else anonymous once. Failure -> degraded, AI still created.
  let auth: unknown;
  let uid: string | null = null;
  let isAnonymous = false;
  let authFailed = false;
  try {
    auth = fb.getAuth(app);
    my.auth = auth;
    const existing = await resolveExistingUser(fb, auth);
    if (!isCurrent()) return { kind: "booting" };
    if (existing !== null) {
      uid = existing.uid;
      isAnonymous = existing.isAnonymous;
    } else {
      try {
        const res = await withTimeout(fb.signInAnonymously(auth), SIGN_IN_TIMEOUT_MS);
        if (!isCurrent()) return { kind: "booting" };
        uid = res.uid;
        isAnonymous = true;
      } catch {
        authFailed = true;
      }
    }
  } catch {
    authFailed = true;
  }
  if (!isCurrent()) return { kind: "booting" };

  if (authFailed) {
    my.degraded = true;
    my.uid = null;
    my.bootDone = true;
    my.deviceModel = "idle";
    try {
      hy.create(app, { useLimitedUseAppCheckTokens: env.useLimitedUseTokens });
    } catch {
      // factory throwing still leaves the degraded state; boot must not reject.
    }
    const s: HostState = { kind: "degraded", reason: "AUTH_FAILED", appCheck: appCheckKind, deviceModel: "idle" };
    onState(s);
    return s;
  }

  my.uid = uid ?? "";
  my.isAnonymous = isAnonymous;
  my.degraded = false;
  my.bootDone = true;
  my.deviceModel = "idle";

  try {
    hy.create(app, { useLimitedUseAppCheckTokens: env.useLimitedUseTokens });
  } catch {
    my.blocked = true;
    return emitBlocked(onState, "CONFIG_INVALID");
  }

  const ready: HostState = {
    kind: "ready",
    uid: my.uid,
    isAnonymous: my.isAnonymous,
    appCheck: appCheckKind,
    deviceModel: "idle",
  };
  onState(ready);
  return ready;
}

/** B8: initializeDeviceModel only when trusted === true, at most once per page load, only after a ready/degraded boot. */
export async function onUserActivation(trusted: boolean): Promise<void> {
  if (!trusted) return;
  const my = ctx;
  const myGen = generation;
  if (!my.bootDone || my.blocked || pageDeviceAttempted) return;
  if (my.hy === null) return;
  pageDeviceAttempted = true;
  my.deviceModel = "initializing";
  my.deviceModelProgress = null;
  // The initializing state is emitted by progress callbacks (and by the final
  // initialized/failed transition), not by a duplicate state here.
  const hy = my.hy;
  try {
    await withTimeout(
      hy.initializeDeviceModel((v) => {
        if (generation !== myGen || ctx !== my) return;
        const clamped = Math.min(1, Math.max(0, v));
        if (my.deviceModelProgress === clamped) return;
        my.deviceModelProgress = clamped;
        pushState(my);
      }),
      DEVICE_MODEL_TIMEOUT_MS,
    );
    if (generation !== myGen || ctx !== my) return;
    my.deviceModel = "initialized";
    my.deviceModelProgress = null;
    pushState(my);
  } catch {
    if (generation !== myGen || ctx !== my) return;
    my.deviceModel = "failed";
    my.deviceModelProgress = null;
    pushState(my);
  }
}

/** B7: signInWithGooglePopup only when trusted === true and a boot has completed. Updates host identity on success. */
export async function onGoogleSignIn(trusted: boolean): Promise<void> {
  if (!trusted) return;
  const my = ctx;
  const myGen = generation;
  if (!my.bootDone || my.blocked) return;
  if (my.fb === null || my.auth === null) return;
  const fb = my.fb;
  const auth = my.auth;
  try {
    const res = await withTimeout(fb.signInWithGooglePopup(auth), GOOGLE_SIGN_IN_TIMEOUT_MS);
    if (generation !== myGen || ctx !== my) return;
    my.uid = res.uid;
    my.isAnonymous = false;
    my.degraded = false;
    pushState(my);
  } catch {
    /* google failure stays anonymous; never rejects the caller */
  }
}

/** TEST ONLY: clears module-level boot state, including the per-page activation guard. */
export function resetBootStateForTests(): void {
  generation++;
  ctx = freshCtx();
  pageDeviceAttempted = false;
}
