import { describe, expect, it } from "vitest";
import { foldRoomWithStats } from "../../../src/agents";
import type { AgentState, DriftVerdict } from "../../../src/agents/types";
import type { AgentChatVM } from "../../../src/agentsui/types";
import { toChatVM } from "../../../src/app/agent_store";
import { userTime, CHAT_EVENTS, DOCS, DOCS_EVENTS, LAUNCH, LAUNCH_EVENTS, NOW, USER, claudeAt, foldAll, idOf, pick, stateOf } from "./fixture";

const ALL = [...LAUNCH_EVENTS, ...CHAT_EVENTS, ...DOCS_EVENTS];
/** U38 V1: message times are user-formatted, never ISO. */
const iso = (ts: number): string => userTime(ts, NOW);
const base = { userAgent: USER, nowMs: NOW, sending: false } as const;
const verdict: DriftVerdict = { verdict: "drift", reason: "An in-progress step was edited.", source: "device" };

describe("toChatVM mapping", () => {
  const claude = claudeAt(14);
  const t = (name: string, fn: (vm: AgentChatVM) => void): void => { it(name, () => fn(toChatVM(claude, ALL, base))); };

  t("identity fields: room, agent, title (contract title)", (vm) => {
    expect(vm.room).toBe(LAUNCH);
    expect(vm.agent).toBe("claude");
    expect(vm.title).toBe("Refactor auth module");
  });

  t("messages: question/answer/verdict events that involve the agent, this room only, ordered by lamport", (vm) => {
    expect(vm.messages.map((m) => m.id)).toEqual([9, 10, 14, 15, 16, 17].map((l) => idOf(0x100 + l)));
  });

  t("from: user for userAgent, nano for verdict, agent otherwise", (vm) => {
    expect(vm.messages.map((m) => m.from)).toEqual(["agent", "agent", "agent", "user", "agent", "nano"]);
  });

  t("each message carries the author, text, formatted time (V1) and the re link only when present", (vm) => {
    const byId = new Map(vm.messages.map((m) => [m.id, m]));
    const q = byId.get(idOf(0x100 + 15));
    expect(q).toEqual({ id: idOf(0x100 + 15), from: "user", agent: USER, text: "Why rotate refresh tokens on every use?", at: iso(pick(CHAT_EVENTS, 0).ts) });
    expect(q && "re" in q).toBe(false);
    expect(byId.get(idOf(0x100 + 16))).toEqual({ id: idOf(0x100 + 16), from: "agent", agent: "claude", text: "Reuse detection needs rotation", at: iso(pick(CHAT_EVENTS, 1).ts), re: idOf(0x100 + 15) });
    expect(byId.get(idOf(0x100 + 17))).toMatchObject({ from: "nano", agent: "nano" });
  });

  t("act open/plan/step/heartbeat never become messages; another agent's private chatter is excluded", (vm) => {
    const ids = new Set(vm.messages.map((m) => m.id));
    for (const e of LAUNCH_EVENTS.filter((x) => ["open", "plan", "step", "heartbeat"].includes(x.act))) expect(ids.has(e.id)).toBe(false);
    const codex = toChatVM(stateOf(foldAll(LAUNCH_EVENTS), LAUNCH, "codex"), ALL, base);
    expect(codex.messages.map((m) => m.id)).toEqual([9, 10, 14].map((l) => idOf(0x100 + l)));
  });

  t("not silent, no silentFor, no drift, no suggestion, sending passthrough", (vm) => {
    expect(vm.silent).toBe(false);
    expect("silentFor" in vm).toBe(false);
    expect("drift" in vm).toBe(false);
    expect("suggestion" in vm).toBe(false);
    expect(vm.sending).toBe(false);
    expect(toChatVM(claude, ALL, { ...base, sending: true }).sending).toBe(true);
  });

  t("input order of events does not matter", (vm) => {
    expect(toChatVM(claude, [...ALL].reverse(), base)).toEqual(vm);
  });

  t("does not mutate its inputs", (vm) => {
    const events = structuredClone(ALL); const state = structuredClone(claude);
    toChatVM(state, events, { ...base, drift: verdict });
    expect(events).toEqual(ALL);
    expect(state).toEqual(claude);
  });
});

