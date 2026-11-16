import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, WALL_REFRESH_MS, type AgentWall } from "../../../src/app/agent_wall";
import type { PostRequest, PostResult } from "../../../src/app/agent_link";
import type { WallHandlers } from "../../../src/views/types";
import { FakeAppClock } from "../u37c/harness";
import { deferred, draft, element, fixture, keyboardActivate, NOW, RAW, RECEIPT,
  settle, submit, typeDraft, watchAnnouncements } from "./helpers";

const observed = vi.hoisted(() => ({ handlers: undefined as WallHandlers | undefined }));
vi.mock("../../../src/views", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => {
    observed.handlers = args[2];
    return real.mountWall(...args);
  } };
});

let wall: AgentWall | undefined;
beforeEach(() => { observed.handlers = undefined; });
afterEach(async () => {
  wall?.destroy(); wall = undefined;
  await settle(); vi.restoreAllMocks(); document.body.replaceChildren();
});

async function start() {
  const f = fixture();
  f.openPlan(); f.task(); f.task("executor-b");
  f.legacy("executor-a"); f.legacy("executor-b");
  const wallHost = document.createElement("div");
  const chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock(); clock.t = NOW;
  const pending: Array<ReturnType<typeof deferred<PostResult>>> = [];
  const post = vi.fn((_request: PostRequest): Promise<PostResult> => {
    const result = deferred<PostResult>(); pending.push(result); return result.promise;
  });
  wall = startAgentWall({ wallHost, chatHost, store: f.store, clock, userAgent: "wall-user",
    link: { post }, reviewer: { review: async () => undefined } });
  await settle();
  const open = (id = "plan:demo:T01") => {
    expect(observed.handlers?.onOpenTask).toBeTypeOf("function");
    observed.handlers!.onOpenTask!(id);
  };
  open();
  const resolve = async (value: PostResult, index = 0) => {
    expect(pending[index]).toBeDefined(); pending[index]!.resolve(value); await settle();
  };
  return { chatHost, clock, post, open, resolve };
}

describe("U92 repair: draft ownership, stable messages and delivery announcements", () => {
  it("clears an unchanged submitted draft after switching away and restoring it", async () => {
    const h = await start();
    typeDraft(h.chatHost, RAW); submit(h.chatHost);
    h.open("plan:demo:T02"); typeDraft(h.chatHost, "other task draft");
    h.open(); expect(draft(h.chatHost)).toBe(RAW);
    await h.resolve(RECEIPT);
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain("e-receipt");
    expect(draft(h.chatHost)).toBe("");
    h.open("plan:demo:T02"); expect(draft(h.chatHost)).toBe("other task draft");
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("keeps the submission timestamp and focused Retry through a timed refresh", async () => {
    const h = await start();
    typeDraft(h.chatHost, RAW); submit(h.chatHost);
    const timestamp = element(h.chatHost, ".chat-at").textContent;
    h.clock.t += 1000;
    await h.resolve({ ok: false, code: "bad_request" });
    const retry = element<HTMLButtonElement>(h.chatHost, "button.chat-retry");
    retry.focus(); h.clock.advance(WALL_REFRESH_MS); await settle();
    expect(document.activeElement).toBe(retry);
    expect(element(h.chatHost, ".chat-at").textContent).toBe(timestamp);
    keyboardActivate(retry);
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(element(h.chatHost, ".chat-at").textContent).toBe(timestamp);
    await h.resolve(RECEIPT, 1);
    expect(element(h.chatHost, ".chat-at").textContent).toBe(timestamp);
  });

  it.each(["task switch", "drawer reopen"] as const)(
    "silently restores an off-screen settlement after %s but announces later visible transitions", async mode => {
      const h = await start();
      typeDraft(h.chatHost, RAW); submit(h.chatHost);
      const live = watchAnnouncements(h.chatHost);
      try {
        if (mode === "task switch") h.open("plan:demo:T02");
        else element<HTMLButtonElement>(h.chatHost, ".agent-chat-close").click();
        await settle(); live.take();
        await h.resolve({ ok: false, code: "bad_request" });
        const hiddenAnnouncements = live.take();
        h.open(); await settle();
        const restoredAnnouncements = live.take();
        expect(element(h.chatHost, ".chat-delivery").textContent).toContain("Failed (bad_request)");
        expect([...hiddenAnnouncements, ...restoredAnnouncements]).toEqual([]);
        keyboardActivate(element<HTMLButtonElement>(h.chatHost, "button.chat-retry"));
        await settle(); expect(live.take().join(" ")).toContain("Sending");
        await h.resolve(RECEIPT, 1);
        expect(live.take().join(" ")).toContain("Delivered");
        wall!.refresh(); await settle(); expect(live.take()).toEqual([]);
      } finally { live.disconnect(); }
    },
  );

  it.each(["plan:demo:T01", "agent:demo:executor-a"])(
    "allows an independent legacy target to send while %s is pending", async origin => {
      const h = await start(); h.open(origin);
      typeDraft(h.chatHost, RAW); submit(h.chatHost);
      h.open("agent:demo:executor-b"); typeDraft(h.chatHost, "independent draft");
      expect(element<HTMLButtonElement>(h.chatHost, ".chat-send").disabled).toBe(false);
      submit(h.chatHost, "ctrlKey");
      expect(h.post).toHaveBeenCalledTimes(2);
      expect(h.post).toHaveBeenNthCalledWith(2, { room: "demo", to: "executor-b", text: "independent draft" });
      submit(h.chatHost, "ctrlKey"); expect(h.post).toHaveBeenCalledTimes(2);
      await h.resolve(RECEIPT);
      expect(draft(h.chatHost)).toBe("independent draft");
      expect(element(h.chatHost, "[data-client-id]").dataset.delivery).toBe("sending");
      await h.resolve({ ok: true, id: "e-independent", lamport: 43 }, 1);
      expect(draft(h.chatHost)).toBe("");
    },
  );
});
