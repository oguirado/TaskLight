// Wall mount: renders the U36 wall and the U35 agent chat from the store
// plus drift verdicts (SPEC_U37 "U37c"). The reviewer is re-asked on every
// refresh; silence re-renders every 30 s. No logging, no storage.
import { mountAgentChat } from "../agentsui";
import type { AgentChatHandlers, AgentChatHandle, AgentChatVM } from "../agentsui/types";
import { mountWall } from "../views";
import type { WallHandle } from "../views/types";
import type { AgentState, DriftVerdict } from "../agents/types";
import { toChatVM, toWallVM } from "./agent_store";
import type { AgentLink } from "./agent_link";
import type { AgentStore } from "./agent_store";
import type { DriftReviewer } from "./agent_drift";
import type { Clock } from "./types";

export interface AgentWallDeps {
  wallHost: HTMLElement;
  chatHost: HTMLElement;
  link: Pick<AgentLink, "post">;
  store: AgentStore;
  reviewer: DriftReviewer;
  clock: Clock;
  userAgent: string;
  /** Escalation target agent; default "orchestrator". */
  orchestrator?: string | (() => string | undefined);
}
export interface AgentWall {
  /** Re-reads the store and re-renders (call after store.ingest). */
  refresh(): void;
  destroy(): void;
}
export const WALL_REFRESH_MS = 30_000 as const;

const ESCALATE_TEXT = "Escalation: the user asks the orchestrator to step in.";

export function startAgentWall(d: AgentWallDeps): AgentWall {
  const { wallHost, chatHost, link, store, reviewer, clock, userAgent } = d;
  let destroyed = false;
  let sending = false;
  let wallHandle: WallHandle | null = null;
  let chatHandle: AgentChatHandle | null = null;
  const verdicts = new Map<string, DriftVerdict>();
  const accepted = new Map<string, DriftVerdict>();
  const reviewState = new Map<string, { gen: number; hash: string | undefined }>();
  let reviewGen = 0;

  const verdictKey = (s: AgentState): string => `agent:${s.room}:${s.agent}`;
  // U42: the drawer is closed until the user opens a task (card click or its Chat button).
  // The chat follows the selected task; before any selection it follows the first agent.
  let selected: string | null = null;
  let drawerOpen = false;
  const targetOf = (states: AgentState[]): AgentState | undefined =>
    (selected !== null ? states.find((s) => s.agent !== userAgent && verdictKey(s) === selected) : undefined) ??
    states.find((s) => s.agent !== userAgent);
  const wallHandlers = {
    onOpenTask: (id: string): void => {
      if (destroyed) return;
      const found = store.states().find((s) => s.agent !== userAgent && verdictKey(s) === id);
      if (found === undefined) return;
      selected = id;
      drawerOpen = true;
      render();
    },
  };

  // U38 V6: the chat host is a drawer (bottom sheet / right-side panel).
  chatHost.classList.add("chat-drawer");
  chatHost.setAttribute("role", "dialog");
  chatHost.setAttribute("aria-label", "Agent chat");
  chatHost.setAttribute("data-open", "false");

  const render = (): void => {
    if (destroyed) return;
    const states = store.states();
    const nowMs = clock.now();
    const wallVm = toWallVM(states, verdicts, {
      nowMs,
      model: { state: "unavailable", label: "" },
      network: "online",
      userAgent,
    });
    if (wallHandle === null) {
      wallHandle = mountWall(wallHost, wallVm, wallHandlers);
    } else {
      wallHandle.update(wallVm);
    }
    const target = targetOf(states);
    if (target === undefined) {
      chatHost.setAttribute("data-open", "false");
      return;
    }
    const key = verdictKey(target);
    const verdict = verdicts.get(key);
    const drift = verdict !== undefined && accepted.get(key) !== verdict ? verdict : undefined;
    const opts: { userAgent: string; nowMs: number; sending: boolean; drift?: DriftVerdict } =
      drift !== undefined ? { userAgent, nowMs, sending, drift } : { userAgent, nowMs, sending };
    const vm: AgentChatVM = toChatVM(target, store.events(target.room), opts);
    chatHost.setAttribute("aria-label", vm.title);
    if (chatHandle === null) {
      chatHandle = mountAgentChat(chatHost, vm, chatHandlers);
    } else {
      chatHandle.update(vm);
    }
    // U42: open only after the user picked a task; Close returns it to closed.
    chatHost.setAttribute("data-open", drawerOpen ? "true" : "false");
  };

  const postQuestion = (room: string, to: string, text: string): void => {
    if (destroyed) return;
    sending = true;
    render();
    const done = (): void => {
      if (destroyed) return;
      sending = false;
      render();
    };
    let result: Promise<unknown>;
    try {
      result = link.post({ room, to, text });
    } catch {
      result = Promise.resolve(undefined);
    }
    Promise.resolve(result).then(done, done);
  };

  const resolveOrchestrator = (): string => {
    const o = d.orchestrator;
    if (typeof o === "function") return o() ?? "orchestrator";
    if (typeof o === "string" && o.length > 0) return o;
    return "orchestrator";
  };

  const chatHandlers: AgentChatHandlers = {
    onClose: () => {
      if (destroyed) return;
      drawerOpen = false;
      chatHost.setAttribute("data-open", "false");
    },
    onSend: (text) => {
      if (destroyed) return;
      const target = targetOf(store.states());
      if (target === undefined) return;
      postQuestion(target.room, target.agent, text);
    },
    onEscalate: () => {
      if (destroyed) return;
      const target = targetOf(store.states());
      if (target === undefined) return;
      postQuestion(target.room, resolveOrchestrator(), ESCALATE_TEXT);
    },
    onAcceptDrift: () => {
      if (destroyed) return;
      const target = targetOf(store.states());
      if (target !== undefined) {
        const key = verdictKey(target);
        const verdict = verdicts.get(key);
        if (verdict !== undefined) accepted.set(key, verdict);
      }
      render();
    },
  };

  const refresh = (): void => {
    if (destroyed) return;
    const states = store.states();
    const pending: Array<Promise<void>> = states.map((s) => {
      const key = verdictKey(s);
      reviewGen += 1;
      const gen = reviewGen;
      const hash = s.contract?.hash;
      reviewState.set(key, { gen, hash });
      let review: Promise<DriftVerdict | undefined>;
      try {
        review = reviewer.review(s);
      } catch {
        review = Promise.resolve(undefined);
      }
      return review.then((v) => {
        if (v === undefined) return;
        const current = reviewState.get(key);
        if (current === undefined || current.gen !== gen || current.hash !== hash) return;
        const fresh = store.states().find((x) => verdictKey(x) === key);
        if (fresh === undefined || fresh.contract?.hash !== hash) return;
        verdicts.set(key, v);
      });
    });
    void Promise.allSettled(pending).then(() => {
      render();
    });
    render();
  };

  const interval = clock.setInterval(refresh, WALL_REFRESH_MS);
  refresh();

  return {
    refresh,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clock.clearInterval(interval);
      if (wallHandle !== null) wallHandle.destroy();
      if (chatHandle !== null) chatHandle.destroy();
      wallHandle = null;
      chatHandle = null;
      chatHost.classList.remove("chat-drawer");
      chatHost.removeAttribute("data-open");
      chatHost.removeAttribute("role");
      chatHost.removeAttribute("aria-label");
    },
  };
}
