import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => {
  const deny = (name: string) => vi.fn(() => { expect.fail(`Forbidden boundary: ${name}`); });
  return { transport: deny("transport"), provider: deny("provider"), storage: deny("storage"),
    refold: deny("history folding"), store: deny("store creation") };
});
vi.mock("../../../src/plan/reducer", async original => ({ ...await original<Record<string, unknown>>(), foldPlan: boundary.refold, applyOp: boundary.refold }));
vi.mock("../../../src/agents", async original => ({ ...await original<Record<string, unknown>>(), foldRoomWithStats: boundary.refold }));
vi.mock("../../../src/app/agent_store", () => ({ createAgentStore: boundary.store }));
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: boundary.transport }));
vi.mock("../../../src/app/model_port", () => ({ createPageModelTransport: boundary.transport, attachModelChannel: boundary.transport }));
vi.mock("../../../src/app/model_services", () => ({ createModelServices: boundary.provider }));
vi.mock("../../../src/ai/hybrid", () => ({ createHybrid: boundary.provider }));

import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { card, deterministic, event, freeze, frozenFixture, input, keyboardActivate, registration, taskControl } from "./fixtures";

deterministic();
function guard(): void {
  for (const spy of Object.values(boundary)) spy.mockClear();
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Worker"]) vi.stubGlobal(name, boundary.transport);
  vi.stubGlobal("indexedDB", { open: boundary.storage, deleteDatabase: boundary.storage });
  vi.stubGlobal("chrome", { runtime: { connect: boundary.transport, sendMessage: boundary.transport },
    storage: { local: { get: boundary.storage, set: boundary.storage }, session: { get: boundary.storage, set: boundary.storage } } });
  for (const method of ["getItem", "setItem", "removeItem", "clear"] as const) vi.spyOn(Storage.prototype, method).mockImplementation(boundary.storage);
  vi.spyOn(window, "postMessage").mockImplementation(boundary.transport); vi.spyOn(window, "open").mockImplementation(boundary.transport);
}
function untouched(): void { for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled(); }

describe("A5-A6 / M1 observational boundaries", () => {
  it("M1 frozen cached projection derivation invokes no refolding, provider, transport, storage, store or timers", () => {
    guard(); const i = frozenFixture(), before = structuredClone(i); deriveSwarmViewModel(i);
    expect(i).toEqual(before); untouched(); expect(vi.getTimerCount()).toBe(0);
  });
  it("M1 raw op events do not supersede the supplied cached projection or infer members", () => {
    guard(); const vm = deriveSwarmViewModel(freeze(input({ events: [event(1, { act: "op", agent: "event-only", op: {
      kind: "task.add", title: "Uncommitted event task", type: "implementation", phase: "build", accept: "Not folded here",
    } })] })));
    expect(vm.agents.map(a => a.agent)).toEqual(["executor-a"]); expect(vm.agents[0]!.tasks.map(t => t.id)).toEqual(["T01"]); untouched();
  });
  it("A5 click, Enter, Space and Escape interactions never call transport, provider, storage or refolding", () => {
    guard(); const vm = freeze(deriveSwarmViewModel(input({ agents: { "executor-a": registration() } }))), before = structuredClone(vm);
    const root = renderSwarmView(document, vm); document.body.append(root);
    const container = card(root, "executor-a"); container.click();
    const control = taskControl(container); control.focus(); keyboardActivate(control, "Enter"); keyboardActivate(control, " ");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(vm).toEqual(before); untouched();
  });
  it("M1 disconnection and terminal lifecycle cannot release, complete or cancel supplied work", () => {
    guard(); const i = freeze(input({ connected: false, agents: { "executor-a": registration({ lifecycle: "failed" }) } })), before = structuredClone(i);
    const vm = deriveSwarmViewModel(i); expect(vm.agents[0]!.tasks).toEqual(i.projection!.tasks);
    expect(i).toEqual(before); untouched();
  });
});