describe("toChatVM silent state", () => {
  it("silent agent: silent true and silentFor in minutes (gemini last seen minute 4, now minute 45)", () => {
    const gemini = stateOf(foldAll(DOCS_EVENTS), DOCS, "gemini");
    const vm = toChatVM(gemini, DOCS_EVENTS, base);
    expect(vm.silent).toBe(true);
    expect(vm.silentFor).toBe("41 min");
    expect(vm.title).toBe("Collect screenshots");
  });
  it("exactly at the 10 minute threshold is not silent; one ms over is (U34 A7)", () => {
    const claude = claudeAt(14);
    expect(toChatVM(claude, ALL, { ...base, nowMs: claude.lastSeen + 600_000 }).silent).toBe(false);
    expect(toChatVM(claude, ALL, { ...base, nowMs: claude.lastSeen + 600_001 }).silent).toBe(true);
  });
  it("hours render with an h unit", () => {
    const gemini = stateOf(foldAll(DOCS_EVENTS), DOCS, "gemini");
    const vm = toChatVM(gemini, DOCS_EVENTS, { ...base, nowMs: gemini.lastSeen + 3 * 3_600_000 });
    expect(vm.silent).toBe(true);
    expect(vm.silentFor).toMatch(/^3 h\b/);
  });
  it("a closed agent is never silent", () => {
    const closed: AgentState = { ...stateOf(foldAll(DOCS_EVENTS), DOCS, "gemini"), closed: true };
    expect(toChatVM(closed, DOCS_EVENTS, base).silent).toBe(false);
  });
});

describe("toChatVM drift banner data", () => {
  it("edit of an active step: verdict/reason/source verbatim, edited step shows as removed (old) and added (new)", () => {
    const vm = toChatVM(claudeAt(14), ALL, { ...base, drift: verdict });
    expect(vm.drift).toEqual({ ...verdict, added: ["Implement token refresh with rotation"], removed: ["Implement token refresh"] });
  });
  it("pure addition: added lists the new step, removed is empty", () => {
    const st = foldAll([...LAUNCH_EVENTS, { ...pick(LAUNCH_EVENTS, 11), id: idOf(0x1ff), lamport: 20, ts: pick(LAUNCH_EVENTS, 11).ts + 1, plan: { title: "Refactor auth module", steps: [...pick(LAUNCH_EVENTS, 11).plan!.steps, { text: "Publish changelog" }] } }]);
    const vm = toChatVM(stateOf(st, LAUNCH, "claude"), ALL, { ...base, drift: { verdict: "on_track", reason: "Only adds a step.", source: "rules" } });
    expect(vm.drift).toEqual({ verdict: "on_track", reason: "Only adds a step.", source: "rules", added: ["Publish changelog"], removed: [] });
  });
  it("without a previous contract the banner still carries the verdict with empty lists", () => {
    const vm = toChatVM(claudeAt(11), ALL, { ...base, drift: verdict });
    expect(vm.drift).toEqual({ ...verdict, added: [], removed: [] });
  });
  it("cloud and rules sources pass through", () => {
    for (const source of ["cloud", "rules"] as const) {
      expect(toChatVM(claudeAt(14), ALL, { ...base, drift: { verdict: "needs_user", reason: "r", source } }).drift?.source).toBe(source);
    }
  });
});

describe("toChatVM edge cases", () => {
  it("agent with no plan: title '<agent> (no plan yet)', no messages", () => {
    const st = stateOf(foldRoomWithStats([{ ...pick(LAUNCH_EVENTS, 0), agent: "scribe" }]).states, LAUNCH, "scribe");
    const vm = toChatVM(st, [], base);
    expect(vm.title).toBe("scribe (no plan yet)");
    expect(vm.messages).toEqual([]);
  });
  it("garbage items in events are ignored and never throw", () => {
    const junk = [null, undefined, 3, "x", {}, { act: "question" }, { ...pick(CHAT_EVENTS, 0), text: 5 }] as unknown as typeof ALL;
    const vm = toChatVM(claudeAt(14), [...junk, ...ALL], base);
    expect(vm.messages.map((m) => m.id)).toEqual([9, 10, 14, 15, 16, 17].map((l) => idOf(0x100 + l)));
  });
  it("hostile text is carried verbatim as data", () => {
    const evil = { ...pick(CHAT_EVENTS, 0), id: idOf(0x1fe), lamport: 30, text: "<img src=x onerror=alert(1)> __proto__ constructor" };
    const vm = toChatVM(claudeAt(14), [evil], base);
    expect(pick(vm.messages, 0).text).toBe(evil.text);
  });
});
