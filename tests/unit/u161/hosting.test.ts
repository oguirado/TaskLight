import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStore, AgentStoreOptions } from "../../../src/app/agent_store";
import type { AgentLink, AgentLinkDeps } from "../../../src/app/agent_link";
import type { RoomEvent } from "../../../src/agents/types";
import { EXT_ID, PagePort } from "../u37c/harness";
import { A, B, CLOCK, FIRST_TITLE, SECOND_TITLE, event, expectClean, expectedProjection,
  history, opening, task } from "./history";

const captured = vi.hoisted(() => ({ store: undefined as AgentStore | undefined, link: undefined as AgentLink | undefined }));
// Only adapters unrelated to the fold are inert. Catalogue, reducer, store, link,
// diagnostic replay, notices, workspace guidance and Archive are production code.
vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({
  extensionOrigins: [`chrome-extension://${EXT_ID}`], firebaseConfig: {},
}) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => true }));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage: () => undefined }) }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({
  notifyChange: () => undefined, taskVerdicts: () => new Map(), planBriefs: () => new Map(),
}) }));
vi.mock("../../../src/ui/model_selector", () => ({ createModelSheet: () => ({ render: () => undefined, open: () => undefined }) }));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: (options?: AgentStoreOptions) => {
    captured.store = real.createAgentStore(options); return captured.store;
  } };
});
vi.mock("../../../src/app/agent_link", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_link")>();
  return { ...real, createAgentLink: (deps: AgentLinkDeps) => {
    captured.link = real.createAgentLink(deps); return captured.link;
  } };
});

let ports: PagePort[];
let observers: MutationObserver[];
let network: ReturnType<typeof vi.fn>;
const HELLO = { t: "room_hello", v: 1, rooms: [{ room: "demo", floor: "ONLY_ON_DEVICE" }], agent: "harness" };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(CLOCK);
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  ports = []; observers = []; captured.store = undefined; captured.link = undefined;
  const NativeObserver = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(callback: MutationCallback) { super(callback); observers.push(this); }
  });
  network = vi.fn(() => { throw new Error("Network is forbidden in this oracle"); });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("chrome", { runtime: { connect: () => { const port = new PagePort(); ports.push(port); return port; } } });
});
afterEach(() => {
  captured.link?.stop(); observers.forEach(observer => observer.disconnect());
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.replaceChildren();
  expect(network).not.toHaveBeenCalled();
});
const requestId = (port: PagePort): unknown => port.ofType("room_sync").at(-1)!["rid"];
function handshake(port: PagePort): void {
  const hello = port.ofType("hello").at(-1)!;
  port.emit({ t: "snapshot", v: 1, nonce: hello["nonce"], items: [] });
  vi.advanceTimersByTime(1); port.emit(HELLO);
}
async function boot(): Promise<PagePort> {
  await import("../../../hosting/src/main");
  const port = ports.at(-1)!;
  expect(port, "hosting must connect its production room link").toBeDefined(); handshake(port);
  return port;
}
function reconnect(port: PagePort): PagePort {
  port.drop(); vi.advanceTimersByTime(100);
  const next = ports.at(-1)!;
  expect(next).not.toBe(port); handshake(next); return next;
}
function send(port: PagePort, events: readonly RoomEvent[], replay = true): void {
  for (const item of events) port.emit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE",
    event: item, ...(replay ? { rid: requestId(port) } : {}) });
}
function terminal(port: PagePort, upto: number, more = false, rid: unknown = requestId(port)): void {
  port.emit({ t: "room_synced", v: 1, room: "demo", rid, upto, more });
}
function gap(port: PagePort, from: number, to: number, replay = true): void {
  port.emit({ t: "room_gap", v: 1, room: "demo", from_lamport: from, to_lamport: to,
    reason: "sanitize_failed", ...(replay ? { rid: requestId(port) } : {}) });
}
function workspace(): void {
  const button = document.querySelector<HTMLButtonElement>('button[data-wsid="demo"]');
  expect(button, "the admitted room must be selectable").not.toBeNull(); button!.click();
  expect(document.querySelector('.app[data-workspace="demo"]')).not.toBeNull();
}
function notice(): string {
  return [...document.querySelectorAll('[role="status"]')].map(node => node.textContent ?? "")
    .filter(text => text.includes("Progress may be outdated")).join(" ");
}
function expectSynced(): void {
  workspace();
  expect(notice(), "valid history must not be labelled an excluded Lamport range").toBe("");
  expect(document.querySelector(".workspace-guidance")?.textContent ?? "").not.toContain("Syncing workspace");
  expect(captured.store!.plan("demo")?.projection.plan).not.toBeNull();
}
function expectArchive(): void {
  workspace();
  const button = document.querySelector<HTMLButtonElement>('button[data-nav="archive"]');
  expect(button).not.toBeNull(); button!.click();
  expect([...document.querySelectorAll(".archived-title")].map(node => node.textContent)).toEqual([FIRST_TITLE]);
  document.querySelector<HTMLButtonElement>('button[data-nav="wall"]')!.click();
}
function expectFault(lamport: number): void {
  workspace();
  expect(notice()).toContain(`excluded Lamport ${lamport} to ${lamport}`);
  expect(document.querySelector(".workspace-guidance")?.textContent).toContain("Syncing workspace");
}
function heartbeat(n: number): RoomEvent {
  const value = event(n, {}); delete value.op; return { ...value, act: "heartbeat" };
}

