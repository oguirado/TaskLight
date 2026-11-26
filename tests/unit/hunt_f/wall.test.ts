import { afterEach, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall, type WorkspaceStatus } from "../../../src/app/agent_wall";
import type { AgentLink } from "../../../src/app/agent_link";
import { createAgentStore, type AgentStore } from "../../../src/app/agent_store";
import { FakeAppClock, idOf, roomEvent, settle } from "../u37c/harness";
import { element, fixture, NOW, submit, typeDraft } from "../u86/helpers";
import { assertState } from "../u125/fixtures";

let wall: AgentWall;
afterEach(() => {
  wall?.destroy();
  document.body.replaceChildren();
});

function mount(store: AgentStore, post: AgentLink["post"] = async () => ({ ok: false, code: "stopped" })) {
  const status: WorkspaceStatus = {
    link: { kind: "linked", nonce: "demo-session" }, rooms: ["demo"], synced: ["demo"],
  };
  const host = document.createElement("div");
  const chat = document.createElement("div");
  document.body.append(host, chat);
  const clock = new FakeAppClock();
  clock.t = NOW;
  wall = startAgentWall({ store, wallHost: host, chatHost: chat, clock, initialView: "wall",
    userAgent: "reader", link: { post }, reviewer: { review: async () => undefined },
    workspaceStatus: () => status });
  return { host, chat, status };
}

function openTask(host: HTMLElement, taskId: string) {
  const toggle = element<HTMLButtonElement>(host, ".messages-toggle");
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  element<HTMLButtonElement>(host, `.messages-task[data-task-vm-id="plan:demo:${taskId}"]`).click();
  expect(wall.selection()?.taskId).toBe(taskId);
}

it("reassignment clears a parked draft", () => {
  const f = fixture();
  f.open();
  f.task("worker-a", "First");
  f.task("worker-b", "Second");
  const { host, chat } = mount(f.store);
  openTask(host, "T01");
  typeDraft(chat, "Question for the original assignee");
  openTask(host, "T02");
  expect(wall.chat()?.getDraft()).toBe("");
  f.op("demo", { kind: "task.release", task_id: "T01" }, "worker-a");
  f.op("demo", { kind: "task.claim", task_id: "T01" }, "worker-c");
  wall.refresh();
  openTask(host, "T01");
  expect(wall.selection()?.assignee).toBe("worker-c");
  expect(wall.chat()?.getDraft()).toBe("");
});

it("a reply follows its acknowledged question", async () => {
  const f = fixture();
  f.open();
  f.task();
  const post = vi.fn(async () => ({ ok: true as const, id: idOf(3), lamport: 3 }));
  const { host, chat } = mount(f.store, post);
  openTask(host, "T01");
  typeDraft(chat, "When will it ship?");
  submit(chat);
  await settle();
  expect(post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-a", text: "When will it ship?" });
  const question = f.event("demo", "reader", "question", "When will it ship?", { to: "worker-a" });
  expect(question.id).toBe(idOf(3));
  f.event("demo", "worker-a", "answer", "Tomorrow", { re: question.id });
  wall.refresh();
  expect([...chat.querySelectorAll(".chat-text")].map(node => node.textContent))
    .toEqual(["When will it ship?", "Tomorrow"]);
});

it("retained legacy activity survives display eviction", () => {
  const store = createAgentStore({ maxBytesPerRoom: 64 });
  expect(store.ingestChecked(roomEvent(1, "demo", { act: "heartbeat" }))).toBe("accepted");
  expect(store.events("demo")).toEqual([]);
  expect(store.states()).toContainEqual(expect.objectContaining({ room: "demo", agent: "worker-1" }));
  const { host } = mount(store);
  assertState(host, "Legacy activity only", "Ask the harness to create a shared plan");
});

it("acknowledgement preserves a retyped draft", async () => {
  const f = fixture();
  f.open();
  f.task();
  let acknowledge!: () => void;
  const post = vi.fn(() => new Promise<{ ok: true; id: string; lamport: number }>(resolve => {
    acknowledge = () => resolve({ ok: true, id: idOf(3), lamport: 3 });
  }));
  const { host, chat } = mount(f.store, post);
  openTask(host, "T01");
  typeDraft(chat, "Status?");
  submit(chat);
  expect(post).toHaveBeenCalledTimes(1);
  typeDraft(chat, "");
  typeDraft(chat, "Status?");
  expect(wall.chat()?.getDraft()).toBe("Status?");
  acknowledge();
  await settle();
  expect(chat.querySelector('[data-delivery="delivered"]')).not.toBeNull();
  expect(wall.chat()?.getDraft()).toBe("Status?");
});

it("stale inventory includes updates verified on another tab", () => {
  const store = createAgentStore();
  function deploy(n: number, agent: string) {
    const row = roomEvent(n, "demo", { agent, act: "op", text: "", op: {
      kind: "agent.lifecycle", run_id: "session", state: "deployed", op_id: "start-" + agent,
    } });
    expect(store.ingestChecked(row)).toBe("accepted");
  }
  deploy(1, "alpha");
  const { host, status } = mount(store);
  const tab = (view: string) => element<HTMLButtonElement>(host, `button[data-nav="${view}"]`).click();
  const board = () => element(host, 'section[aria-label="Agents"]');
  tab("swarm");
  expect(board().textContent).toContain("alpha");
  tab("memory");
  status.synced = [];
  deploy(2, "bravo");
  wall.refresh();
  status.synced = ["demo"];
  wall.refresh();
  expect(store.plan("demo")?.projection.agent_lifecycle?.bravo?.lifecycle).toBe("deployed");

  status.synced = [];
  status.roomErrors = { demo: "room_read_failed" };
  deploy(3, "charlie");
  wall.refresh();
  tab("swarm");
  const snapshot = board();
  expect(snapshot.querySelector('[role="alert"]')?.textContent)
    .toBe("Can't read this workspace: Room data could not be read.");
  expect(snapshot.textContent).toMatch(/stale/i);
  expect(snapshot.textContent).toContain("alpha");
  expect(snapshot.textContent).not.toContain("charlie");
  expect(snapshot.textContent).toContain("bravo");
});
