// A-Q1: U148/U150 named non-article task roots retain their classes and identity hooks.
// U38 G5: the human user (rooms.agent, default wall-user) is never an agent task; user messages show only in the chat of the agent they were sent to.
import { afterEach, describe, expect, it } from "vitest";
import { createAgentStore, toChatVM, toWallVM } from "../../../src/app/agent_store";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { FakeAppClock, settle } from "../u37c/harness";
import { ev, mkState } from "./helpers";

const USER = "wall-user";
const T = 1_700_000_000_000;
let wall: AgentWall | undefined;
afterEach(() => { wall?.destroy(); wall = undefined; document.body.replaceChildren(); });

describe("G5 toWallVM(userAgent)", () => {
  const states = [mkState({ agent: USER, contract: undefined as never, steps: 0, lastText: "Why Rust?" }), mkState({ agent: "worker-1" }), mkState({ agent: "worker-2" })];
  const opts = { nowMs: T, model: { state: "unavailable" as const, label: "x" }, network: "online" as const, userAgent: USER } as Parameters<typeof toWallVM>[2];
  it("no task is built for the user's own identity; the other agents keep theirs", () => {
    const vm = toWallVM(states, new Map(), opts);
    expect(vm.tasks.map((t) => t.id)).toEqual(["agent:demo:worker-1", "agent:demo:worker-2"]);
    expect(vm.tasks.some((t) => t.project === USER || t.title.includes(USER))).toBe(false);
  });
  it("a different userAgent value is honoured (identity is configuration, not the literal 'wall-user')", () => {
    const vm = toWallVM(states, new Map(), { ...opts, userAgent: "worker-2" } as Parameters<typeof toWallVM>[2]);
    expect(vm.tasks.map((t) => t.project)).toEqual(["wall-user", "worker-1"]);
  });
});

describe("G5 chat visibility", () => {
  const events = [
    ev(1, "demo", "worker-1", "question", "which crate?", T),
    ev(2, "demo", USER, "question", "to worker one", T + 1000, { to: "worker-1" }),
    ev(3, "demo", USER, "question", "to worker two", T + 2000, { to: "worker-2" }),
    ev(4, "demo", USER, "question", "to nobody in particular", T + 3000),
  ];
  const chat = (agent: string) => toChatVM(mkState({ agent }), events, { userAgent: USER, nowMs: T + 5000, sending: false }).messages.map((m) => m.text);
  it("a user message is in the chat of its `to` agent only", () => {
    expect(chat("worker-1")).toEqual(["which crate?", "to worker one"]);
    expect(chat("worker-2")).toEqual(["to worker two"]);
  });
  it("a user message without `to` appears in no agent chat", () => {
    expect(chat("worker-1")).not.toContain("to nobody in particular");
    expect(chat("worker-2")).not.toContain("to nobody in particular");
  });
});

describe("G5 end to end (real store, wall and chat)", () => {
  async function run() {
    const store = createAgentStore();
    store.ingest(ev(1, "demo", "worker-1", "plan", "Plan", T, { plan: { title: "Add CSV export", steps: [{ text: "a" }, { text: "b" }] } }));
    store.ingest(ev(2, "demo", USER, "question", "Why are you rewriting in Rust?", T + 1000, { to: "worker-1" }));
    const wallHost = document.createElement("div"); const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
    const clock = new FakeAppClock(); clock.t = T + 5000;
    wall = startAgentWall({ wallHost, chatHost, link: { post: async () => ({ ok: true as const, id: "e-0000000000000009", lamport: 9 }) }, store, reviewer: { review: async () => undefined }, clock, userAgent: USER });
    await settle(10);
    return { wallHost, chatHost };
  }
  it("the wall shows exactly one task card (the agent), no 'wall-user' card, banner, or text", async () => {
    const { wallHost } = await run();
    expect(wallHost.querySelectorAll(".task[data-task-id]")).toHaveLength(1);
    expect([...wallHost.querySelectorAll(".project-name")].map((e) => e.textContent)).toEqual(["worker-1"]);
    expect(wallHost.textContent ?? "").not.toContain(USER);
    expect(wallHost.querySelector(".view-sub")?.textContent ?? "").toContain("1 open tasks");
  });
  it("the user's message appears in the chat of the agent it was sent to", async () => {
    const { chatHost } = await run();
    const msgs = [...chatHost.querySelectorAll(".chat-msg")];
    expect(msgs.map((m) => m.querySelector(".chat-text")?.textContent)).toContain("Why are you rewriting in Rust?");
    expect(msgs.find((m) => m.getAttribute("data-from") === "user")).toBeDefined();
  });
});
