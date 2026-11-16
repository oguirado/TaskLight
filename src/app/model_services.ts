// U52 composition: registry at boot, flags, ledger, sheet feed (SPEC_U52 section 4.2).
import { createHybrid } from "../ai/hybrid";
import { driftPortFromFactory } from "./agent_drift";
import { createFrameSelectionStore, createPageModelTransport } from "./model_port";
import type { ModelChannel, SelectionStore } from "./model_port";
import { createProviderRegistry } from "../providers/registry";
import { externalProvidersPolicy, parseProviderFlags, PROVIDER_FLAG_SPECS } from "../config/keys";
import type { ModelFactory, Hybrid, DeviceStatus, ModeName } from "../ai/types";
import type { Clock as ProvidersClock, ProviderRegistry, ProviderDescriptor, ModelSelection } from "../providers/types";
import type { PrivacyTier } from "../schema";
import type { AiSink, RemoteConfigPort, LiveConfig } from "../config/types";
import type { ClassifierPort } from "../router/types";
import type { DriftPort } from "../agents";
import type { LedgerCounter, ExternalLedgerCounter, LedgerPort } from "../reconcile/types";

export interface ModelSheetFeed {
  descriptors(): readonly ProviderDescriptor[];
  selection(): ModelSelection;
  device(): DeviceStatus;
  select(s: ModelSelection): void;
  reset(): void;
  onOpen(): void;
  subscribe(cb: () => void): () => void;
}

export interface ModelServicesDeps {
  factory: ModelFactory; origin: string; clock: ProvidersClock;
  channel?: ModelChannel; rc?: RemoteConfigPort; live?: LiveConfig; selectionStore?: SelectionStore;
}

export interface ModelServices {
  registry: ProviderRegistry;
  hybrid(): Hybrid;
  aiSink(): AiSink;
  classifier(tier: PrivacyTier): ClassifierPort;
  driftPortFor(mode: ModeName): { port: DriftPort; allowExternal: boolean };
  ledger(base: { inc(c: LedgerCounter): void }): LedgerPort;
  externalCounts(): Readonly<Record<ExternalLedgerCounter, number>>;
  sheet(): ModelSheetFeed;
  refreshFlags(): void;
  dispose(): void;
}

