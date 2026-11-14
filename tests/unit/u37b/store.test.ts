import { describe, expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { RoomEvent } from "../../../src/agents/types";
import { DOCS, DOCS_EVENTS, DUP_COUNT, LAUNCH, LAUNCH_EVENTS, STREAM_WITH_DUPES, UNIQUE, claudeAt, foldAll, idOf, pick, shuffled, stateOf, toJsonl } from "./fixture";

const fill = (events: readonly unknown[]) => { const s = createAgentStore(); for (const e of events) s.ingest(e); return s; };
const hb = (room: string, lamport: number): RoomEvent => ({ id: idOf(0x9000 + lamport), lamport, ts: 1_700_000_000_000 + lamport, room, agent: "claude", act: "heartbeat", text: "hb" });
const base = pick(LAUNCH_EVENTS, 0);

describe("ingest validation", () => {
  it("accepts every well-formed fixture event and returns true", () => {
    const s = createAgentStore();
    for (const e of UNIQUE) expect(s.ingest(e)).toBe(true);
  });

  const bad: [string, unknown][] = [
    ["null", null], ["array", [base]], ["string", "e-0000000000000100"], ["number", 7], ["empty object", {}],
    ["missing id", { ...base, id: undefined }],
    ["id without e- prefix", { ...base, id: "abc" }],
    ["id with uppercase hex", { ...base, id: "e-00000000000001AB" }],
    ["unknown act", { ...base, act: "shout" }],
    ["inherited act key", { ...base, act: "constructor" }],
    ["lamport 0", { ...base, lamport: 0 }],
    ["negative lamport", { ...base, lamport: -3 }],
    ["fractional lamport", { ...base, lamport: 1.5 }],
    ["string lamport", { ...base, lamport: "1" }],
    ["non-finite ts", { ...base, ts: Number.NaN }],
    ["room with uppercase", { ...base, room: "Launch" }],
    ["room starting with dash", { ...base, room: "-launch" }],
    ["room longer than 48", { ...base, room: "a".repeat(49) }],
    ["room __proto__", { ...base, room: "__proto__" }],
    ["agent not a slug", { ...base, agent: "Claude Code" }],
    ["non-string text", { ...base, text: 5 }],
    ["text over 4096 UTF-8 bytes", { ...base, text: "x".repeat(4097) }],
    ["text over 4096 bytes via multibyte", { ...base, text: "é".repeat(2049) }],
    ["plan act without plan", { ...base, act: "plan" }],
    ["plan with empty steps", { ...base, act: "plan", plan: { title: "t", steps: [] } }],
    ["step act without step", { ...base, act: "step" }],
    ["step with negative index", { ...base, act: "step", step: { index: -1, state: "done" } }],
    ["step with bad state", { ...base, act: "step", step: { index: 0, state: "finished" } }],
  ];
  it.each(bad)("rejects %s", (_n, ev) => {
    const s = createAgentStore();
    expect(s.ingest(ev)).toBe(false);
    expect(s.states()).toEqual([]);
    expect(s.since()).toEqual({});
  });

  it("accepts text of exactly 4096 UTF-8 bytes (multibyte) and 'e' * 4096", () => {
    const s = createAgentStore();
    expect(s.ingest({ ...base, id: idOf(0x7001), text: "é".repeat(2048) })).toBe(true);
    expect(s.ingest({ ...base, id: idOf(0x7002), lamport: 2, text: "e".repeat(4096) })).toBe(true);
  });

  it("a rejected event never changes the store", () => {
    const s = fill(LAUNCH_EVENTS);
    const before = { st: s.states(), ev: s.events(LAUNCH), since: s.since() };
    expect(s.ingest({ ...base, id: idOf(0x7003), lamport: 99, act: "shout" })).toBe(false);
    expect({ st: s.states(), ev: s.events(LAUNCH), since: s.since() }).toEqual(before);
  });
});

describe("dedup by id", () => {
  it("second delivery of the same id returns false", () => {
    const s = createAgentStore();
    expect(s.ingest(base)).toBe(true);
    expect(s.ingest({ ...base })).toBe(false);
    expect(s.events(LAUNCH)).toHaveLength(1);
  });

  it("first delivery wins when a duplicate id carries a different payload", () => {
    const s = createAgentStore();
    s.ingest(base);
    expect(s.ingest({ ...base, text: "tampered" })).toBe(false);
    expect(pick(s.events(LAUNCH), 0).text).toBe(base.text);
  });

  it("a duplicate plan does NOT bump the contract version (plan v1 re-sent after v2 stays v2)", () => {
    const s = fill(STREAM_WITH_DUPES);
    const claude = stateOf(s.states(), LAUNCH, "claude");
    expect(claude.contract?.version).toBe(2);
    expect(claude.contract?.title).toBe("Refactor auth module");
    expect(claude.contract?.lamport).toBe(12);
    expect(claude.previous?.version).toBe(1);
    expect(claude.contract?.hash).not.toBe(claude.previous?.hash);
    expect(stateOf(s.states(), LAUNCH, "codex").contract?.version).toBe(1);
  });

  it("stream with 5 redeliveries equals the unique stream: accepted count, events, states, since", () => {
    const dup = createAgentStore(); const uniq = createAgentStore();
    const accepted = STREAM_WITH_DUPES.filter((e) => dup.ingest(e)).length;
    for (const e of UNIQUE) uniq.ingest(e);
    expect(accepted).toBe(STREAM_WITH_DUPES.length - DUP_COUNT);
    expect(accepted).toBe(UNIQUE.length);
    expect(dup.states()).toEqual(uniq.states());
    expect(dup.events(LAUNCH)).toEqual(uniq.events(LAUNCH));
    expect(dup.events(DOCS)).toEqual(uniq.events(DOCS));
    expect(dup.since()).toEqual(uniq.since());
  });

  it("the active-step edit is the only diff between claude's contracts (no phantom revision)", () => {
    const s = fill(STREAM_WITH_DUPES);
    const c = stateOf(s.states(), LAUNCH, "claude");
    expect(c.previous?.steps.map((x) => x.text)).toEqual(["Read current auth code", "Write failing tests", "Implement token refresh", "Update docs"]);
    expect(c.contract?.steps.map((x) => x.text)).toEqual(["Read current auth code", "Write failing tests", "Implement token refresh with rotation", "Update docs"]);
  });
});

describe("events(room)", () => {
  it("returns that room's events ordered by lamport then id; unknown room is []", () => {
    const s = fill(shuffled(UNIQUE, 7));
    expect(s.events(LAUNCH).map((e) => e.lamport)).toEqual(LAUNCH_EVENTS.map((e) => e.lamport));
    expect(s.events(DOCS)).toEqual(DOCS_EVENTS);
    expect(s.events("nope")).toEqual([]);
    expect(s.events("__proto__")).toEqual([]);
  });
});

describe("maxPerRoom bound", () => {
  it("keeps the newest maxPerRoom events per room; other rooms unaffected", () => {
    const s = createAgentStore({ maxPerRoom: 5 });
    for (let i = 1; i <= 12; i++) expect(s.ingest(hb(LAUNCH, i))).toBe(true);
    for (const e of DOCS_EVENTS.slice(0, 3)) s.ingest(e);
    expect(s.events(LAUNCH).map((e) => e.lamport)).toEqual([8, 9, 10, 11, 12]);
    expect(s.events(DOCS)).toHaveLength(3);
    expect(s.since()).toEqual({ [LAUNCH]: 12, [DOCS]: 3 });
  });

  it("default bound is 5000 per room", () => {
    const s = createAgentStore();
    for (let i = 1; i <= 5001; i++) s.ingest(hb(LAUNCH, i));
    const ev = s.events(LAUNCH);
    expect(ev).toHaveLength(5000);
    expect(pick(ev, 0).lamport).toBe(2);
    expect(s.since()).toEqual({ [LAUNCH]: 5001 });
  });

  it("states() still folds after eviction (never throws, one state for the surviving agent)", () => {
    const s = createAgentStore({ maxPerRoom: 3 });
    for (let i = 1; i <= 10; i++) s.ingest(hb(LAUNCH, i));
    const st = s.states();
    expect(st).toHaveLength(1);
    expect(pick(st, 0).agent).toBe("claude");
  });
});

describe("since()", () => {
  it("is the max lamport per room, independent of arrival order", () => {
    expect(fill(UNIQUE).since()).toEqual({ [LAUNCH]: 14, [DOCS]: 7 });
    expect(fill(shuffled(UNIQUE, 3)).since()).toEqual({ [LAUNCH]: 14, [DOCS]: 7 });
  });
  it("is empty for an empty store and omits rooms with no accepted event", () => {
    expect(createAgentStore().since()).toEqual({});
    const s = createAgentStore();
    s.ingest({ ...base, lamport: 0 });
    s.ingest(pick(DOCS_EVENTS, 0));
    expect(s.since()).toEqual({ [DOCS]: 1 });
  });
  it("is unaffected by duplicates and returns a fresh object each call", () => {
    const s = fill(STREAM_WITH_DUPES);
    const a = s.since();
    a[LAUNCH] = 999;
    expect(s.since()[LAUNCH]).toBe(14);
  });
});

describe("states()", () => {
  it("equals the U34 fold of the unique events", () => {
    expect(fill(UNIQUE).states()).toEqual(foldAll(UNIQUE));
    expect(fill(UNIQUE).states()).toHaveLength(4);
  });
  it("is deterministic under arrival permutations (seeded) and duplicates", () => {
    const expected = foldAll(UNIQUE);
    for (const seed of [1, 2, 3, 42, 1337]) {
      expect(fill(shuffled(UNIQUE, seed)).states()).toEqual(expected);
      expect(fill(shuffled(STREAM_WITH_DUPES, seed)).states()).toEqual(expected);
    }
  });
  it("repeated calls are deep-equal and mutating a result does not leak into the store", () => {
    const s = fill(UNIQUE);
    const a = s.states();
    expect(s.states()).toEqual(a);
    pick(a, 0).stepStates.push("done");
    a.length = 0;
    expect(s.states()).toEqual(foldAll(UNIQUE));
  });
  it("covers both rooms and all four agents", () => {
    const st = fill(UNIQUE).states();
    expect(st.map((x) => `${x.room}/${x.agent}`).sort()).toEqual(["docs-site/gemini", "docs-site/writer", "launch/claude", "launch/codex"]);
    expect(stateOf(st, LAUNCH, "claude").stepStates).toEqual(claudeAt(14).stepStates);
  });
});

describe("ingestJsonl", () => {
  it("clean replay: counts accepted, no duplicates, no torn line", () => {
    const s = createAgentStore();
    expect(s.ingestJsonl(toJsonl(UNIQUE))).toEqual({ accepted: UNIQUE.length, duplicate: 0, malformed: 0, torn: false });
    expect(s.states()).toEqual(foldAll(UNIQUE));
  });

  it("replaying the same file drops everything as duplicate", () => {
    const s = createAgentStore();
    s.ingestJsonl(toJsonl(UNIQUE));
    expect(s.ingestJsonl(toJsonl(UNIQUE))).toEqual({ accepted: 0, duplicate: UNIQUE.length, malformed: 0, torn: false });
    expect(stateOf(s.states(), LAUNCH, "claude").contract?.version).toBe(2);
  });

  it("torn last line (no trailing newline, cut mid-JSON) is reported as torn, not malformed, and not ingested", () => {
    const full = toJsonl(LAUNCH_EVENTS);
    const torn = full.slice(0, full.length - 40);
    expect(torn.endsWith("\n")).toBe(false);
    const s = createAgentStore();
    expect(s.ingestJsonl(torn)).toEqual({ accepted: LAUNCH_EVENTS.length - 1, duplicate: 0, malformed: 0, torn: true });
    expect(s.events(LAUNCH)).toHaveLength(LAUNCH_EVENTS.length - 1);
    // the completed file arrives later: only the missing event is new
    expect(s.ingestJsonl(full)).toEqual({ accepted: 1, duplicate: LAUNCH_EVENTS.length - 1, malformed: 0, torn: false });
    expect(s.states()).toEqual(foldAll(LAUNCH_EVENTS));
  });

  it("a complete last line without trailing newline is accepted", () => {
    const text = toJsonl(LAUNCH_EVENTS).trimEnd();
    const s = createAgentStore();
    expect(s.ingestJsonl(text)).toEqual({ accepted: LAUNCH_EVENTS.length, duplicate: 0, malformed: 0, torn: false });
  });

  it("malformed lines (bad JSON, wrong shape, invalid event) are counted; blank lines are ignored; good lines still land", () => {
    const text = [
      JSON.stringify(pick(LAUNCH_EVENTS, 0)),
      "not json at all",
      "",
      "{}",
      "[1,2,3]",
      "   ",
      JSON.stringify({ ...pick(LAUNCH_EVENTS, 1), act: "shout" }),
      JSON.stringify(pick(LAUNCH_EVENTS, 1)),
      JSON.stringify(pick(LAUNCH_EVENTS, 1)),
      "\"just a string\"",
    ].join("\n") + "\n";
    const s = createAgentStore();
    expect(s.ingestJsonl(text)).toEqual({ accepted: 2, duplicate: 1, malformed: 5, torn: false });
    expect(s.events(LAUNCH)).toHaveLength(2);
  });

  it("tolerates CRLF line endings", () => {
    const s = createAgentStore();
    const r = s.ingestJsonl(toJsonl(LAUNCH_EVENTS).replace(/\n/g, "\r\n"));
    expect(r.accepted).toBe(LAUNCH_EVENTS.length);
    expect(r.malformed).toBe(0);
  });

  it("empty string and non-string input never throw and ingest nothing", () => {
    const s = createAgentStore();
    expect(s.ingestJsonl("")).toEqual({ accepted: 0, duplicate: 0, malformed: 0, torn: false });
    expect(() => s.ingestJsonl(undefined as unknown as string)).not.toThrow();
    expect(s.states()).toEqual([]);
  });

  it("never throws on hostile lines (__proto__, deep nesting, huge string)", () => {
    const s = createAgentStore();
    const text = ['{"__proto__":{"x":1},"id":"e-0000000000000100"}', "[".repeat(5000), `{"text":"${"y".repeat(200_000)}"}`].join("\n") + "\n";
    let r: ReturnType<typeof s.ingestJsonl> | undefined;
    expect(() => { r = s.ingestJsonl(text); }).not.toThrow();
    expect(r?.accepted).toBe(0);
    expect(r?.malformed).toBe(3);
  });
});
