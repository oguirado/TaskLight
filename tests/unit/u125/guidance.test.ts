import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanProjection } from "../../../src/plan/types";
import { emptyProjection } from "../../../src/plan";
import { ERROR, HOSTILE, NOW, REGISTRATION_LABELS, STATE_COPY, assertNotice, assertState, assertSuppressed,
  control, dataFixture, flush, mount, noExecutableText, observation, politeText,
  selectRoom, text, visible, walls } from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this oracle"); }));
});
afterEach(() => {
  for (const wall of walls.splice(0)) wall.destroy();
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function refresh(h: ReturnType<typeof mount>) { h.wall.refresh(); await flush(); }
function registeredData(records: NonNullable<PlanProjection["agent_lifecycle"]> | undefined) {
  const data = dataFixture(); data.memory();
  const projection = data.real.plan("demo")!.projection;
  if (records === undefined) delete projection.agent_lifecycle;
  else projection.agent_lifecycle = records;
  data.snapshot(projection); return data;
}

describe("U125 A1 transport, hello membership and room replay", () => {
  it.each([
    ["connecting", observation({ kind: "connecting", attempt: 1 }), "Connecting to bridge", "Check workspace connection setup"],
    ["unreachable", observation({ kind: "unreachable", reason: "RETRIES_EXHAUSTED" }), "Bridge disconnected", "Open workspace help"],
    ["resyncing", observation({ kind: "resyncing", nonce: "session-a" }), "Syncing workspace", "Wait for room replay"],
    ["linked without hello", { ...observation(), rooms: [], synced: [] }, "Syncing workspace", "Wait for room replay"],
    ["selected replay incomplete", { ...observation(), synced: [] }, "Syncing workspace", "Wait for room replay"],
  ] as const)("A1 %s takes precedence over projection failures and M3 notices", async (_label, status, heading, action) => {
    const data = dataFixture(); data.store.plan.mockImplementation(() => { throw new Error(ERROR); });
    const h = mount({ data, status }); await flush();
    assertState(h.wallHost, heading, action); assertSuppressed(h.wallHost);
  });
  it("A1 synchronized empty room has an Empty workspace heading and help action", async () => {
    const h = mount(); await flush();
    assertState(h.wallHost, "Empty workspace", "Open workspace help");
    expect(text(h.wallHost)).toContain("demo");
  });
  it("A1 exposes hello-listed rooms before any event and keeps the chosen room across refreshes", async () => {
    const status = { ...observation(), rooms: ["demo", "work"], synced: ["demo"] };
    const h = mount({ data: dataFixture([]), status }); await flush();
    selectRoom(h.wallHost, "work");
    assertState(h.wallHost, "Syncing workspace", "Wait for room replay");
    status.rooms = ["work", "demo", "third"];
    await refresh(h);
    expect(h.wallHost.querySelector(".app")?.getAttribute("data-workspace")).toBe("work");
    assertState(h.wallHost, "Syncing workspace", "Wait for room replay");
    selectRoom(h.wallHost, "demo");
    assertState(h.wallHost, "Empty workspace", "Open workspace help");
  });
  it("A1 ready room still shows syncing separately until its selected replay completes", async () => {
    const data = dataFixture(); data.open();
    const h = mount({ data, status: { ...observation(), synced: [] }, view: "wall" }); await flush();
    assertState(h.wallHost, "Syncing workspace", "Wait for room replay");
    expect(text(h.wallHost)).toContain("Scratch verification");
    assertSuppressed(h.wallHost);
  });
  it("M4 Bridge connected requires both linked state and current hello membership", async () => {
    const h = mount({ status: { ...observation(), rooms: [], synced: [] } }); await flush();
    expect(text(h.wallHost)).not.toContain("Bridge connected");
    h.status.rooms = ["demo"]; await refresh(h);
    expect(text(h.wallHost)).toContain("Bridge connected");
    h.status.synced = []; await refresh(h);
    assertState(h.wallHost, "Syncing workspace", "Wait for room replay");
  });
});

describe("U125 A2 selected-room classification and precedence", () => {
  it("A2 legacy-only history is distinct from empty and planning memory", async () => {
    const data = dataFixture();
    expect(data.real.ingestChecked({ id: "e-0000000000000030", lamport: 48, ts: NOW - 500,
      room: "demo", agent: "alpha", act: "heartbeat", text: "Legacy heartbeat" })).toBe("accepted");
    const h = mount({ data }); await flush();
    assertState(h.wallHost, "Legacy activity only", "Ask the harness to create a shared plan");
    expect(text(h.wallHost)).toContain("swarm_coordinator");
  });
  it("A2 accepted memory-only history with null plan is No plan yet", async () => {
    const data = dataFixture(); data.memory(); const h = mount({ data }); await flush();
    expect(data.real.plan("demo")?.projection.plan).toBeNull();
    assertState(h.wallHost, "No plan yet", "Ask the harness to seed required memory and create a plan");
    expect(text(h.wallHost)).toContain("swarm_coordinator");
  });
  it("A2 accepted lifecycle-only history takes precedence over legacy activity", async () => {
    const data = dataFixture();
    data.emit({ kind: "agent.lifecycle", state: "deployed", run_id: "r1", harness: "Fixture harness", op_id: "deploy-alpha-0001" });
    const h = mount({ data }); await flush();
    assertState(h.wallHost, "No plan yet", "Ask the harness to seed required memory and create a plan");
  });
  it("A2 a valid plan without tasks is No tasks yet", async () => {
    const data = dataFixture(); data.open("demo", "Scratch verification", false);
    const h = mount({ data }); await flush();
    assertState(h.wallHost, "No tasks yet", "Ask the harness to add work");
    expect(text(h.wallHost)).toContain("swarm_coordinator");
  });
  it("A2 empty history wins over a compatibility projection with null plan", async () => {
    const h = mount(); await flush();
    assertState(h.wallHost, "Empty workspace", "Open workspace help");
  });
  it.each(["missing projection", "throwing projection reader", "throwing event reader", "fold failure"])(
    "A2 %s produces Workspace unavailable rather than Empty workspace", async mode => {
      const data = dataFixture(); data.memory();
      if (mode === "missing projection") data.overrides.set("demo", undefined);
      if (mode === "throwing projection reader") data.store.plan.mockImplementation(() => { throw new Error(ERROR); });
      if (mode === "throwing event reader") data.store.events.mockImplementation(() => { throw new Error(ERROR); });
      if (mode === "fold failure") {
        const result = data.real.plan("demo")!;
        data.overrides.set("demo", { ...result, invalidOps: 1,
          errors: [{ id: "e-0000000000000040", lamport: 64, code: "bad_op" }] });
      }
      const h = mount({ data }); await flush();
      assertState(h.wallHost, "Workspace unavailable", "Ask the harness to inspect the room");
    });
  it("A2 a ready plan with work has no empty-state overlay even when a phase filters out its tasks", async () => {
    const data = dataFixture(); data.open(); const h = mount({ data, view: "wall" }); await flush();
    const phase = [...h.wallHost.querySelectorAll<HTMLButtonElement>("button[data-phase-id]")]
      .find(node => node.dataset.phaseId === "review");
    expect(phase, "Existing plan phase filter is a preserved control").toBeDefined(); phase!.click();
    expect(text(h.wallHost)).toContain("Scratch verification");
    for (const [heading] of STATE_COPY) expect([...h.wallHost.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")]
      .map(node => text(node))).not.toContain(heading);
  });
});

describe("U125 A3 explicit registration, deployment and retained cards", () => {
  it("A3 an explicit empty lifecycle map shows both independent notices and verbatim actions", async () => {
    const h = mount({ data: registeredData({}) }); await flush();
    const body = text(h.wallHost);
    assertNotice(h.wallHost, "No harness connected", "No harness registration recorded here; live MCP connection status is unknown", "demo");
    assertNotice(h.wallHost, "No agents deployed", "No active deployment recorded; ask your harness to deploy agents", "demo");
    const hooksReference = [...h.wallHost.querySelectorAll("a[href]")]
      .some(link => /(?:^|\/)HARNESS_HOOKS\.md(?:$|[#?])/.test(link.getAttribute("href") ?? ""));
    expect(hooksReference || /HARNESS_HOOKS\.md|hook.{0,100}(?:setup|set up|install|configur)|(?:setup|set up|install|configur).{0,100}hook/i.test(body),
      "Deployment guidance refers to documented hook setup").toBe(true);
  });
  it.each(["missing", "explicit undefined"])("A3 %s lifecycle map yields unknown labels and never empty-map claims", async mode => {
    const data = registeredData(undefined);
    if (mode === "explicit undefined") Reflect.set(data.overrides.get("demo")!.projection, "agent_lifecycle", undefined);
    const h = mount({ data }); await flush();
    const body = text(h.wallHost);
    expect(body).toContain("Harness registration unknown"); expect(body).toContain("Agent deployment unknown");
    expect(body).not.toContain("No harness connected"); expect(body).not.toContain("No agents deployed");
  });
  it.each(["deployed", "alive"] as const)("A3 %s without a non-empty harness still needs harness registration", async lifecycle => {
    const h = mount({ data: registeredData({ alpha: { lifecycle, run_id: "r1", harness: "" } }) }); await flush();
    expect(text(h.wallHost)).toContain("No harness connected");
    expect(text(h.wallHost)).not.toContain("No agents deployed");
  });
  it.each(["finished", "failed"] as const)("A3 %s registration retains its card but is not an active deployment", async lifecycle => {
    const h = mount({ data: registeredData({ alpha: { lifecycle, run_id: "r1", harness: "Fixture harness" } }) }); await flush();
    expect(text(h.wallHost)).toContain("alpha");
    expect(text(h.wallHost)).toContain(lifecycle === "failed" ? "Failed" : "Finished");
    expect(text(h.wallHost)).not.toContain("No harness connected");
    expect(text(h.wallHost)).toContain("No agents deployed");
  });
  it("A3 the specified deployed fixture retains Deployed · no plan yet and has no false notices", async () => {
    const h = mount({ data: registeredData({ alpha: { lifecycle: "deployed", run_id: "r1", harness: "Fixture harness" } }) }); await flush();
    expect(text(h.wallHost)).toContain("alpha"); expect(text(h.wallHost)).toContain("Deployed · no plan yet");
    expect(text(h.wallHost)).not.toContain("No agents deployed"); expect(text(h.wallHost)).not.toContain("No harness connected");
  });
  it("A3 ownership and fresh activity keep unregistered owners but prove neither harness nor deployment", async () => {
    const data = dataFixture(); data.open();
    data.emit({ kind: "micro.set", micro_id: "T01.M01", state: "active", op_id: "scratch-active-0001" });
    data.emit({ kind: "activity.beat", task_id: "T01", micro_id: "T01.M01", run_id: "r1", op_id: "scratch-beat-0001" });
    const h = mount({ data }); await flush();
    expect(text(h.wallHost)).toContain("alpha");
    expect(text(h.wallHost)).toContain("No harness connected"); expect(text(h.wallHost)).toContain("No agents deployed");
  });
  it.each(["connecting", "unreachable", "resyncing", "unsynced", "unknown"])(
    "A3 Amendment B suppresses every registration/deployment notice while %s", async gate => {
      const status = observation();
      if (gate === "connecting") status.link = { kind: "connecting", attempt: 1 };
      if (gate === "unreachable") status.link = { kind: "unreachable", reason: "NOT_LISTED" };
      if (gate === "resyncing") status.link = { kind: "resyncing", nonce: "session-a" };
      if (gate === "unsynced") status.synced = [];
      const h = mount({ data: registeredData({}), status, observe: gate !== "unknown" }); await flush();
      assertSuppressed(h.wallHost);
      // Also require the controlling state; an empty panel cannot satisfy suppression.
      const expected = gate === "connecting" ? STATE_COPY[1] : gate === "unreachable" ? STATE_COPY[2]
        : gate === "unknown" ? STATE_COPY[0] : STATE_COPY[3];
      assertState(h.wallHost, expected[0], expected[1]);
    });
});

describe("U125 A4 room isolation and external plan updates", () => {
  it("A4 goal mission rules and the strict scratch plan appear without reload, including alpha", async () => {
    const data = dataFixture(); const h = mount({ data, view: "wall" }); await flush();
    data.open(); await refresh(h);
    expect(text(h.wallHost)).toContain("Scratch verification"); expect(text(h.wallHost)).toContain("alpha");
    expect(h.wallHost.querySelector('[data-task-id="T01"]')).not.toBeNull();
    for (const [heading] of STATE_COPY) expect([...h.wallHost.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")]
      .map(node => text(node))).not.toContain(heading);
  });
  it("A4 switching rooms and back never leaks plan title or harness registration", async () => {
    const data = dataFixture(["demo", "work"]); data.open();
    data.emit({ kind: "agent.lifecycle", state: "deployed", run_id: "r1", harness: "Fixture harness", op_id: "deploy-alpha-0001" });
    data.memory("work");
    const h = mount({ data, status: { ...observation(), rooms: ["demo", "work"], synced: ["demo", "work"] }, view: "wall" }); await flush();
    selectRoom(h.wallHost, "work");
    expect(text(h.wallHost)).not.toContain("Scratch verification");
    assertState(h.wallHost, "No plan yet", "Ask the harness to seed required memory and create a plan");
    expect(text(h.wallHost)).toContain("No harness connected");
    selectRoom(h.wallHost, "demo");
    expect(text(h.wallHost)).toContain("Scratch verification"); expect(text(h.wallHost)).toContain("alpha");
    expect(text(h.wallHost)).not.toContain("No harness connected");
  });
});

describe("U125 A5 connection truth and read-only observation", () => {
  it.each(["missing", "throwing", "null link"])("A5 %s workspace observation remains Connection unknown despite a linked fallback", async mode => {
    const h = mount({ observe: mode !== "missing", status: mode === "null link" ? { ...observation(), link: null } : observation(),
      ...(mode === "throwing" ? { readStatus: () => { throw new Error(ERROR); } } : {}) }); await flush();
    assertState(h.wallHost, "Connection unknown", "Open workspace help"); assertSuppressed(h.wallHost);
    expect(text(h.wallHost)).not.toContain("Bridge connected");
  });
  it("A5 link-only disconnect is visible within 1000ms while browser is online, retaining qualified saved work", async () => {
    const data = dataFixture(); data.open(); data.legacy(); const h = mount({ data, view: "wall" }); await flush();
    expect(h.review.mock.calls.length, "A nonempty reviewer fixture makes the no-extra-review gate meaningful").toBeGreaterThan(0);
    const reviews = h.review.mock.calls.length, posts = h.post.mock.calls.length;
    h.status.link = { kind: "unreachable", reason: "RETRIES_EXHAUSTED" };
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(navigator.onLine).toBe(true);
    assertState(h.wallHost, "Bridge disconnected", "Open workspace help");
    expect(text(h.wallHost)).toContain("Saved progress; connection unavailable");
    expect(text(h.wallHost)).toContain("Scratch verification"); expect(text(h.wallHost)).toContain("alpha");
    expect(text(h.wallHost)).not.toContain("Bridge connected");
    expect(h.review).toHaveBeenCalledTimes(reviews); expect(h.post).toHaveBeenCalledTimes(posts);
    expect(text(h.wallHost)).toContain("Cloud blocked by room policy");
  });
  it("M4 destroys every observer timer and prevents late observation or transport calls", async () => {
    const h = mount(); await flush(); h.wall.destroy();
    const reads = h.readStatus.mock.calls.length, reviews = h.review.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000); await flush();
    expect(h.readStatus).toHaveBeenCalledTimes(reads); expect(h.review).toHaveBeenCalledTimes(reviews);
    expect(h.post).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("U125 A6 hostile text, help focus and announcements", () => {
  it("A6 hostile plan title stays literal without an executable element or URL", async () => {
    const data = dataFixture(); data.open("demo", HOSTILE);
    const h = mount({ data, view: "wall" }); await flush();
    expect(text(h.wallHost)).toContain(HOSTILE); noExecutableText(h.wallHost);
  });
  it("A6 Amendment B hostile room slug is literal in room-specific guidance", async () => {
    const data = dataFixture([]); data.snapshot(emptyProjection(), HOSTILE);
    const h = mount({ data, status: { ...observation(), rooms: [HOSTILE], synced: [HOSTILE] } }); await flush();
    expect(text(h.wallHost)).toContain(HOSTILE); noExecutableText(h.wallHost);
    assertState(h.wallHost, "Empty workspace", "Open workspace help");
  });
  it("A6 throwing reader error is passive text, never an executable URL", async () => {
    const data = dataFixture(); data.store.plan.mockImplementation(() => { throw new Error(ERROR); });
    const h = mount({ data }); await flush();
    assertState(h.wallHost, "Workspace unavailable", "Ask the harness to inspect the room");
    expect(text(h.wallHost)).toContain(ERROR);
    noExecutableText(h.wallHost);
  });
  it("M5 Open workspace help opens existing registration help, focuses heading, and Close restores its trigger", async () => {
    const h = mount(); await flush();
    const trigger = control(h.wallHost, "Open workspace help"); trigger.focus(); trigger.click();
    const help = [...h.wallHost.querySelectorAll<HTMLElement>("section,[role=dialog]")]
      .find(node => visible(node) && text(node).includes("python3 -m bridge.room.mcp") && node.querySelector("h2,[role=heading]"));
    expect(help, "Reuse existing New workspace help with documented MCP registration").toBeDefined();
    expect(help!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.matches("h1,h2,h3,h4,h5,h6,[role=heading]")).toBe(true);
    const body = text(help!);
    expect(body).toContain("Preview"); expect(body).toContain("Install"); expect(body).toContain("--apply");
    expect(body).toContain("CW_HOME"); expect(body).toMatch(/same CW_HOME/);
    control(help!, "Close").click();
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
    expect(h.wallHost.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toContain("Open workspace help");
    expect(h.post).not.toHaveBeenCalled();
  });
  it("M6 changed guidance is announced politely and unchanged refreshes make no repeated announcement", async () => {
    const h = mount({ status: observation({ kind: "connecting", attempt: 1 }) }); await flush();
    h.status.link = { kind: "linked", nonce: "session-a" }; h.status.synced = []; await refresh(h);
    expect(politeText(h.wallHost)).toContain("Syncing workspace");
    expect(politeText(h.wallHost)).toContain("demo");
    const announcements: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const node = record.target instanceof Element ? record.target : record.target.parentElement;
        if (node?.closest('[aria-live="polite"],[role="status"]')) announcements.push(text(node));
      }
    });
    observer.observe(h.wallHost, { subtree: true, childList: true, characterData: true });
    try {
      for (let i = 0; i < 3; i++) await refresh(h);
      expect(announcements, "An unchanged semantic state must not rewrite its live text").toEqual([]);
    } finally { observer.disconnect(); }
  });
  // A-V1: the swarm navigation label is now Agents.
  it("M6 guidance leaves existing landing navigation, Models and Messages (legacy) available", async () => {
    const h = mount({ view: "wall" }); await flush();
    expect(h.wallHost.querySelector(".app")?.getAttribute("data-view")).toBe("wall");
    for (const label of ["Wall", "Diary", "Memory", "Agents", "Models", "Messages (legacy)", "New workspace"]) control(h.wallHost, label);
    expect(h.wallHost.querySelector('textarea,input:not([type="hidden"]),[contenteditable="true"]')).toBeNull();
    expect(h.chatHost.getAttribute("data-open")).toBe("false");
  });
});

describe("U125 A7 oracle sensitivity without editing production", () => {
  it("A7 a constant empty panel cannot pass the A1-A2 heading oracle", () => {
    for (const [heading, action] of STATE_COPY) {
      expect(() => assertState(document.createElement("div"), heading, action)).toThrow();
    }
  });
  it("A7 a forged connected claim cannot pass the A5 disconnect oracle", () => {
    const wrong = document.createElement("div"); wrong.append(document.createTextNode("Bridge connected"));
    expect(() => assertState(wrong, "Bridge disconnected", "Open workspace help")).toThrow();
  });
  it("A7 forced-connected observation fails the independently expected disconnect check", async () => {
    const h = mount({ status: observation({ kind: "unreachable", reason: "RETRIES_EXHAUSTED" }),
      readStatus: () => observation({ kind: "linked", nonce: "forged-session" }) });
    await flush();
    expect(() => assertState(h.wallHost, "Bridge disconnected", "Open workspace help")).toThrow();
  });
  it("A7 unknown lifecycle must not be replaced by empty-map notices", async () => {
    const h = mount({ data: registeredData(undefined) }); await flush();
    const headings = text(h.wallHost);
    expect(headings).toContain(REGISTRATION_LABELS[2]); expect(headings).toContain(REGISTRATION_LABELS[3]);
    expect(headings).not.toContain(REGISTRATION_LABELS[0]); expect(headings).not.toContain(REGISTRATION_LABELS[1]);
  });
});
