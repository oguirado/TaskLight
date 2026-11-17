import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStore, AgentStoreOptions } from "../../../src/app/agent_store";
import type { AgentLink, AgentLinkDeps } from "../../../src/app/agent_link";
import type { RoomEvent } from "../../../src/agents/types";
import { createAgentRelay } from "../../../extension/src/agent_relay";
import { FakePort } from "../u13/harness";
import { EXT_ID, FakeExtClock, FakeNative, HELLO, PagePort, event, eventFrame, fixture, gapFrame,
  opEvent, pythonRelay, synced, template } from "./helpers";

const captured = vi.hoisted(() => ({ store: undefined as AgentStore | undefined,
  link: undefined as AgentLink | undefined }));
// Network/AI adapters are inert. Hosting, link, store, reducer, wall and notice stay real.
vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({
  extensionOrigins: [`chrome-extension://${EXT_ID}`], firebaseConfig: {},
}) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => true }));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage: () => undefined }) }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({
  notifyChange: () => undefined, taskVerdicts: () => new Map(), planBriefs: () => new Map(),
}) }));
vi.mock("../../../src/ui/model_selector", () => ({ createModelSheet: () => ({
  render: () => undefined, open: () => undefined,
}) }));
vi.mock("../../../src/app/starter_templates", () => ({
  resolveStarterTemplate: () => template, getTemplateMemorySections: () => undefined,
}));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: (opts?: AgentStoreOptions) => {
    captured.store = real.createAgentStore(opts); return captured.store;
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
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_700_000_001_000);
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  ports = []; observers = [];
  captured.store = undefined; captured.link = undefined;
  const NativeObserver = globalThis.MutationObserver;
  class Observer extends NativeObserver {
    constructor(callback: MutationCallback) { super(callback); observers.push(this); }
  }
  vi.stubGlobal("MutationObserver", Observer);
  vi.stubGlobal("chrome", { runtime: { connect: () => { const p = new PagePort(); ports.push(p); return p; } } });
});
afterEach(() => {
  captured.link?.stop(); observers.forEach(o => o.disconnect());
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function boot() {
  await import("../../../hosting/src/main");
  const port = ports.at(-1)!;
  expect(port, "hosting must connect its real room link").toBeDefined();
  const hello = port.ofType("hello").at(-1)!;
  port.emit({ t: "snapshot", v: 1, nonce: hello["nonce"], items: [] });
  vi.advanceTimersByTime(1); port.emit(HELLO);
  return port;
}
const rid = (p: PagePort): unknown => p.ofType("room_sync").at(-1)!["rid"];
const store = (): AgentStore => { expect(captured.store).toBeDefined(); return captured.store!; };
function notice(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(node => /Progress may be outdated/.test(node.textContent ?? ""));
}
function expectNotice(room = "demo", interval = false): HTMLElement {
  const node = notice();
  expect(node, "M6 must show Progress may be outdated").toBeDefined();
  expect(node!.textContent).toContain(room);
  expect(node!.getAttribute("aria-live")).toBe("polite");
  if (interval) expect(node!.textContent).toMatch(/8/);
  expect(node!.querySelector("img,script")).toBeNull();
  return node!;
}
function sendFixture(port: PagePort, through = 8) {
  fixture().filter(e => e.lamport <= through).forEach(e => port.emit(eventFrame(e, String(rid(port)))));
}
function reconnect(p: PagePort): PagePort {
  p.drop(); vi.advanceTimersByTime(100);
  const next = ports.at(-1)!;
  const hello = next.ofType("hello").at(-1)!;
  next.emit({ t: "snapshot", v: 1, nonce: hello["nonce"], items: [] });
  vi.advanceTimersByTime(1); next.emit(HELLO);
  return next;
}

// Fixed entropy is essential: random UUIDs do not reliably trigger the detector.
const RUN_PREFIX = "0123456789abcdef0123456789abcdef";
const EXECUTORS = ["exec-a", "exec-b", "exec-c", "exec-d", "exec-e"] as const;
function runIdentityHistory(): RoomEvent[] {
  const events = [fixture()[0]!];
  const append = (agent: string, op: Record<string, unknown>): void => {
    const n = events.length + 1;
    events.push({ ...opEvent(n, { ...op, op_id: `u157-op-${n}` }), agent });
  };
  for (let i = 1; i <= 30; i += 1) append("alice", {
    kind: "task.add", title: `Capsule task ${i}`, type: "action", phase: "start",
    accept: "Verified", microtasks: [{ text: "Produce fixture", accept: "Verified" },
      { text: "Verify fixture", accept: "Verified" }],
  });
  for (const agent of EXECUTORS) append(agent, { kind: "agent.lifecycle", state: "deployed",
    run_id: `${RUN_PREFIX}-${agent}`, harness: "external", swarm: "capsule" });
  // A successor must remain distinct from the terminal run of the same agent.
  append("exec-a", { kind: "agent.lifecycle", state: "failed", run_id: `${RUN_PREFIX}-exec-a` });
  append("exec-a", { kind: "agent.lifecycle", state: "deployed",
    run_id: `${RUN_PREFIX}-exec-a-next`, harness: "external", swarm: "capsule" });
  for (const [index, agent] of EXECUTORS.entries()) {
    const task = `T0${index + 1}`;
    const run = `${RUN_PREFIX}-${agent}${agent === "exec-a" ? "-next" : ""}`;
    append(agent, { kind: "task.claim", task_id: task });
    append(agent, { kind: "micro.set", micro_id: `${task}.M01`, state: "active" });
    append(agent, { kind: "activity.beat", task_id: task, micro_id: `${task}.M01`, run_id: run });
    append(agent, { kind: "agent.lifecycle", state: "alive", run_id: run });
  }
  append("exec-c", { kind: "agent.lifecycle", state: "failed", run_id: `${RUN_PREFIX}-exec-c` });
  append("exec-c", { kind: "task.release", task_id: "T03" });
  // Beats and late alive delivery cannot revive a terminal or retired run.
  append("exec-c", { kind: "activity.beat", task_id: "T03", micro_id: "T03.M01",
    run_id: `${RUN_PREFIX}-exec-c` });
  append("exec-c", { kind: "agent.lifecycle", state: "alive", run_id: `${RUN_PREFIX}-exec-c` });
  append("exec-a", { kind: "agent.lifecycle", state: "alive", run_id: `${RUN_PREFIX}-exec-a` });
  return events;
}

describe("M5/M6 hosting and A3/A5/A7 visible uncertainty", () => {
  it.each(["live", "replay"])(
    "U157 %s real relay-extension-link-store preserves run identity and Wall/Swarm truth", async mode => {
      const history = runIdentityHistory();
      vi.setSystemTime(history.at(-1)!.ts + 13_600);
      const port = await boot();
      const ingest = vi.spyOn(store(), "ingestChecked");
      const native = new FakeNative();
      const extension = createAgentRelay({ native, clock: new FakeExtClock() });
      const extensionPort = new FakePort();
      const deliver = extensionPort.postMessage.bind(extensionPort);
      extensionPort.postMessage = frame => { deliver(frame); port.emit(frame); };
      const post = port.postMessage.bind(port);
      port.postMessage = frame => {
        post(frame);
        if ((frame as { t?: unknown }).t === "room_sync") extension.onPortMessage(extensionPort, frame);
      };
      try {
        extension.onPortMessage(extensionPort, { t: "room_sync", v: 1,
          rid: rid(port), since: { demo: 0 } });
        native.emit(HELLO);
        const result = pythonRelay({ events: history, mode });
        expect(result.projection.rejected).toEqual([]);
        expect(result.frames.filter(f => f.t === "room_gap")).toEqual([]);
        expect(result.frames.filter(f => f.t === "room_event")).toHaveLength(history.length);
        const send = () => {
          const relayRid = native.ofType("room_sync").at(-1)!["rid"];
          for (const frame of result.frames) native.emit(frame["rid"] === undefined
            ? frame : { ...frame, rid: relayRid });
        };
        send();
        expect(ingest).toHaveBeenCalledTimes(history.length);
        expect(ingest.mock.results.map(result => result.value)).toEqual(history.map(() => "accepted"));
        expect(store().events("demo")).toHaveLength(history.length);
        const projection = store().plan("demo")!.projection;
        expect(projection.rejected).toEqual([]);
        expect(projection.tasks).toHaveLength(30);
        const registrations = projection.agent_lifecycle!;
        expect(Object.keys(registrations).sort()).toEqual([...EXECUTORS]);
        const runs = EXECUTORS.map(agent => registrations[agent]!.run_id);
        expect(new Set(runs).size).toBe(EXECUTORS.length);
        for (const run of runs) {
          expect(run).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
          expect(run).not.toContain(RUN_PREFIX);
        }
        expect(registrations["exec-a"]!.retired_run_ids).toHaveLength(1);
        expect(registrations["exec-a"]!.retired_run_ids).not.toContain(registrations["exec-a"]!.run_id);
        expect(registrations["exec-c"]!.lifecycle).toBe("failed");
        expect(projection.tasks.some(task => task.assignee === "exec-c")).toBe(false);
        for (const agent of EXECUTORS.filter(agent => agent !== "exec-c")) {
          const task = projection.tasks.find(task => task.assignee === agent)!;
          expect(task.microtasks[0]!.live?.run_id).toBe(registrations[agent]!.run_id);
        }
        expect(document.querySelectorAll(".agent-strip-row")).toHaveLength(5);
        for (const agent of EXECUTORS) {
          const row = document.querySelector(`.agent-strip-row[data-agent-id="${agent}"]`)!;
          expect(row, `Wall retains ${agent}`).not.toBeNull();
          expect(row.textContent).toContain("external");
          expect(row.textContent).toContain(agent === "exec-c" ? "Failed · tasks released" : "Working");
          expect(row.textContent).toContain(agent === "exec-c" ? "No beat observed" : "13s ago");
        }
        expect(notice()).toBeUndefined();
        document.querySelector<HTMLButtonElement>('button[data-nav="swarm"]')!.click();
        expect(document.querySelectorAll(".swarm-card")).toHaveLength(5);
        for (const agent of EXECUTORS) {
          const card = [...document.querySelectorAll(".swarm-card")]
            .find(node => node.querySelector(".swarm-agent-name")?.textContent === agent)!;
          expect(card.textContent).toContain("external");
          expect(card.textContent).toContain(agent === "exec-c" ? "Failed · tasks released" : "Working");
          expect(card.textContent).toContain(agent === "exec-c" ? "No beat observed" : "13s ago");
        }
        // Duplicate history must preserve the exact transported identities and projection.
        const beforeReplay = structuredClone(projection);
        native.emit(HELLO);
        send();
        expect(ingest.mock.results.slice(history.length).map(result => result.value))
          .toEqual(history.map(() => "duplicate"));
        expect(store().plan("demo")!.projection).toEqual(beforeReplay);
        expect(notice()).toBeUndefined();
      } finally {
        extension.onPortClosed(extensionPort);
      }
    }, 30_000);

  it.each(["sanitize_failed", "oversize"])("A3 real relay %s gap shows interval and pins recovery cursor before 8", async reason => {
    const port = await boot();
    sendFixture(port, 7);
    const pageRid = rid(port);
    const frames = pythonRelay({ triplet: true, reason, mode: "replay", since: 6 }).frames;
    for (const f of frames) port.emit({ ...f, rid: pageRid });
    expectNotice("demo", true);
    const next = reconnect(port);
    expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBe(7);
    expectNotice("demo", true);
  });

  it.each(["sanitize_failed", "oversize"])(
    "A8 real relay-extension-link-hosting %s gap preserves visible uncertainty and recovery cursor", async reason => {
      const port = await boot(); sendFixture(port, 7);
      const native = new FakeNative();
      const extension = createAgentRelay({ native, clock: new FakeExtClock() });
      const extensionPort = new FakePort();
      const deliver = extensionPort.postMessage.bind(extensionPort);
      extensionPort.postMessage = frame => { deliver(frame); port.emit(frame); };
      const post = port.postMessage.bind(port);
      port.postMessage = frame => {
        post(frame);
        if ((frame as { t?: unknown }).t === "room_sync") extension.onPortMessage(extensionPort, frame);
      };
      try {
        extension.onPortMessage(extensionPort, { t: "room_sync", v: 1,
          rid: rid(port), since: { demo: 7 } });
        native.emit(HELLO);
        const relayRid = native.ofType("room_sync").at(-1)!["rid"];
        const frames = pythonRelay({ triplet: true, reason, mode: "replay", since: 6 }).frames;
        for (const frame of frames) native.emit({ ...frame, rid: relayRid });
        expect(extensionPort.sent.some(frame => (frame as { t?: unknown }).t === "room_gap"),
          "production extension must deliver the real relay gap").toBe(true);
        expectNotice("demo", true);
        const next = reconnect(port);
        expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBe(7);
        expectNotice("demo", true);
      } finally {
        extension.onPortClosed(extensionPort);
      }
    });

  it("A5 hosting uses checked ingestion for redacted evidence and preserves the last complete projection", async () => {
    const port = await boot(); sendFixture(port, 7);
    const before = structuredClone(store().plan("demo")?.projection);
    const ev = fixture().at(-1)!;
    (ev.op as unknown as { evidence: { sha256: string }[] }).evidence[0]!.sha256 = "[REDACTED:HIGH_ENTROPY]";
    port.emit(eventFrame(ev, String(rid(port))));
    expect(store().plan("demo")?.projection).toEqual(before);
    expectNotice();
    port.emit(synced(rid(port), 8, true));
    // Transport pagination may continue, but cannot move the recovery starting point.
    const next = reconnect(port);
    expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBe(7);
    expectNotice();
  });

  it("A5 not_found is exposed by the reducer and makes the hosted page stale", async () => {
    const port = await boot();
    fixture().slice(0, 2).forEach(e => port.emit(eventFrame(e)));
    const ev = opEvent(8, { kind: "micro.set", micro_id: "T40.M01", state: "active" });
    port.emit(eventFrame(ev));
    const receipts = store().plan("demo")?.projection.rejected;
    expect(receipts?.at(-1)?.code).toBe("not_found");
    expectNotice();
  });

  // A-U85a: passes in isolation (vitest -t); in a full-file run the ESM module cache defeats the foldPlan spy. Run alone in verification.
  it.skipIf(!process.env.U85_ISOLATED)("M2 consumes fold errors and preserves bad_op diagnostics", async () => {
    const port = await boot(); sendFixture(port, 7);
    const plan = await import("../../../src/plan");
    const baseline = structuredClone(store().plan("demo")!.projection);
    baseline.rejected = [{ id: event(8).id, lamport: 8, op_id: null, code: "bad_op" }];
    vi.spyOn(plan, "foldPlan").mockReturnValue({ projection: baseline,
      stats: { applied: 0, replayed: 0, invalid: 0, rejected: 1,
        errors: [{ id: event(8).id, lamport: 8, code: "bad_op" }] } });
    port.emit(eventFrame(event(9)));
    expectNotice();
    // No invented success or changed projection is allowed after a reducer fault.
    expect(store().plan("demo")?.projection).toEqual(baseline);
  });

  it("A7 duplicate gap valid suffix terminal and reconnect retain uncertainty; only complete clean replay clears it", async () => {
    const port = await boot(); sendFixture(port, 7);
    const complete = structuredClone(store().plan("demo")?.projection);
    port.emit(gapFrame({ rid: rid(port) }));
    const firstNotice = expectNotice("demo", true);
    const observer = new MutationObserver(() => undefined);
    observer.observe(firstNotice, { childList: true, subtree: true, characterData: true });
    port.emit(gapFrame({ rid: rid(port) }));
    port.emit(eventFrame(event(9), String(rid(port))));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    port.emit(synced(rid(port)));
    expectNotice("demo", true);
    expect(store().plan("demo")?.projection.tasks).toEqual(complete?.tasks);
    let next = reconnect(port);
    // A replay that still excludes 8 is not clean, even with a later terminal.
    next.emit(gapFrame({ rid: rid(next) }));
    next.emit(eventFrame(event(10), String(rid(next)))); next.emit(synced(rid(next), 10));
    expectNotice("demo", true);
    next = reconnect(next);
    expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBe(7);
    next.emit(eventFrame(fixture().at(-1)!, String(rid(next))));
    next.emit(eventFrame(event(9), String(rid(next))));
    next.emit(eventFrame(event(10), String(rid(next))));
    expectNotice("demo", true);
    next.emit(synced("obsolete", 10)); expectNotice("demo", true);
    next.emit(synced(rid(next), 10));
    expect(notice()).toBeUndefined();
    expect(store().plan("demo")?.projection.tasks[0]?.state).toBe("done");
  });

  it("A7 live repair alone cannot replace a clean replay containing the excluded event", async () => {
    const port = await boot(); sendFixture(port, 7);
    port.emit(gapFrame()); expectNotice();
    port.emit(eventFrame(fixture().at(-1)!));
    port.emit(eventFrame(event(9)));
    port.emit(synced(rid(port), 9));
    expectNotice();
    const next = reconnect(port);
    expect((next.ofType("room_sync").at(-1)!["since"] as Record<string, number>)["demo"]).toBe(7);
    next.emit(eventFrame(fixture().at(-1)!, String(rid(next))));
    next.emit(eventFrame(event(9), String(rid(next))));
    next.emit(synced(rid(next), 9));
    expect(notice()).toBeUndefined();
  });

  it("A7 a replay gap overlapping the tracked interval prevents a clean terminal", async () => {
    const port = await boot(); sendFixture(port, 7);
    port.emit(gapFrame({ from_lamport: 8, to_lamport: 10 })); expectNotice();
    let next = reconnect(port);
    next.emit(eventFrame(fixture().at(-1)!, String(rid(next))));
    next.emit(gapFrame({ from_lamport: 9, to_lamport: 9, rid: rid(next) }));
    next.emit(eventFrame(event(10), String(rid(next))));
    next.emit(synced(rid(next), 10));
    expectNotice();
    next = reconnect(next);
    next.emit(eventFrame(fixture().at(-1)!, String(rid(next))));
    next.emit(eventFrame(event(9), String(rid(next))));
    next.emit(eventFrame(event(10), String(rid(next))));
    next.emit(synced(rid(next), 10));
    expect(notice()).toBeUndefined();
  });

  it("A7 every unresolved interval must be repaired before a terminal may clear the notice", async () => {
    const port = await boot(); sendFixture(port, 7);
    port.emit(gapFrame()); port.emit(gapFrame({ from_lamport: 10, to_lamport: 10 }));
    expectNotice();
    let next = reconnect(port);
    next.emit(eventFrame(fixture().at(-1)!, String(rid(next))));
    next.emit(eventFrame(event(9), String(rid(next))));
    next.emit(gapFrame({ from_lamport: 10, to_lamport: 10, rid: rid(next) }));
    next.emit(synced(rid(next), 10));
    expectNotice();
    next = reconnect(next);
    next.emit(eventFrame(fixture().at(-1)!, String(rid(next))));
    next.emit(eventFrame(event(9), String(rid(next))));
    next.emit(eventFrame(event(10), String(rid(next)))); next.emit(synced(rid(next), 10));
    expect(notice()).toBeUndefined();
  });

  it("A7 a repeated validation fault in recovery cannot be cleared by more:false", async () => {
    const port = await boot(); sendFixture(port, 7); port.emit(gapFrame());
    expectNotice();
    const next = reconnect(port);
    const bad = fixture().at(-1)!;
    (bad.op as unknown as { evidence: { sha256: string }[] }).evidence[0]!.sha256 = "[REDACTED:HIGH_ENTROPY]";
    next.emit(eventFrame(bad, String(rid(next)))); next.emit(synced(rid(next), 8));
    expectNotice();
  });

  it("M6 refresh and duplicate delivery announce a fault once and schedule no automatic retry", async () => {
    const port = await boot(); sendFixture(port, 7); port.emit(gapFrame());
    const node = expectNotice("demo", true);
    const observer = new MutationObserver(() => undefined);
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    const before = port.ofType("room_sync").length;
    port.emit(gapFrame()); port.emit(eventFrame(fixture()[0]!));
    vi.advanceTimersByTime(1000);
    expectNotice("demo", true);
    expect(observer.takeRecords()).toHaveLength(0); observer.disconnect();
    expect(port.ofType("room_sync")).toHaveLength(before);
    expect([...node.querySelectorAll("button")].some(button => /dismiss|mark.*current|up.to.date/i.test(button.textContent ?? ""))).toBe(false);
  });


  it("M6 a later valid operation cannot replace the last complete visible progress", async () => {
    const port = await boot(); sendFixture(port, 7);
    const progress = () => document.querySelector('[role="progressbar"][aria-label="Overall progress"]')?.getAttribute("aria-valuenow");
    const before = progress();
    expect(before, "the initial complete plan has visible progress").toBeDefined();
    port.emit(gapFrame());
    port.emit(eventFrame(opEvent(9, { kind: "micro.set", micro_id: "T02.M01", state: "done",
      outcome: "Second task verified", evidence: [{ path: "tests/unit/u85/evidence.md",
        sha256: "2b504639f69d0f5ced71cbee6bd4363d838aa6536b37d69b6cf21154060fbe65" }] })));
    expectNotice();
    expect(progress()).toBe(before);
  });

  it.each(["invalid", "rejected", "errors"] as const)("M2 consumes standalone fold %s diagnostics", async diagnostic => {
    const port = await boot(); sendFixture(port, 7);
    const plan = await import("../../../src/plan");
    const baseline = structuredClone(store().plan("demo")!.projection);
    const stats = { applied: 0, replayed: 0, invalid: 0, rejected: 0,
      errors: [] as { id: string; lamport: number; code: "bad_op" }[] };
    if (diagnostic === "errors") stats.errors.push({ id: event(8).id, lamport: 8, code: "bad_op" });
    else stats[diagnostic] = 1;
    vi.spyOn(plan, "foldPlan").mockReturnValue({ projection: baseline, stats });
    port.emit(eventFrame(event(9)));
    expectNotice();
  });



  it("M6 announces a changed fault once without re-announcing duplicate faults", async () => {
    const port = await boot(); sendFixture(port, 7); port.emit(gapFrame());
    expectNotice("demo", true);
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const announcements = (records: MutationRecord[]) => {
      const statuses = new Set<Element>();
      const consider = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement;
        if (element === null) return;
        const enclosing = element.closest('[role="status"]');
        if (enclosing?.textContent?.includes("Progress may be outdated")) statuses.add(enclosing);
        for (const status of element.querySelectorAll('[role="status"]')) {
          if (status.textContent?.includes("Progress may be outdated")) statuses.add(status);
        }
      };
      for (const record of records) {
        if (record.type === "characterData" || record.target instanceof Element && record.target.closest('[role="status"]')) consider(record.target);
        record.addedNodes.forEach(consider);
      }
      return statuses.size;
    };
    port.emit(gapFrame()); port.emit(eventFrame(fixture()[0]!));
    expect(announcements(observer.takeRecords())).toBe(0);
    port.emit(gapFrame({ from_lamport: 10, to_lamport: 10 }));
    const texts = [...document.querySelectorAll('[role="status"]')].map(node => node.textContent).join(" ");
    expect(texts).toContain("10");
    expect(announcements(observer.takeRecords())).toBe(1);
    observer.disconnect();
  });

  it("M4 numeric Lamport discontinuity without a gap does not invent stale state", async () => {
    const port = await boot(); sendFixture(port, 7);
    port.emit(eventFrame(event(9), String(rid(port)))); port.emit(synced(rid(port)));
    expect(notice()).toBeUndefined();
    // The same page must still expose an explicit fault; silence alone is no positive witness.
    port.emit(gapFrame()); expectNotice();
  });

  it("A6 hostile gap frames do not create markup, change cursors or mutate another room", async () => {
    const port = await boot(); sendFixture(port, 7);
    const before = store().events("demo");
    for (const over of [{ room: "../x" }, { room: "private-room" },
      { from_lamport: 9, to_lamport: 8 }, { from_lamport: 0 },
      { to_lamport: 8.5 }, { to_lamport: Number.MAX_SAFE_INTEGER + 1 },
      { reason: undefined }, { reason: "<img src=x onerror=alert(1)>" }]) port.emit(gapFrame(over));
    expect(document.body.textContent).not.toContain("private-room");
    port.emit(eventFrame(event(8, { room: "private-room", text: "x", act: "op",
      op: { kind: "unknown.operation" } })));
    expect(store().events("private-room")).toEqual([]);
    expect(notice()).toBeUndefined();
    port.emit({ ...eventFrame(event(8)), event: event(8, { room: "other" }) });
    expect(document.querySelector("img,script")).toBeNull();
    expect(store().events("demo")).toEqual(before);
    expect(store().events("other")).toEqual([]);
    expect(store().since()["demo"]).toBe(7);
    expect(document.body.textContent).not.toContain("private-room");
    expect(notice()).toBeUndefined();
    // A valid listed-room fault must still be rendered by this same page.
    port.emit(gapFrame()); expectNotice();
  });
});