export function createModelServices(d: ModelServicesDeps): ModelServices {
  let disposed = false;
  let selectionRevision = 0;
  const sheetListeners = new Set<() => void>();
  const publish = (): void => {
    if (disposed) return;
    for (const cb of [...sheetListeners]) {
      try { cb(); } catch { /* isolate subscribers */ }
    }
  };
  const refreshRegistry = async (): Promise<ProviderDescriptor[]> => {
    try { return await registry.refresh(); } finally { publish(); }
  };
  const factory = d.factory;
  const baseHybrid = createHybrid({ factory, origin: d.origin, appCheckReady: true, config: {} });
  const hybrid: Hybrid = {
    ...baseHybrid,
    // Observe the underlying attempt even after a registry status bound returns.
    initDevice: async (onProgress) => {
      try {
        const attempt = baseHybrid.initDevice((progress) => { publish(); onProgress?.(progress); });
        publish();
        return await attempt;
      } finally { publish(); }
    },
  };
  const makeHybrid = (o: Partial<import("../ai/types").AiConfig>): Hybrid =>
    createHybrid({ factory, origin: d.origin, appCheckReady: true, config: o });

  // U93: liaison shares the schema-constrained Firebase text channel (same closed schema to both model channels).
  const firebaseText = (req: { task: "route" | "drift" | "liaison"; mode: ModeName; prompt: string; schema: object; signal: AbortSignal }): Promise<{ text: string; source: "ON_DEVICE" | "IN_CLOUD" }> =>
    driftPortFromFactory(factory, req.mode).generate(req.prompt, req.schema, req.signal).then((r) => ({
      text: r.text,
      source: (r.source === "device" ? "ON_DEVICE" : "IN_CLOUD") as "ON_DEVICE" | "IN_CLOUD",
    }));

  let registry: ProviderRegistry;
  const transport = d.channel === undefined
    ? undefined
    : createPageModelTransport(d.channel, d.clock, () => {
      if (disposed) return;
      try {
        const r = refreshRegistry();
        if (r !== undefined && typeof (r as { then?: unknown }).then === "function") {
          void Promise.resolve(r as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        /* contained: host refresh must not break frame handling */
      }
    });

  const ownedStore = d.selectionStore === undefined && d.channel !== undefined
    ? createFrameSelectionStore(d.channel, d.clock) : undefined;
  const selectionStore: SelectionStore | undefined = d.selectionStore ?? ownedStore;

  registry = createProviderRegistry({
    hybrid,
    makeHybrid,
    ...(transport === undefined ? {} : { transport }),
    clock: d.clock,
    firebaseText,
  });

  let selection: ModelSelection = {};
  const copySelection = (s: ModelSelection): ModelSelection => {
    const out: ModelSelection = {};
    if (typeof s.all === "string") out.all = s.all;
    if (typeof s.groups === "object" && s.groups !== null) out.groups = { ...s.groups };
    return out;
  };
  let offSelection: (() => void) | null = null;
  if (selectionStore !== undefined) {
    const revAtLoad = selectionRevision;
    try {
      const initial = selectionStore.get();
      void Promise.resolve(initial).then(
        (s) => {
          if (disposed || selectionRevision !== revAtLoad) return;
          try {
            selection = copySelection(s);
            registry.select(copySelection(s));
            publish();
          } catch {
            /* contained */
          }
        },
        () => undefined,
      );
    } catch {
      /* contained: synchronous store failure must not break construction */
    }
    try {
      offSelection = selectionStore.onChange((s) => {
        if (disposed) return;
        selectionRevision += 1;
        try {
          selection = copySelection(s);
          registry.select(copySelection(s));
          publish();
        } catch {
          /* contained */
        }
      });
    } catch {
      offSelection = null;
    }
  }

  const select = (s: ModelSelection): void => {
    if (disposed) return;
    selection = copySelection(s);
    selectionRevision += 1;
    registry.select(copySelection(s));
    publish();
    if (selectionStore !== undefined) {
      try {
        const r = selectionStore.set(copySelection(s));
        if (r !== undefined && typeof (r as { then?: unknown }).then === "function") {
          void Promise.resolve(r as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        /* contained */
      }
    }
  };

  // Flags (U50 handoff): parse + kill switch, then push the policy into the registry.
  let prevFlags: import("../config/types").ProviderFlags | undefined;
  let prevKill = false;
  let gatesNow = { externalEnabled: true, remoteEnabled: true, killSwitchCloud: false };
  const applyPolicy = (flags: import("../config/types").ProviderFlags, kill: boolean): void => {
    const p = externalProvidersPolicy({ ...flags, kill_switch_cloud: kill });
    gatesNow = { externalEnabled: p.local, remoteEnabled: p.remote, killSwitchCloud: kill };
    registry.applyRemoteConfig({}, { externalEnabled: p.local, remoteEnabled: p.remote, killSwitchCloud: kill });
    publish();
  };
  // The core list() reports probe health only; the composition layer overlays
  // the RC gates (mirroring resolve) so gated endpoints read as blocked.
  const overlayList = (list: readonly ProviderDescriptor[]): readonly ProviderDescriptor[] =>
    list.map((d) => {
      if (d.health === "blocked") return d;
      if (d.kind === "local-openai-compatible" && !gatesNow.externalEnabled) {
        return { ...d, health: "blocked" as const, blockedReason: "remote_config" as const };
      }
      if (d.kind === "remote-openai-compatible"
        && (!gatesNow.externalEnabled || !gatesNow.remoteEnabled || gatesNow.killSwitchCloud)) {
        return { ...d, health: "blocked" as const, blockedReason: "remote_config" as const };
      }
      return d;
    });
  const publicRegistry: ProviderRegistry = {
    refresh: refreshRegistry,
    list: () => overlayList(registry.list()),
    select,
    applyRemoteConfig: (c, g) => { registry.applyRemoteConfig(c, g); publish(); },
    resolve: (t, tier) => registry.resolve(t, tier),
    initDevice: async (p) => {
      try {
        const attempt = registry.initDevice((progress) => { publish(); p?.(progress); });
        publish();
        return await attempt;
      } finally { publish(); }
    },
    generate: async (r) => { try { return await registry.generate(r); } finally { publish(); } },
    asHybrid: () => {
      const view = registry.asHybrid();
      return {
        ...view,
        initDevice: (p) => publicRegistry.initDevice(p),
        run: async (req) => { try { return await view.run(req); } finally { publish(); } },
        applyConfig: (c) => { try { return view.applyConfig(c); } finally { publish(); } },
      };
    },
    asClassifierPort: (t) => async (req) => {
      try { return await registry.asClassifierPort(t)(req); } finally { publish(); }
    },
    asDriftPort: (t) => ({
      generate: async (prompt, schema, signal, room) => {
        try {
          const port = registry.asDriftPort(t);
          return await (room !== undefined
            ? port.generate(prompt, schema, signal, room)
            : port.generate(prompt, schema, signal));
        }
        finally { publish(); }
      },
    }),
  };
  const refreshFlags = (): void => {
    const rc = d.rc;
    const get = (k: string): string => {
      if (rc === undefined) return "";
      try {
        return rc.getString(k);
      } catch {
        return "";
      }
    };
    const { flags } = parseProviderFlags((k) => get(k), prevFlags);
    prevFlags = flags;
    const rawKill = get("kill_switch_cloud");
    const kill = rawKill === "true" ? true : rawKill === "false" ? false : prevKill;
    prevKill = kill;
    try {
      applyPolicy(flags, kill);
    } catch {
      /* contained: flag application must not break listeners */
    }
  };

  let offRc: (() => void) | null = null;
  if (d.rc !== undefined) {
    try {
      offRc = d.rc.onConfigUpdate({
        next(updatedKeys: ReadonlySet<string>): void {
          try {
            const flagKeys: readonly string[] = Object.keys(PROVIDER_FLAG_SPECS);
            for (const k of updatedKeys) {
              if (k === "kill_switch_cloud" || flagKeys.includes(k)) {
                try {
                  const act = d.rc?.activate();
                  if (act !== undefined && typeof (act as { then?: unknown }).then === "function") {
                    void Promise.resolve(act as Promise<unknown>).then(
                      () => { if (!disposed) refreshFlags(); },
                      () => undefined,
                    );
                  } else if (!disposed) {
                    refreshFlags();
                  }
                } catch {
                  if (!disposed) refreshFlags();
                }
                return;
              }
            }
          } catch {
            /* contained */
          }
        },
        error(): void { /* contained */ },
        complete(): void { /* contained */ },
      });
    } catch {
      offRc = null;
    }
  }

  let offLive: (() => void) | null = null;
  if (d.live !== undefined) {
    try {
      const started = d.live.start();
      if (started !== undefined && typeof (started as { then?: unknown }).then === "function") {
        void Promise.resolve(started as Promise<unknown>).then(
          () => { if (!disposed) refreshFlags(); },
          () => undefined,
        );
      } else if (!disposed) {
        try {
          refreshFlags();
        } catch {
          /* contained */
        }
      }
    } catch {
      /* contained */
    }
    try {
      offLive = d.live.subscribe(() => {
        if (disposed) return;
        try {
          refreshFlags();
        } catch {
          /* contained */
        }
      });
    } catch {
      offLive = null;
    }
  }

  try {
    refreshFlags();
  } catch {
    /* contained */
  }

  const externalCounts: Record<ExternalLedgerCounter, number> = { local_server: 0, remote_provider: 0 };
  const sheetFeed: ModelSheetFeed = {
    descriptors: () => publicRegistry.list(),
    selection: () => copySelection(selection),
    device: () => {
      try {
        return registry.asHybrid().deviceStatus();
      } catch {
        return { state: "not_initialised" } as DeviceStatus;
      }
    },
    select: (s: ModelSelection) => {
      select(s);
      publish();
    },
    reset: () => {
      select({});
      publish();
    },
    onOpen: () => {
      refreshFlags();
      publish();
    },
    subscribe: (cb: () => void): (() => void) => {
      sheetListeners.add(cb);
      return () => {
        sheetListeners.delete(cb);
      };
    },
  };

  return {
    registry: publicRegistry,
    hybrid: () => publicRegistry.asHybrid(),
    // Same as asHybrid(), plus a kill_switch_cloud patch is mirrored into the
    // registry gates so the firebase-text drift mode table observes it.
    aiSink: () => ({
      applyConfig: (c: Partial<import("../ai/types").AiConfig>): { configGen: number; warnings: string[] } => {
        const r = publicRegistry.asHybrid().applyConfig(c);
        if (c.kill_switch_cloud !== undefined) {
          prevKill = c.kill_switch_cloud === true;
          applyPolicy(prevFlags ?? { external_providers_enabled: true, remote_providers_enabled: true }, prevKill);
        }
        return r;
      },
    }),
    classifier: (tier: PrivacyTier) => publicRegistry.asClassifierPort(tier),
    driftPortFor: (mode: ModeName) => {
      const tier: PrivacyTier = mode === "ONLY_ON_DEVICE" ? "private" : "standard";
      return { port: publicRegistry.asDriftPort(tier), allowExternal: mode === "PREFER_ON_DEVICE" };
    },
    ledger: (base: { inc(c: LedgerCounter): void }): LedgerPort => ({
      inc: (c: LedgerCounter) => {
        base.inc(c);
      },
      incExternal: (c: ExternalLedgerCounter) => {
        externalCounts[c] += 1;
      },
    }),
    externalCounts: () => ({ ...externalCounts }),
    sheet: () => sheetFeed,
    refreshFlags,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (offRc !== null) {
        try {
          offRc();
        } catch {
          /* ignore */
        }
        offRc = null;
      }
      if (offLive !== null) {
        try {
          offLive();
        } catch {
          /* ignore */
        }
        offLive = null;
      }
      if (offSelection !== null) {
        try {
          offSelection();
        } catch {
          /* ignore */
        }
        offSelection = null;
      }
      ownedStore?.dispose();
      transport?.dispose();
      sheetListeners.clear();
    },
  };
}
