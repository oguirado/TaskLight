// Bootstrap: wires createServiceWorker + createAgentRelay on an injected chrome-like object.
import type { ChromeLike, ChromePortLike } from "./chrome_ports";
import { manifestExternalMatches } from "./chrome_ports";
import { createAgentRelay } from "./agent_relay";
import type { AgentRelay } from "./agent_relay";
import type { Clock, ExternalPortGate } from "./types";
import { createServiceWorker } from "./sw";
import type { ServiceWorker } from "./sw";

export interface SwMainDeps {
  chrome: ChromeLike;
  clock?: Clock;
  gate?: ExternalPortGate;
  nativeHostName?: string;
  maxFrameChars?: number;
}
export interface SwMain { sw: ServiceWorker; agent: AgentRelay }

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
        });
      }
      agent.onPortMessage(port, msg);
    },
  });
  agent = createAgentRelay({ native: sw.relay, clock });
  await sw.start();
  return { sw, agent };
}

/**
 * U38 G2: this module is the only entry that starts the service worker.
 * It boots on import when a chrome global exists (inert without one);
 * origins come from the manifest at runtime.
 */
const chromeGlobal = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
if (chromeGlobal !== undefined) {
  void startSwMain({ chrome: chromeGlobal }).catch(() => {}); /* startup failure is contained; SW stays inert */
}
