// U51 O12-O14: no assets, no vendor names, status-line trigger, static guards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_SHEET_COPY } from "../../../src/ui/model_selector";
import { mountWall } from "../../../src/views";
import { toWallVM } from "../../../src/app/agent_store";
import type { WallVM } from "../../../src/views/types";
import { mkState } from "../u38/helpers";
import { FB, LOCAL_ID, NET_ID, VENDOR_RE, cleanup, exists, fb, local, net, read, rig, snap, stripCss, stripTs, txt } from "./helpers";

afterEach(cleanup);

const STATES = () => [
  snap(),
  snap({ hostPresent: false, providers: fb() }),
  snap({ providers: [...fb({ "firebase-cloud": { health: "blocked", blockedReason: "remote_config" } }), local({ health: "needs_setup" }), net({ health: "blocked", blockedReason: "policy" })], selection: { all: LOCAL_ID } }),
  snap({ providers: [...fb(), local({ health: "offline" }), net({ health: "blocked", blockedReason: "unknown_id" })], device: { state: "downloading", progress: 0.4 } }),
  snap({ device: { state: "failed", detail: "boom" } }),
];

describe("O12 no assets", () => {
  it("sheet has no img/svg/picture/object/embed in any state", () => {
    for (const s of STATES()) {
      const r = rig(s);
      expect(r.el().querySelectorAll("img,svg,picture,object,embed").length).toBe(0);
      r.sheet.open(r.trigger);
      expect(r.el().querySelectorAll("img,svg,picture,object,embed").length).toBe(0);
      cleanup();
    }
  });
  it("styles/model_selector.css exists and has no url(", () => {
    expect(exists("styles/model_selector.css")).toBe(true);
    expect(stripCss(read("styles/model_selector.css"))).not.toMatch(/url\s*\(/i);
  });
  it("css reuses tokens only: no hex/rgb/hsl colour literals", () => {
    const css = stripCss(read("styles/model_selector.css"));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });
  it("css contains the frozen hooks", () => {
    const css = stripCss(read("styles/model_selector.css"));
    for (const frag of ["--c-st-done", "--c-st-waiting", "--c-text-3", "--c-accent", ":focus-visible", "outline: 2px solid var(--c-accent)",
      "data-health", 'data-source="local"', 'data-source="remote"', "dashed", "button.status-line"]) expect(css).toContain(frag);
  });
});

describe("O13 no vendor names", () => {
  it("MODEL_SHEET_COPY values are vendor-free", () => {
    for (const v of Object.values(MODEL_SHEET_COPY)) expect(v).not.toMatch(VENDOR_RE);
    expect(Object.keys(MODEL_SHEET_COPY).length).toBeGreaterThan(20);
  });
  it("sheet text in every state is vendor-free and never leaks kind/id strings", () => {
    for (const s of STATES()) {
      const r = rig(s);
      const t = txt(r.el());
      expect(t).not.toMatch(VENDOR_RE);
      for (const leak of [...FB, "local-openai-compatible", "remote-openai-compatible", "openai-compatible", LOCAL_ID, NET_ID, "blocked", "needs_setup", "remote_config", "unknown_id", "policy"])
        expect(t).not.toContain(leak);
      cleanup();
    }
  });
});

describe("O14 status-line trigger", () => {
  const base = (): WallVM => toWallVM([mkState({ steps: 2, done: 1 })], new Map(), { nowMs: Date.now(), model: { state: "ready", label: "Gemini Nano" }, network: "online" });
  it("without onOpenModels: a div, as today", () => {
    const host = document.createElement("div"); document.body.append(host);
    mountWall(host, base(), {});
    const m = host.querySelector("[data-model]");
    expect(m?.tagName).toBe("DIV");
    expect(m?.classList.contains("status-line")).toBe(true);
    expect(host.querySelector("button.status-line")).toBeNull();
  });
  it("with onOpenModels: a button with the ARIA contract, same dot and text", () => {
    const host = document.createElement("div"); document.body.append(host);
    const spy = vi.fn();
    mountWall(host, base(), { onOpenModels: spy });
    const b = host.querySelector<HTMLButtonElement>("button.status-line");
    expect(b).not.toBeNull();
    expect(b!.getAttribute("type")).toBe("button");
    expect(b!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(b!.getAttribute("aria-controls")).toBe("model-sheet");
    expect(b!.getAttribute("aria-expanded")).toBe("false");
    expect(b!.hasAttribute("data-model")).toBe(true);
    expect(b!.querySelector(".status-dot")?.getAttribute("aria-hidden")).toBe("true");
    expect(b!.querySelector(".status-text")?.textContent).toBe("Gemini Nano");
    b!.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(b);
  });
  it("only the model line becomes a button; the network line stays a div", () => {
    const host = document.createElement("div"); document.body.append(host);
    mountWall(host, base(), { onOpenModels: () => {} });
    expect(host.querySelectorAll("button.status-line").length).toBe(1);
    expect(host.querySelector("[data-network]")?.tagName).toBe("DIV");
  });
  it("survives update(): still a button and still one", () => {
    const host = document.createElement("div"); document.body.append(host);
    const h = mountWall(host, base(), { onOpenModels: () => {} });
    h.update({ ...base(), model: { state: "downloading", label: "Downloading" } });
    expect(host.querySelectorAll("button.status-line").length).toBe(1);
    expect(host.querySelector("button.status-line .status-text")?.textContent).toBe("Downloading");
  });
});

describe("static guards on src/ui/model_selector.ts", () => {
  it("module exists; no innerHTML/eval/Function/outerHTML/insertAdjacentHTML/network/storage", () => {
    expect(exists("src/ui/model_selector.ts")).toBe(true);
    const s = stripTs(read("src/ui/model_selector.ts"));
    expect(s).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|createContextualFragment/);
    expect(s).not.toMatch(/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|console\./);
    expect(s).not.toMatch(/from ["'](firebase|\.\.\/(ai|providers)\/(?!types))/);
  });
  it("U51 write surface: the two approved amendments are type-only on views/types", () => {
    const v = stripTs(read("src/views/types.ts"));
    expect(v).toContain('SourceKind = "device" | "cloud" | "local" | "remote" | "rules"');
    expect(v).toContain("onOpenModels?(trigger: HTMLElement): void");
  });
});
