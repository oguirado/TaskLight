import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import { activate, assertCommand, assertPhaseLabels, COMMAND, EXPECTED, fixture, makeStore, noNetwork,
  NOW, planEvents, template, text } from "./oracle";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); noNetwork(); });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("A6 M6 real controller interactions append no events and invoke no transport/provider ports", () => {
  const tpl = template();
  const store = makeStore([...planEvents(), ...fixture()], { templates: () => ({ ...tpl,
    memory_sections: tpl.memory_sections.map(section => ({ ...section, max_chars: 2000 })),
  }) });
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  // review is the controller's actual provider-facing port; no model is installed.
  const review = vi.fn(async () => undefined);
  const clock = { now: () => NOW, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 2), clearInterval: vi.fn() };
  const wall = startAgentWall({ wallHost, chatHost, link: { post }, store, reviewer: { review }, clock,
    userAgent: "wall-user", initialView: "memory" });
  try {
    const before = JSON.stringify(store.events("demo"));
    const calls = review.mock.calls.length;
    const summary = [...wallHost.querySelectorAll<HTMLElement>("details > summary")].find(n => text(n) === "History");
    // Soft missing-behavior checks let the side-effect assertions execute on the baseline.
    expect.soft(summary).toBeDefined(); if (summary) activate(summary, true);
    expect.soft(text(wallHost)).toContain(EXPECTED[1]!.text);
    expect.soft(text(wallHost)).toContain("Memory export command");
    const command = [...wallHost.querySelectorAll<HTMLElement>("*")].reverse().find(node =>
      node.textContent?.trim() === COMMAND || ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.value === COMMAND));
    command?.click();
    (command ?? wallHost).dispatchEvent(new Event("copy", { bubbles: true }));
    const wallTab = wallHost.querySelector<HTMLElement>('button[data-nav="wall"]');
    expect(wallTab).not.toBeNull(); wallTab!.click();
    const build = wallHost.querySelector<HTMLElement>('.phase-chip[data-phase-id="build"]');
    expect(build).not.toBeNull(); activate(build!, true);
    const showAll = wallHost.querySelector<HTMLElement>(".phase-show-all");
    expect(showAll).not.toBeNull(); activate(showAll!, true);
    expect(post).not.toHaveBeenCalled();
    expect(review.mock.calls.length).toBe(calls);
    expect(JSON.stringify(store.events("demo"))).toBe(before);
    expect(chatHost.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
    assertPhaseLabels(wallHost, "Discovery", "All phases");
    wallHost.querySelector<HTMLElement>('button[data-nav="memory"]')!.click();
    assertCommand(wallHost, COMMAND);
  } finally { wall.destroy(); }
});
