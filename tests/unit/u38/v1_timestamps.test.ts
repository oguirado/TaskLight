// U38 V1: user-visible timestamps are formatted from epoch ms (HH:MM today, "Yesterday HH:MM", "D Mon HH:MM"); never raw ISO.
import { afterEach, describe, expect, it } from "vitest";
import { toChatVM, toWallVM } from "../../../src/app/agent_store";
import { mountAgentChat } from "../../../src/agentsui";
import { mountWall } from "../../../src/views";
import { FORMATTED_RE, ISO_RE, ev, hhmm, local, mkState } from "./helpers";

const NOW = local(2026, 11, 13, 18, 0);
const TODAY = local(2026, 11, 13, 9, 42);
const YEST = local(2026, 11, 12, 17, 10);
const OLD = local(2026, 11, 3, 8, 5);
const OLD_PREV_MONTH_END = local(2026, 10, 31, 23, 59);
afterEach(() => { document.body.replaceChildren(); });

describe("V1 chat message times", () => {
  const state = mkState();
  const events = [
    ev(1, "demo", "wall-user", "question", "today", TODAY, { to: "worker-1" }),
    ev(2, "demo", "worker-1", "answer", "yesterday", YEST),
    ev(3, "demo", "worker-1", "answer", "older", OLD),
    ev(4, "demo", "worker-1", "answer", "month end", OLD_PREV_MONTH_END),
  ];
  const vm = () => toChatVM(state, events, { userAgent: "wall-user", nowMs: NOW, sending: false });
  it("ChatMessageVM.at: today -> HH:MM", () => { expect(vm().messages[0]?.at).toBe(hhmm(TODAY)); });
  it("yesterday -> 'Yesterday HH:MM'", () => { expect(vm().messages[1]?.at).toBe(`Yesterday ${hhmm(YEST)}`); });
  it("older -> 'D Mon HH:MM' (no leading zero on the day, English 3-letter month)", () => {
    expect(vm().messages[2]?.at).toBe(`3 Nov ${hhmm(OLD)}`);
    expect(vm().messages[3]?.at).toBe(`31 Oct ${hhmm(OLD_PREV_MONTH_END)}`);
  });
  it("the rendered chat shows only formatted times, never ISO / trailing Z", () => {
    const host = document.createElement("div"); document.body.append(host);
    mountAgentChat(host, vm(), {});
    const times = [...host.querySelectorAll(".chat-at")].map((t) => t.textContent ?? "");
    expect(times).toHaveLength(4);
    for (const t of times) { expect(t).toMatch(FORMATTED_RE); expect(t).not.toMatch(ISO_RE); }
  });
});

describe("V1 wall times", () => {
  const states = [mkState({ lastSeen: TODAY })];
  const vm = () => toWallVM(states, new Map(), { nowMs: NOW, model: { state: "unavailable", label: "x" }, network: "online" });
  it("WallVM.now and TaskVM.updated are formatted, not ISO", () => {
    const v = vm();
    expect(v.now).toMatch(FORMATTED_RE); expect(v.now).not.toMatch(ISO_RE);
    expect(v.tasks[0]?.updated).toMatch(FORMATTED_RE);
  });
  it("the mounted wall (header sub-title and provenance 'Updated ...') shows no ISO string anywhere", () => {
    const host = document.createElement("div"); document.body.append(host);
    mountWall(host, vm(), {});
    expect(host.textContent ?? "").not.toMatch(ISO_RE);
    expect(host.querySelector(".view-sub")?.textContent ?? "").toMatch(/^(Yesterday \d{2}:\d{2}|\d{2}:\d{2}|\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}) · /);
    expect(host.querySelector(".updated")?.textContent ?? "").toMatch(/^Updated (Yesterday \d{2}:\d{2}|\d{2}:\d{2}|\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2})$/);
  });
  it("a different day for 'now' is formatted accordingly (yesterday)", () => {
    const v = toWallVM(states, new Map(), { nowMs: YEST, model: { state: "unavailable", label: "x" }, network: "online" });
    expect(v.now).toMatch(FORMATTED_RE);
    expect(v.now).not.toMatch(ISO_RE);
  });
});
