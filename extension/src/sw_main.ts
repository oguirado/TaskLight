// Bootstrap: wires createServiceWorker + createAgentRelay on an injected chrome-like object.
import type { ChromeLike, ChromePortLike } from "./chrome_ports";
import { createLocalStore, manifestExternalMatches } from "./chrome_ports";
import { createAgentRelay } from "./agent_relay";
import type { AgentRelay } from "./agent_relay";
import { createModelRelay } from "./model_relay";
import type { ModelRelay } from "./model_relay";
import type { Clock, ExternalPortGate } from "./types";
import { createServiceWorker } from "./sw";
import type { ServiceWorker } from "./sw";

declare const __CW_SW_AUTOBOOT__: boolean | undefined;

export interface SwMainDeps {
  chrome: ChromeLike;
  clock?: Clock;
  gate?: ExternalPortGate;
  nativeHostName?: string;
  maxFrameChars?: number;
}
export interface SwMain { sw: ServiceWorker; agent: AgentRelay; models: ModelRelay }

const DEFAULT_NATIVE_HOST = "com.contextwall.bridge";
const DEFAULT_MAX_FRAME_CHARS = 65536;

function defaultClock(): Clock {
  return {
    now: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
}

export async function startSwMain(d: SwMainDeps): Promise<SwMain> {
  const clock = d.clock ?? defaultClock();
  const gate: ExternalPortGate = d.gate ?? { allowedOrigins: manifestExternalMatches(d.chrome) };
  const nativeHostName = d.nativeHostName ?? DEFAULT_NATIVE_HOST;
  const maxFrameChars = d.maxFrameChars ?? DEFAULT_MAX_FRAME_CHARS;
  const hooked = new WeakSet<ChromePortLike>();
  let agent: AgentRelay;
  let models: ModelRelay;
  const sw = createServiceWorker({
    chrome: d.chrome,
    clock,
    gate,
    nativeHostName,
    maxFrameChars,
    onExtra: (port, msg) => {
      if (!hooked.has(port)) {
        hooked.add(port);
        port.onDisconnect.addListener(() => {
          agent.onPortClosed(port);
          models.onPortClosed(port);
        });
      }
      const t = typeof msg === "object" && msg !== null ? (msg as { t?: unknown }).t : undefined;
      if (typeof t === "string" && t.startsWith("model_")) models.onPortMessage(port, msg);
      else agent.onPortMessage(port, msg);
    },
  });
  agent = createAgentRelay({ native: sw.relay, clock });
  models = createModelRelay({ native: sw.relay, clock, store: createLocalStore(d.chrome) });
  await sw.start();
  return { sw, agent, models };
}

/**
 * Boots on import when a chrome global exists, unless the build disables it.
 * The built entry owns startup and supplies its configured gate; otherwise
 * origins come from the manifest at runtime.
 */
const chromeGlobal = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
if ((typeof __CW_SW_AUTOBOOT__ === "undefined" || __CW_SW_AUTOBOOT__ === true) && chromeGlobal !== undefined) {
  void startSwMain({ chrome: chromeGlobal }).catch(() => {}); /* startup failure is contained; SW stays inert */
}
