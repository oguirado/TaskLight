// U42 items 4 and 6 (DOM): the chat drawer is closed by default and opens on a task click / its Chat button;
// the rail "running" counter counts agents whose task is in progress.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { mountWall } from "../../../src/views";
import type { WallVM } from "../../../src/views/types";
import { FakeAppClock, settle } from "../u37c/harness";
import { T0, close, ev, finished, plan, step } from "./fixtures";

let wall: AgentWall | undefined;
afterEach(() => { wall?.destroy(); wall = undefined; document.body.replaceChildren(); });

async function start(events: unknown[]) {
  const store = createAgentStore();
  for (const e of events) store.ingest(e);
  const wallHost = document.createElement("div"); const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock(); clock.t = T0 + 1000;
  const post = vi.fn(async (_req: { room: string; to: string; text: string }) => ({ ok: true as const, id: "e-00000000000000ff", lamport: 99 }));
  wall = startAgentWall({ wallHost, chatHost, link: { post }, store, reviewer: { review: async () => undefined }, clock, userAgent: "wall-user" });
  await settle(10);
  return { store, wallHost, chatHost, post };
}
const card = (host: HTMLElement, agent: string) => host.querySelector<HTMLElement>(`article.task[data-task-id="agent:viewpoint:${agent}"]`);

const TWO = [
  plan("github-agent", "GitHub · Search GitHub", ["a", "b"]), step("github-agent", 0, "active"),
  plan("gemini-agent", "Gemini · Ask Gemini", ["a"]), step("gemini-agent", 0, "active"),
];

describe("chat drawer (item 4)", () => {
  it("is closed by default even with agents on the wall", async () => {
    const { chatHost } = await start(TWO);
    expect(chatHost.classList.contains("chat-drawer")).toBe(true);
    expect(chatHost.getAttribute("data-open")).toBe("false");
  });
  it("stays closed across refreshes and new events until the user acts", async () => {
    const { chatHost, store } = await start(TWO);
    store.ingest(step("github-agent", 0, "done", "verified")); wall!.refresh(); await settle(10);
    expect(chatHost.getAttribute("data-open")).toBe("false");
  });
  it("every task card has a Chat button; clicking it opens the drawer on that task", async () => {
    const { wallHost, chatHost } = await start(TWO);
    const btns = [...wallHost.querySelectorAll<HTMLButtonElement>("button.task-chat")];
    expect(btns).toHaveLength(2);
    for (const b of btns) expect(b.getAttribute("type")).toBe("button");
    card(wallHost, "gemini-agent")!.querySelector<HTMLButtonElement>("button.task-chat")!.click();
    expect(chatHost.getAttribute("data-open")).toBe("true");
    expect(chatHost.querySelector(".agent-chat-title")?.textContent?.trim()).toBe("Gemini · Ask Gemini");
  });
  it("clicking a card body opens that task; sending goes to the selected agent", async () => {
    const { wallHost, chatHost, post } = await start(TWO);
    card(wallHost, "github-agent")!.querySelector<HTMLElement>(".task-title")!.click();
    expect(chatHost.getAttribute("data-open")).toBe("true");
    expect(chatHost.querySelector(".agent-chat-title")?.textContent?.trim()).toBe("GitHub · Search GitHub");
    card(wallHost, "gemini-agent")!.click();
    expect(chatHost.querySelector(".agent-chat-title")?.textContent?.trim()).toBe("Gemini · Ask Gemini");
    const ta = chatHost.querySelector<HTMLTextAreaElement>("textarea");
    expect(ta).not.toBeNull();
    ta!.value = "how is it going?"; ta!.dispatchEvent(new Event("input", { bubbles: true }));
    ta!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(10);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ room: "viewpoint", to: "gemini-agent", text: "how is it going?" });
  });
  it("Close returns it to closed, and a refresh does not reopen it", async () => {
    const { wallHost, chatHost } = await start(TWO);
    card(wallHost, "github-agent")!.click();
    expect(chatHost.getAttribute("data-open")).toBe("true");
    chatHost.querySelector<HTMLButtonElement>(".agent-chat-close")!.click();
    expect(chatHost.getAttribute("data-open")).toBe("false");
    wall!.refresh(); await settle(10);
    expect(chatHost.getAttribute("data-open")).toBe("false");
  });
  it("step rows inside a card still expand without opening the chat", async () => {
    const { wallHost, chatHost } = await start([...finished("wikipedia-agent", "Wikipedia · Search", 2, "PASS (rc 0)")]);
    const row = card(wallHost, "wikipedia-agent")!.querySelector<HTMLButtonElement>("button.step-row");
    expect(row).not.toBeNull();
    row!.click();
    expect(row!.getAttribute("aria-expanded")).toBe("true");
    expect(chatHost.getAttribute("data-open")).toBe("false");
  });
  it("mountWall without an onOpenTask handler renders no Chat buttons (U36 contract unchanged)", () => {
    const host = document.createElement("div"); document.body.append(host);
    const vm: WallVM = { now: "09:00", model: { state: "unavailable", label: "" }, network: "online", workspaces: [{ id: "w", name: "w", lens: "dev", accent: "sky" }],
      workspace: "w", view: "wall", archiveScope: "workspace", agenda: [], archive: [],
      tasks: [{ id: "t1", workspace: "w", project: "p", accent: "sky", title: "T", summary: "", status: "running", attention: "low", updated: "09:00", source: { kind: "rules", ms: 0 }, next: "x", steps: [] }] };
    const h = mountWall(host, vm, {});
    expect(host.querySelector("button.task-chat")).toBeNull();
    h.destroy();
  });
});

describe("rail running counter (item 6)", () => {
  const running = (host: HTMLElement) => host.querySelector(".rail-heading-meta")?.textContent?.trim();
  it("counts every agent whose task is in progress, including one whose steps are all done but not closed", async () => {
    const evs = [
      ...TWO,
      plan("wikipedia-agent", "Wikipedia · Search", ["a", "b"]), step("wikipedia-agent", 0, "done", "verified"), step("wikipedia-agent", 1, "done", "verified"),
      ...finished("arxiv-agent", "arXiv · Find", 2, "BROWSER_BOUNDED_ACTIONS_VERIFIED (rc 0)"),
    ];
    const { wallHost } = await start(evs);
    expect(running(wallHost)).toBe("3 running");
    expect(card(wallHost, "wikipedia-agent")!.getAttribute("data-status")).toBe("running");
    expect(card(wallHost, "arxiv-agent")!.getAttribute("data-status")).toBe("done");
  });
  it("closed and blocked tasks are not counted", async () => {
    const evs = [
      ...finished("github-agent", "GitHub · a", 1, "PASS (rc 0)"),
      plan("arxiv-agent", "arXiv · b", ["a"]), step("arxiv-agent", 0, "blocked", "no"), close("arxiv-agent", "BROWSER_STEP_BLOCKED (rc 1)"),
      ev("helper", "open", "hi"),
    ];
    const { wallHost } = await start(evs);
    expect(running(wallHost)).toBe("1 running"); // only `helper` (open, no plan yet)
  });
});
