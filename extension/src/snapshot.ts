import type { ChromeLike } from "./chrome_ports";
import type { PinnedSourceEvent, PinRegistry, PinReject, Router } from "./types";
import { SOURCE_LIMITS } from "./types";
import { toOriginPath } from "./pins";

export type CaptureReject = PinReject | "NO_HOST_PERMISSION" | "CAPTURE_FAILED";
export type SourceResult = { ok: true } | { ok: false; code: CaptureReject };
/** Builds a bounded PinnedSourceEvent: title<=120, text<=2000, originPath without query/fragment. Pure. */
export function buildSourceEvent(
  tab: { id: number; title?: string; url?: string }, projectId: string,
  kind: PinnedSourceEvent["kind"], text: string, userGesture: boolean,
): PinnedSourceEvent | { error: "BAD_URL" } {
  const originPath = toOriginPath(tab.url ?? "");
  if (originPath === null) return { error: "BAD_URL" };
  const title = (tab.title ?? "").slice(0, SOURCE_LIMITS.TITLE_MAX);
  const body = text.slice(0, SOURCE_LIMITS.TEXT_MAX);
  let source: PinnedSourceEvent["source"];
  if (kind === "tab_pinned" || kind === "tab_focused") source = "tab";
  else if (kind === "selection_captured") source = "selection";
  else source = "page";
  return {
    tabId: tab.id,
    projectId,
    source,
    kind,
    title,
    originPath,
    text: body,
    userGesture,
  };
}
export interface SourceCollector {
  /** Pin needs a gesture; on success emits tab_pinned. */
  pinTab(tabId: number, projectId: string, gesture: boolean): Promise<SourceResult>;
  /** Content-script report; ignored (NOT_PINNED) for unpinned tabs. */
  onSelection(tabId: number, text: string): Promise<SourceResult>;
  onFocus(tabId: number): Promise<SourceResult>;
  /** Visible-text snapshot; pinned tabs only AND only with the optional per-site host permission granted. */
  captureSnapshot(tabId: number): Promise<SourceResult>;
}
export function createSourceCollector(d: { chrome: ChromeLike; pins: PinRegistry; router: Pick<Router, "accept"> }): SourceCollector {
  const ch = d.chrome;
  const emit = async (projectId: string, event: PinnedSourceEvent): Promise<boolean> => {
    const r = await d.router.accept({ projectId, payload: event });
    return r.ok;
  };
  const fromTab = async (
    tabId: number, kind: PinnedSourceEvent["kind"], text: string, userGesture: boolean,
  ): Promise<SourceResult> => {
    const projectId = d.pins.projectOf(tabId);
    if (projectId === undefined) return { ok: false, code: "NOT_PINNED" };
    let tab: { id: number; title?: string; url?: string };
    try {
      const t = await ch.tabs.get(tabId);
      tab = { id: t.id ?? tabId };
      if (t.title !== undefined) tab.title = t.title;
      if (t.url !== undefined) tab.url = t.url;
    } catch {
      return { ok: false, code: "CAPTURE_FAILED" };
    }
    const ev = buildSourceEvent(tab, projectId, kind, text, userGesture);
    if ("error" in ev) return { ok: false, code: "BAD_URL" };
    const ok = await emit(projectId, ev);
    return ok ? { ok: true } : { ok: false, code: "CAPTURE_FAILED" };
  };

  return {
    async pinTab(tabId: number, projectId: string, gesture: boolean): Promise<SourceResult> {
      if (gesture !== true) return { ok: false, code: "NO_GESTURE" };
      let tab: { id: number; title?: string; url?: string };
      try {
        const t = await ch.tabs.get(tabId);
        tab = { id: t.id ?? tabId };
        if (t.title !== undefined) tab.title = t.title;
        if (t.url !== undefined) tab.url = t.url;
      } catch {
        return { ok: false, code: "CAPTURE_FAILED" };
      }
      const ev = buildSourceEvent(tab, projectId, "tab_pinned", "", gesture);
      if ("error" in ev) return { ok: false, code: "BAD_URL" };
      const pinned = d.pins.pin(tabId, projectId, gesture);
      if (!pinned.ok) return pinned;
      const ok = await emit(projectId, ev);
      if (!ok) return { ok: false, code: "CAPTURE_FAILED" };
      return { ok: true };
    },
    async onSelection(tabId: number, text: string): Promise<SourceResult> {
      return fromTab(tabId, "selection_captured", text, false);
    },
    async onFocus(tabId: number): Promise<SourceResult> {
      return fromTab(tabId, "tab_focused", "", false);
    },
    async captureSnapshot(tabId: number): Promise<SourceResult> {
      const projectId = d.pins.projectOf(tabId);
      if (projectId === undefined) return { ok: false, code: "NOT_PINNED" };
      let tab: { id: number; title?: string; url?: string };
      try {
        const t = await ch.tabs.get(tabId);
        tab = { id: t.id ?? tabId };
        if (t.title !== undefined) tab.title = t.title;
        if (t.url !== undefined) tab.url = t.url;
      } catch {
        return { ok: false, code: "CAPTURE_FAILED" };
      }
      const originPath = toOriginPath(tab.url ?? "");
      if (originPath === null) return { ok: false, code: "BAD_URL" };
      let origin: string;
      try {
        origin = new URL(tab.url ?? "").origin;
      } catch {
        return { ok: false, code: "BAD_URL" };
      }
      let granted = false;
      try {
        granted = await ch.permissions.contains({ origins: [origin + "/*"] });
      } catch {
        return { ok: false, code: "CAPTURE_FAILED" };
      }
      if (!granted) return { ok: false, code: "NO_HOST_PERMISSION" };
      let text = "";
      try {
        const res = await ch.scripting.executeScript({
          target: { tabId },
          func: () => document.body?.innerText ?? "",
        });
        text = typeof res[0]?.result === "string" ? (res[0].result as string) : "";
      } catch {
        return { ok: false, code: "CAPTURE_FAILED" };
      }
      const ev = buildSourceEvent(tab, projectId, "page_snapshot", text, false);
      if ("error" in ev) return { ok: false, code: "BAD_URL" };
      const ok = await emit(projectId, ev);
      return ok ? { ok: true } : { ok: false, code: "CAPTURE_FAILED" };
    },
  };
}
