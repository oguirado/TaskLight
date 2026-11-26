// PF1: the side panel gives the hosted wall the whole panel, and the legacy handshake waits for the frame.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXT_ID, SITE, settle } from "../u13/harness";

const PANEL_HTML = resolve(__dirname, "../../../extension/src/panel/panel.html");

afterEach(() => { document.body.replaceChildren(); vi.resetModules(); });

/** Mount the real panel markup the way tests/unit/u13 does, and record what the panel posts to the frame. */
function panelEnv() {
  const html = readFileSync(PANEL_HTML, "utf8");
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>[\s\S]*$/i, "");
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  const posts: Array<{ m: any; o: string }> = [];
  const cw = { postMessage: (m: unknown, o: string) => { posts.push({ m: structuredClone(m), o }); } };
  Object.defineProperty(iframe, "contentWindow", { value: cw, configurable: true });
  (globalThis as any).chrome = {
    runtime: {
      id: EXT_ID,
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
      connect: vi.fn(() => ({ postMessage: () => {}, disconnect: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } })),
    },
  };
  return { iframe, posts };
}
const hellos = (posts: Array<{ m: any; o: string }>) => posts.filter((p) => p.m?.t === "hello");

describe("PF1-1 the frame fills the panel", () => {
  it("body has no margin and the frame spans the full width and height without a border", () => {
    panelEnv();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const body = getComputedStyle(document.body);
    const frame = getComputedStyle(iframe);
    expect(body.margin).toBe("0px");
    expect(frame.width).toBe("100%");
    expect(frame.height).toBe("100%");
    expect(frame.borderTopWidth).toBe("0px");
    expect(frame.display).toBe("block");
  });
  it("the language-model permission stays in static markup next to the frame source", () => {
    const html = readFileSync(PANEL_HTML, "utf8");
    const tag = /<iframe\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain('allow="language-model"');
    expect(tag).toMatch(/\ssrc="https:\/\/[^"]+\/"/);
  });
});

describe("PF1-2 the legacy handshake waits for the frame", () => {
  it("no hello is posted before the frame has loaded", async () => {
    const { posts } = panelEnv();
    await import("../../../extension/src/panel/panel");
    await settle(20);
    expect(hellos(posts)).toHaveLength(0);
  });
  it("after the frame load event exactly one hello goes to the hosted origin", async () => {
    const { iframe, posts } = panelEnv();
    await import("../../../extension/src/panel/panel");
    await settle(20);
    posts.length = 0;
    iframe.dispatchEvent(new Event("load"));
    await settle(20);
    expect(hellos(posts)).toHaveLength(1);
    expect(hellos(posts)[0]!.o).toBe(SITE);
  });
});
