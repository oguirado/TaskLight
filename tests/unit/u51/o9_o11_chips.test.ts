// U51 O9-O11: chip table, shell badge, views chip, drift note.
import { afterEach, describe, expect, it } from "vitest";
import { chipLabel, effectiveId, groupOf, viewSourceKind } from "../../../src/ui/model_selector";
import { createWallUi } from "../../../src/ui/shell";
import { mountWall } from "../../../src/views";
import { toWallVM } from "../../../src/app/agent_store";
import type { WallVM } from "../../../src/views/types";
import type { AgentChatVM } from "../../../src/agentsui/types";
import { D, card, makeHarness, slot } from "../u20/helpers";
import { mkState } from "../u38/helpers";
import { cleanup as cleanupChat, mount as mountChat } from "../u35/helpers";
import { DRIFT } from "../u35/fixture";

afterEach(() => { cleanupChat(); document.body.replaceChildren(); });

describe("O9 chipLabel table (spec section 4)", () => {
  const T: [Parameters<typeof chipLabel>[0], "standard" | "shared" | "private", string][] = [
    ["ON_DEVICE", "standard", "On device"], ["ON_DEVICE", "shared", "On device"], ["ON_DEVICE", "private", "On device"],
    ["IN_CLOUD", "standard", "Cloud"], ["IN_CLOUD", "shared", "Cloud"], ["IN_CLOUD", "private", ""],
    ["LOCAL_SERVER", "standard", "Local model"], ["LOCAL_SERVER", "shared", "Local model"], ["LOCAL_SERVER", "private", "Local model"],
    ["REMOTE_PROVIDER", "standard", "Network model"], ["REMOTE_PROVIDER", "shared", "Network model"], ["REMOTE_PROVIDER", "private", ""],
    [undefined, "standard", ""], [undefined, "shared", ""], [undefined, "private", ""],
  ];
  it.each(T)("chipLabel(%s, %s) = %j", (src, tier, want) => { expect(chipLabel(src, tier)).toBe(want); });
  it("unknown source value gives ''", () => {
    expect(chipLabel("SOMETHING_ELSE" as never, "standard")).toBe("");
    expect(chipLabel("SOMETHING_ELSE" as never, "private")).toBe("");
  });
  it("viewSourceKind maps the four sources", () => {
    expect(viewSourceKind("ON_DEVICE")).toBe("device");
    expect(viewSourceKind("IN_CLOUD")).toBe("cloud");
    expect(viewSourceKind("LOCAL_SERVER")).toBe("local");
    expect(viewSourceKind("REMOTE_PROVIDER")).toBe("remote");
  });
  it("groupOf", () => {
    expect(groupOf("firebase-hybrid")).toBe("firebase");
    expect(groupOf("firebase-ondevice")).toBe("firebase");
    expect(groupOf("firebase-cloud")).toBe("firebase");
    expect(groupOf("local-openai-compatible")).toBe("local");
    expect(groupOf("remote-openai-compatible")).toBe("network");
  });
  it("effectiveId = groups[g] ?? all ?? DEFAULT_PROVIDER", () => {
    expect(effectiveId({}, "all")).toBe("firebase-hybrid");
    expect(effectiveId({}, "digest")).toBe("firebase-hybrid");
    expect(effectiveId({ all: "x" }, "all")).toBe("x");
    expect(effectiveId({ all: "x" }, "routing")).toBe("x");
    expect(effectiveId({ all: "x", groups: { routing: "y" } }, "routing")).toBe("y");
    expect(effectiveId({ all: "x", groups: { routing: "y" } }, "capsule")).toBe("x");
    expect(effectiveId({ groups: { drift: "z" } }, "all")).toBe("firebase-hybrid");
    expect(effectiveId({ groups: { drift: "z" } }, "drift")).toBe("z");
  });
});

describe("O9 shell badge uses the answering source", () => {
  const boot = () => { const h = makeHarness(); const ui = createWallUi(h.opts); ui.update(D()); return { h, ui }; };
  const badge = (h: ReturnType<typeof makeHarness>, id: string) => slot(h.nodes.get(id)!, "badge").textContent;
  it("standard cards", () => {
    const { h, ui } = boot();
    ui.setCapsules([card("a", { source: "LOCAL_SERVER" }), card("b", { source: "REMOTE_PROVIDER" }), card("c", { source: "ON_DEVICE" }), card("d", { source: "IN_CLOUD" })]);
    expect(badge(h, "a")).toBe("Local model");
    expect(badge(h, "b")).toBe("Network model");
    expect(badge(h, "c")).toBe("On device");
    expect(badge(h, "d")).toBe("Cloud");
  });
  it("private cards: local claimed, remote never claimed, cloud unchanged", () => {
    const { h, ui } = boot();
    ui.setCapsules([card("a", { tier: "private", source: "LOCAL_SERVER" }), card("b", { tier: "private", source: "REMOTE_PROVIDER" }),
      card("c", { tier: "private", source: "ON_DEVICE" }), card("d", { tier: "private", source: "IN_CLOUD" })]);
    expect(badge(h, "a")).toBe("Local model");
    expect(badge(h, "b")).toBe("");
    expect(badge(h, "c")).toBe("On device");
    expect(badge(h, "d")).toBe("");
  });
  it("selection is not an input: a card answered ON_DEVICE reads 'On device' even if selection.all is a local endpoint", () => {
    const { h, ui } = boot();
    const selection = { all: "ep-local-9f3" }; void selection; // the shell never receives it
    ui.setCapsules([card("a", { source: "ON_DEVICE" })]);
    expect(badge(h, "a")).toBe("On device");
    expect(badge(h, "a")).not.toBe("Local model");
  });
  it("'Private: unavailable' keeps precedence over a Local model chip", () => {
    const h = makeHarness(); const ui = createWallUi(h.opts);
    ui.update(D({ device: { state: "downloading", progress: 0.3 }, availability: "downloading" }));
    ui.setCapsules([card("p", { tier: "private", source: "LOCAL_SERVER" })]);
    expect(badge(h, "p")).toContain("Private: unavailable");
  });
  it("no source: empty badge", () => {
    const { h, ui } = boot();
    ui.setCapsules([card("a", {})]);
    expect(badge(h, "a")).toBe("");
  });
});

