// U38 V5: when the model state is unknown the rail reads "Gemini Nano: checking…", never an empty label.
import { afterEach, describe, expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { FakeAppClock, settle } from "../u37c/harness";
import { ev } from "./helpers";

let wall: AgentWall | undefined;
afterEach(() => { wall?.destroy(); wall = undefined; document.body.replaceChildren(); });

describe("V5 rail model status label", () => {
  for (const populated of [false, true]) {
    it(`${populated ? "with agent events" : "with an empty store"}: the model status line text is 'Gemini Nano: checking…'`, async () => {
      const store = createAgentStore();
      if (populated) store.ingest(ev(1, "demo", "worker-1", "open", "hi", Date.now()));
      const wallHost = document.createElement("div"); const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
      const clock = new FakeAppClock(); clock.t = Date.now();
      wall = startAgentWall({ wallHost, chatHost, link: { post: async () => ({ ok: true as const, id: "e-0000000000000001", lamport: 1 }) }, store, reviewer: { review: async () => undefined }, clock, userAgent: "wall-user" });
      await settle(10);
      const label = wallHost.querySelector(".rail-status .status-line[data-model] .status-text");
      expect(label).not.toBeNull();
      expect((label as Element).textContent?.trim()).toBe("Gemini Nano: checking…");
    });
  }
});
