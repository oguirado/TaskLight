import { describe, it, expect, vi } from "vitest";
import { createPinRegistry, toOriginPath } from "../../../extension/src/pins";
import { buildSourceEvent, createSourceCollector } from "../../../extension/src/snapshot";
import { SOURCE_LIMITS } from "../../../extension/src/types";
import type { PinnedSourceEvent } from "../../../extension/src/types";
import { FakeChrome } from "./harness";

describe("pin registry (B18)", () => {
  it("pin needs a user gesture", () => {
    const r = createPinRegistry();
    expect(r.pin(1, "p1", false)).toEqual({ ok: false, code: "NO_GESTURE" });
    expect(r.projectOf(1)).toBeUndefined();
    expect(r.pin(1, "p1", true)).toEqual({ ok: true });
    expect(r.projectOf(1)).toBe("p1");
  });
  it("PINS_MAX=12: 13th is PINS_FULL; re-pinning the same tab is not a new pin; unpin frees a slot", () => {
    const r = createPinRegistry();
    for (let i = 1; i <= SOURCE_LIMITS.PINS_MAX; i++) expect(r.pin(i, `p${i}`, true)).toEqual({ ok: true });
    expect(r.pin(99, "p99", true)).toEqual({ ok: false, code: "PINS_FULL" });
    expect(r.projectOf(99)).toBeUndefined();
    expect(r.pin(3, "p3", true)).toEqual({ ok: true });
    r.unpin(3);
    expect(r.projectOf(3)).toBeUndefined();
    expect(r.pin(99, "p99", true)).toEqual({ ok: true });
  });
  it("custom max honoured; unpin of unknown tab is a no-op", () => {
    const r = createPinRegistry({ max: 1 });
    r.unpin(404);
    expect(r.pin(1, "a", true).ok).toBe(true);
    expect(r.pin(2, "b", true)).toEqual({ ok: false, code: "PINS_FULL" });
  });
});

describe("toOriginPath (B19)", () => {
  it.each([
    ["https://a.com:8080/x/y?q=1#f", "https://a.com:8080/x/y"],
    ["https://u:p@a.com/p?token=S", "https://a.com/p"],
    ["https://a.com", "https://a.com/"],
    ["http://localhost:3000/a?b=1", "http://localhost:3000/a"],
    ["https://a.com/p#frag", "https://a.com/p"],
  ])("%s -> %s", (i, o) => { expect(toOriginPath(i)).toBe(o); });
  it.each(["ftp://x/y", "javascript:alert(1)", "chrome://settings", "file:///etc/passwd", "about:blank", "garbage", ""])("%s -> null", (i) => {
    expect(toOriginPath(i)).toBeNull();
  });
});