describe("O10 views chip", () => {
  const base = (): WallVM => toWallVM([mkState({ steps: 2, done: 1 })], new Map(), { nowMs: Date.now(), model: { state: "ready", label: "ready" }, network: "online" });
  function chipFor(source: unknown): HTMLElement {
    const vm = base();
    const host = document.createElement("div"); document.body.append(host);
    mountWall(host, { ...vm, tasks: vm.tasks.map((t) => ({ ...t, source } as never)) }, {});
    const chip = host.querySelector<HTMLElement>(".provenance .source");
    if (chip === null) throw new Error("no provenance chip");
    return chip;
  }
  it("local with ms>0: 'Local model', data-source=local, latency shown", () => {
    const c = chipFor({ kind: "local", ms: 250 });
    expect(c.getAttribute("data-source")).toBe("local");
    expect(c.querySelector(".source-label")?.textContent).toBe("Local model");
    expect(c.textContent).toContain("250 ms");
    expect(c.textContent).not.toMatch(/Gemini|Rules/);
  });
  it("remote with ms>0: 'Network model', data-source=remote", () => {
    const c = chipFor({ kind: "remote", ms: 900 });
    expect(c.getAttribute("data-source")).toBe("remote");
    expect(c.querySelector(".source-label")?.textContent).toBe("Network model");
    expect(c.textContent).toContain("900 ms");
    expect(c.textContent).not.toMatch(/Gemini|Rules|Local/);
  });
  it("local/remote with ms 0 -> Rules, no latency", () => {
    for (const kind of ["local", "remote"]) {
      const c = chipFor({ kind, ms: 0 });
      expect(c.textContent).toContain("Rules");
      expect(c.querySelector(".source-ms")).toBeNull();
    }
  });
  it("unknown kind with ms>0 falls to Rules (no more cloud mislabel)", () => {
    for (const kind of ["quantum", "unknown", "x"]) {
      const c = chipFor({ kind, ms: 300 });
      expect(c.querySelector(".source-label")?.textContent).toBe("Rules");
      expect(c.textContent).not.toMatch(/Gemini|cloud/i);
      expect(c.querySelector(".source-ms")).toBeNull();
    }
  });
  it("device and cloud strings are byte-identical to u38", () => {
    expect(chipFor({ kind: "device", ms: 142 }).querySelector(".source-label")?.textContent).toBe("Gemini Nano · on device");
    expect(chipFor({ kind: "cloud", ms: 1180 }).querySelector(".source-label")?.textContent).toBe("Gemini · cloud fallback");
    expect(chipFor({ kind: "rules", ms: 5 }).querySelector(".source-label")?.textContent).toBe("Rules");
  });
});

describe("O11 drift banner source note", () => {
  const withSource = (source: unknown): AgentChatVM => ({ ...DRIFT, drift: { ...DRIFT.drift!, source } as never });
  const note = (v: AgentChatVM) => mountChat(v).host.querySelector(".drift-source");
  it("local", () => { expect(note(withSource("local"))?.textContent).toBe("Reviewed by your local model"); });
  it("remote", () => { expect(note(withSource("remote"))?.textContent).toBe("Reviewed by your network model"); });
  it("existing notes unchanged", () => {
    expect(note(withSource("device"))?.textContent).toBe("Reviewed by Gemini Nano on this device");
    expect(note(withSource("cloud"))?.textContent).toBe("Reviewed by Gemini in the cloud");
    expect(note(withSource("rules"))?.textContent).toBe("Reviewed by rules");
  });
  it("unknown source: no .drift-source at all", () => {
    for (const s of ["quantum", "", "LOCAL", undefined]) expect(note(withSource(s))).toBeNull();
  });
  it("local note excludes the other notes", () => {
    const t = mountChat(withSource("local")).host.textContent ?? "";
    expect(t).not.toContain("Reviewed by Gemini");
    expect(t).not.toContain("network model");
  });
});
