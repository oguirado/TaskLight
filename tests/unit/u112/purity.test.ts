import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => {
  const deny = (name: string) => vi.fn(function () { throw new Error(`Forbidden side effect: ${name}`); });
  return { transport: deny("transport"), provider: deny("provider"), storage: deny("storage"),
    refold: deny("history replay"), store: deny("store creation") };
});
vi.mock("../../../src/plan/reducer", async original => ({
  ...await original<Record<string, unknown>>(), foldPlan: boundary.refold, applyOp: boundary.refold,
}));
vi.mock("../../../src/agents", async original => ({
  ...await original<Record<string, unknown>>(), foldRoomWithStats: boundary.refold,
}));
vi.mock("../../../src/app/agent_store", () => ({ createAgentStore: boundary.store }));
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: boundary.transport }));
vi.mock("../../../src/app/model_port", () => ({ createPageModelTransport: boundary.transport, attachModelChannel: boundary.transport }));
vi.mock("../../../src/app/model_services", () => ({ createModelServices: boundary.provider }));
vi.mock("../../../src/ai/hybrid", () => ({ createHybrid: boundary.provider }));

import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { deterministic, event, fixedInput, freeze, input, viewModel } from "./fixtures";

deterministic();
function guard(): void {
  for (const spy of Object.values(boundary)) spy.mockClear();
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Worker"])
    vi.stubGlobal(name, boundary.transport);
  vi.stubGlobal("indexedDB", { open: boundary.storage, deleteDatabase: boundary.storage });
  vi.stubGlobal("chrome", { runtime: { connect: boundary.transport, sendMessage: boundary.transport },
    storage: { local: { get: boundary.storage, set: boundary.storage }, session: { get: boundary.storage, set: boundary.storage } } });
  for (const method of ["getItem", "setItem", "removeItem", "clear"] as const)
    vi.spyOn(Storage.prototype, method).mockImplementation(boundary.storage);
  vi.spyOn(window, "postMessage").mockImplementation(boundary.transport);
  vi.spyOn(window, "open").mockImplementation(boundary.transport);
}
function untouched(): void {
  for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}
describe("A6 / M1 pure read-only boundary", () => {
  it("M1 derives frozen inputs without transport, storage, providers, history folding or timers", () => {
    guard(); const i = freeze({ ...fixedInput(), events: [event(1)] });
    const before = structuredClone(i); const vm = deriveSwarmViewModel(i);
    expect(vm.agents).toHaveLength(3); expect(i).toEqual(before); untouched();
  });
  it("A6 render and click/Enter interactions never use transport, storage, providers or timers", () => {
    guard(); const vm = freeze(viewModel()), before = structuredClone(vm);
    // A-U146: native focus schedules jsdom selection/rendering tasks, not application timers.
    // Isolate the browser primitive here; the frozen U146 oracle tests real focus entry and Escape.
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});
    const root = renderSwarmView(document, vm); document.body.append(root);
    for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
    expect(focus).toHaveBeenCalled();
    expect(vm).toEqual(before); untouched();
  });
  it("M1 disconnection neither cancels projected tasks nor writes server state", () => {
    guard(); const i = freeze(input({ connected: false })), before = structuredClone(i);
    const vm = deriveSwarmViewModel(i);
    expect(vm.agents[0]?.activity).toBe("unknown"); expect(vm.agents[0]?.tasks[0]?.state).toBe("active");
    expect(i).toEqual(before); untouched();
  });
});