describe("U161 production hosting replay and Archive", () => {
  it("M2/M3/N1 initial cross-template replay certifies sync and renders the closed plan in Wall Archive", async () => {
    const port = await boot(); const events = history(); send(port, events); terminal(port, 10);
    expectSynced();
    expectClean(captured.store!.plan("demo"), expectedProjection(events)); expectArchive();
  });

  it("M2/M3 a live template change preserves an already visible Archive and synced workspace", async () => {
    const port = await boot(); const events = history();
    send(port, events.slice(0, 6)); terminal(port, 6); expectSynced(); expectArchive();
    send(port, events.slice(6), false);
    expectSynced(); expectArchive();
    expectClean(captured.store!.plan("demo"), expectedProjection(events));
  });

  it("M3/M4/N3 clean recovery across a template change repairs a genuine gap without losing the archive", async () => {
    const port = await boot(); const events = history();
    send(port, events.slice(0, 6)); terminal(port, 6);
    gap(port, 11, 11, false);
    expect(notice()).toContain("excluded Lamport 11 to 11");
    send(port, events.slice(6), false); send(port, [heartbeat(12)], false);
    const next = reconnect(port);
    expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBeLessThan(11);
    send(next, [...events, heartbeat(11), heartbeat(12)]); terminal(next, 12);
    expectSynced(); expectArchive();
    expectClean(captured.store!.plan("demo"), expectedProjection(events));
  });

  it("M4 reload reconstructs the same cross-template projection and Archive", async () => {
    const events = history(); const first = await boot(); send(first, events); terminal(first, 10);
    const before = structuredClone(captured.store!.plan("demo")!.projection);
    captured.link!.stop(); observers.forEach(observer => observer.disconnect()); vi.clearAllTimers();
    vi.resetModules(); document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
    const second = await boot(); send(second, events); terminal(second, 10);
    expectSynced(); expectArchive();
    expectClean(captured.store!.plan("demo"), expectedProjection(events));
    expect(captured.store!.plan("demo")!.projection).toEqual(before);
  });

  it.each(["phase", "hash"] as const)("N2 genuine %s violations retain a fold fault after terminal replay and recovery", async violation => {
    const base = history();
    const bad = violation === "phase"
      ? event(11, { kind: "plan.phase", phase: "design", base_rev: 10 })
      : event(11, { ...opening(B, "Bad hash opening"), template_hash: "0".repeat(64) });
    // Close B before testing a malformed opening so plan_exists cannot mask its hash.
    const events = violation === "phase" ? [...base, bad] : [...base,
      event(11, { kind: "task.set", task_id: "T01", base_rev: 9, state: "cancelled" }),
      event(12, { kind: "plan.close", base_rev: 10 }),
      event(13, { ...bad.op!, op_id: "u161-bad-hash-opening" }),
      event(14, opening(B, SECOND_TITLE)), event(15, task(B))];
    const badLamport = violation === "phase" ? 11 : 13;
    const port = await boot(); send(port, events); terminal(port, events.at(-1)!.lamport);
    expect(captured.store!.plan("demo")!.invalidOps).toBe(0);
    expect(captured.store!.plan("demo")!.errors?.some(error => error.lamport === badLamport)).toBe(true);
    expect(notice()).toContain("excluded Lamport");
    expect(document.querySelector(".workspace-guidance")?.textContent).toContain("Syncing workspace");
    const next = reconnect(port); send(next, events); terminal(next, events.at(-1)!.lamport);
    expect(notice()).toContain("excluded Lamport");
    expect(document.querySelector(".workspace-guidance")?.textContent).toContain("Syncing workspace");
  });

  it("N3 a real room_gap remains visible through partial and stale completion until a complete clean recovery", async () => {
    const port = await boot(); const closed = history().slice(0, 6);
    send(port, closed); gap(port, 7, 7); send(port, [heartbeat(8)]); terminal(port, 8);
    expectFault(7);
    const next = reconnect(port);
    expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBe(6);
    send(next, [heartbeat(7), heartbeat(8)]);
    terminal(next, 8, true); expectFault(7);
    terminal(next, 8, false, "obsolete-request"); expectFault(7);
    terminal(next, 8); expectSynced(); expectArchive();
    expect(captured.store!.plan("demo")!.errors).toEqual([]);
    expect(captured.store!.plan("demo")!.projection.plan?.template_id).toBe(A.id);
  });
});