describe("buildSourceEvent (B19 bounds)", () => {
  const tab = { id: 5, title: "T".repeat(300), url: "https://example.com/a/b?secret=1#h" };
  it("caps title at 120 and text at 2000; drops query/fragment", () => {
    const e = buildSourceEvent(tab, "p1", "selection_captured", "s".repeat(5000), false) as PinnedSourceEvent;
    expect(e.title).toHaveLength(SOURCE_LIMITS.TITLE_MAX);
    expect(e.text).toHaveLength(SOURCE_LIMITS.TEXT_MAX);
    expect(e.originPath).toBe("https://example.com/a/b");
    expect(JSON.stringify(e)).not.toMatch(/secret|#h|\?/);
    expect(e).toMatchObject({ tabId: 5, projectId: "p1", kind: "selection_captured", source: "selection", userGesture: false });
  });
  it("source mapping: tab_pinned/tab_focused -> tab, page_snapshot -> page", () => {
    expect((buildSourceEvent(tab, "p1", "tab_pinned", "", true) as PinnedSourceEvent).source).toBe("tab");
    expect((buildSourceEvent(tab, "p1", "tab_focused", "", false) as PinnedSourceEvent).source).toBe("tab");
    expect((buildSourceEvent(tab, "p1", "page_snapshot", "x", false) as PinnedSourceEvent).source).toBe("page");
  });
  it("boundary: title 120 and text 2000 untouched; missing title becomes empty string", () => {
    const e = buildSourceEvent({ id: 1, title: "t".repeat(120), url: "https://a.com/" }, "p", "page_snapshot", "x".repeat(2000), false) as PinnedSourceEvent;
    expect(e.title).toHaveLength(120); expect(e.text).toHaveLength(2000);
    const n = buildSourceEvent({ id: 1, url: "https://a.com/" }, "p", "tab_pinned", "", true) as PinnedSourceEvent;
    expect(n.title).toBe("");
  });
  it("BAD_URL for non-http(s) or missing url", () => {
    expect(buildSourceEvent({ id: 1, title: "x", url: "chrome://settings" }, "p", "tab_pinned", "", true)).toEqual({ error: "BAD_URL" });
    expect(buildSourceEvent({ id: 1, title: "x" }, "p", "tab_pinned", "", true)).toEqual({ error: "BAD_URL" });
  });
});

describe("source collector (pinned-tab sources only)", () => {
  const mk = () => {
    const chrome = new FakeChrome();
    chrome.tabs.set(5, { id: 5, title: "Doc", url: "https://example.com/a/b?token=SECRET#frag" });
    chrome.tabs.set(6, { id: 6, title: "Bank", url: "https://bank.test/acct?id=1" });
    chrome.tabs.set(7, { id: 7, title: "Settings", url: "chrome://settings" });
    chrome.tabText.set(5, "v".repeat(5000));
    const accept = vi.fn(async (_raw: unknown) => ({ ok: true as const, id: 1, evictedIds: [] as number[] }));
    const pins = createPinRegistry();
    const col = createSourceCollector({ chrome: chrome.api, pins, router: { accept } });
    return { chrome, accept, pins, col };
  };
  const payloadOf = (accept: ReturnType<typeof vi.fn>, i = 0) => (accept.mock.calls[i]![0] as { projectId: string; payload: PinnedSourceEvent }).payload;

  it("unpinned tabs never produce events (selection, focus, snapshot)", async () => {
    const { col, accept, chrome } = mk();
    expect(await col.onSelection(6, "hello")).toEqual({ ok: false, code: "NOT_PINNED" });
    expect(await col.onFocus(6)).toEqual({ ok: false, code: "NOT_PINNED" });
    expect(await col.captureSnapshot(6)).toEqual({ ok: false, code: "NOT_PINNED" });
    expect(accept).not.toHaveBeenCalled();
    expect(chrome.executeCalls).toBe(0);
    expect(chrome.permChecks).toHaveLength(0);
  });
  it("pinTab without gesture -> NO_GESTURE, nothing emitted, tab stays unpinned", async () => {
    const { col, accept, pins } = mk();
    expect(await col.pinTab(5, "p1", false)).toEqual({ ok: false, code: "NO_GESTURE" });
    expect(accept).not.toHaveBeenCalled(); expect(pins.projectOf(5)).toBeUndefined();
  });
  it("pinTab on chrome:// -> BAD_URL and not pinned", async () => {
    const { col, accept, pins } = mk();
    expect(await col.pinTab(7, "p1", true)).toEqual({ ok: false, code: "BAD_URL" });
    expect(pins.projectOf(7)).toBeUndefined(); expect(accept).not.toHaveBeenCalled();
  });
  it("pinTab with gesture emits tab_pinned to the project, query stripped, userGesture true", async () => {
    const { col, accept } = mk();
    expect(await col.pinTab(5, "p1", true)).toEqual({ ok: true });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]![0]).toMatchObject({ projectId: "p1" });
    expect(payloadOf(accept)).toMatchObject({ kind: "tab_pinned", source: "tab", originPath: "https://example.com/a/b", userGesture: true, tabId: 5 });
    expect(JSON.stringify(accept.mock.calls)).not.toContain("SECRET");
  });
  it("selection from a pinned tab is capped at 2000", async () => {
    const { col, accept } = mk();
    await col.pinTab(5, "p1", true);
    expect(await col.onSelection(5, "s".repeat(9000))).toEqual({ ok: true });
    const p = payloadOf(accept, 1);
    expect(p).toMatchObject({ kind: "selection_captured", source: "selection" });
    expect(p.text).toHaveLength(2000);
  });
  it("snapshot requires the optional per-site host permission (no grant -> no script run)", async () => {
    const { col, accept, chrome } = mk();
    await col.pinTab(5, "p1", true);
    expect(await col.captureSnapshot(5)).toEqual({ ok: false, code: "NO_HOST_PERMISSION" });
    expect(chrome.executeCalls).toBe(0);
    expect(chrome.permChecks.at(-1)).toEqual(["https://example.com/*"]);
    expect(accept).toHaveBeenCalledTimes(1);
  });
  it("snapshot with grant: page_snapshot, text<=2000, source page", async () => {
    const { col, accept, chrome } = mk();
    chrome.granted.add("https://example.com/*");
    await col.pinTab(5, "p1", true);
    expect(await col.captureSnapshot(5)).toEqual({ ok: true });
    expect(chrome.executeCalls).toBe(1);
    const p = payloadOf(accept, 1);
    expect(p).toMatchObject({ kind: "page_snapshot", source: "page", originPath: "https://example.com/a/b" });
    expect(p.text).toHaveLength(2000);
  });
  it("after unpin, events stop", async () => {
    const { col, accept, pins } = mk();
    await col.pinTab(5, "p1", true); pins.unpin(5);
    expect(await col.onSelection(5, "x")).toEqual({ ok: false, code: "NOT_PINNED" });
    expect(accept).toHaveBeenCalledTimes(1);
  });
  it("tab lookup failure (closed tab) -> CAPTURE_FAILED, never throws", async () => {
    const { col, chrome } = mk();
    await col.pinTab(5, "p1", true); chrome.tabs.delete(5);
    await expect(col.onFocus(5)).resolves.toMatchObject({ ok: false });
  });
});
