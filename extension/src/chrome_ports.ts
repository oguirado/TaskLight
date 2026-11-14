// The ONLY file that touches `chrome.*`. Everything else receives these ports by injection.
import type { SessionStore } from "./types";

export interface Listener<A extends unknown[]> { addListener(cb: (...a: A) => void): void }
export interface ChromePortLike {
  name?: string | undefined;
  sender?: { origin?: string; url?: string; id?: string } | undefined;
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: Listener<[unknown]>;
  onDisconnect: Listener<[]>;
}
export interface MessageSender { id?: string; url?: string; origin?: string; tab?: { id?: number; url?: string } }
export interface TabLike { id?: number; title?: string; url?: string }
export interface ChromeLike {
  runtime: {
    id: string;
    onConnectExternal: Listener<[ChromePortLike]>;
    onMessage: Listener<[unknown, MessageSender, (r?: unknown) => void]>;
    connectNative(host: string): ChromePortLike;
    /** Panel<->SW runtime messaging (B9). Optional so fakes without a browser stay assignable. */
    sendMessage?(msg: unknown): Promise<unknown>;
    connect?(name?: string): ChromePortLike;
    onConnect?: Listener<[ChromePortLike]>;
  };
  storage: {
    session: { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> };
    local: { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> };
  };
  sidePanel: { open(o: { windowId?: number; tabId?: number }): Promise<void> };
  tabs: { get(id: number): Promise<TabLike>; onRemoved: Listener<[number]> };
  scripting: { executeScript(o: { target: { tabId: number }; func: () => string }): Promise<Array<{ result?: unknown }>> };
  permissions: { contains(o: { origins: string[] }): Promise<boolean> };
}
/** Origins from the runtime manifest's externally_connectable.matches (never hard-coded). */
export function manifestExternalMatches(c: ChromeLike): readonly string[] {
  const raw: unknown = (c.runtime as unknown as { getManifest?: () => unknown }).getManifest?.();
  if (typeof raw !== "object" || raw === null) return [];
  const ec = (raw as { externally_connectable?: unknown }).externally_connectable;
  if (typeof ec !== "object" || ec === null) return [];
  const matches = (ec as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];
  return matches.filter((m): m is string => typeof m === "string");
}

/** SessionStore bound to the session area only (B6). Key -> {[key]: value}. */
export function createSessionStore(c: ChromeLike): SessionStore {
  return {
    async get(key: string): Promise<unknown> {
      const rec = await c.storage.session.get(key);
      return rec[key];
    },
    async set(key: string, value: unknown): Promise<void> {
      await c.storage.session.set({ [key]: value });
    },
  };
}
