import { afterEach, describe, expect, it } from "vitest";
import type { SwarmAgentVM, SwarmViewModel } from "../../../src/app/swarm_vm";
import type { PlanTask } from "../../../src/plan/types";
import { agentGroups, agentState, renderAgentChip, renderAgentStrip } from "../../../src/views/agent_strip";

const NOW = 100_000;

function task(state: PlanTask["state"] = "active"): PlanTask {
  return {
    id: "T41", title: "Record evidence", type: "implementation", phase: "build", accept: "Recorded",
    deps: [], assignee: "executor-a", claim_lamport: 1, claim_ts: NOW - 2_000,
    estimate: null, explicit_state: null, blocked_reason: null, state, ready: true, rev: 1,
    microtasks: [{ id: "T41.M02", text: "Verify evidence", accept: "Recorded", state: "active",
      outcome: null, took: null, evidence: [], rev: 1 }],
  };
}

function agent(extra: Partial<SwarmAgentVM> = {}): SwarmAgentVM {
  return {
    agent: "executor-a", lifecycle: "alive", run_id: "run-a", swarm: "alpha", harness: "Fixture harness",
    tasks: [task()], current_task_id: "T41", active_micro_id: "T41.M02", micro_done: 0, micro_total: 1,
    activity: "working", last_beat_ts: NOW - 1_000, last_beat_age_ms: 1_000,
    waiting_on: [], unanswered_questions: 0, ...extra,
  };
}

function vm(agents: readonly SwarmAgentVM[], noPlan = false): SwarmViewModel {
  return {
    room: "demo", agents: Object.freeze([...agents]), refresh_at_ms: null,
    progress: noPlan ? null : {
      tasks_total: 1, tasks_done: 0, tasks_blocked: 0, tasks_ready: 1,
      micro_total: 1, micro_done: 0, progress: 0, progress_pct: 0,
    },
  };
}

function mount(agents: readonly SwarmAgentVM[], noPlan = false): HTMLElement {
  const root = renderAgentStrip(document, vm(agents, noPlan));
  document.body.append(root);
  return root;
}

const text = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();

// Accept native or explicit ARIA list items. The existing row hook lets preservation
// assertions run against the pre-U149 renderer instead of hiding behind a failed lookup.
function records(root: HTMLElement): HTMLElement[] {
  const selector = "li, [role='listitem'], .agent-strip-row";
  return [...root.querySelectorAll<HTMLElement>(selector)]
    .filter(row => row.querySelector(selector) === null);
}

function record(root: HTMLElement, identity: string): HTMLElement {
  const found = records(root).filter(row => text(row).includes(identity));
  expect(found, `Exactly one record for ${identity}`).toHaveLength(1);
  return found[0]!;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsIdentity(value: string, identity: string): boolean {
  return new RegExp(`(?:^|[^a-zA-Z0-9])${escape(identity)}(?:$|[^a-zA-Z0-9])`).test(value);
}

// No new data attribute spelling, id format, or accessible-name template is prescribed.
function hasIdentity(row: HTMLElement, identity: string): boolean {
  const labelledBy = (row.getAttribute("aria-labelledby") ?? "").split(/\s+/)
    .map(id => row.ownerDocument.getElementById(id)).filter((node): node is HTMLElement => node !== null)
    .map(node => text(node)).join(" ");
  return containsIdentity(row.id, identity)
    || containsIdentity(row.getAttribute("aria-label") ?? "", identity)
    || containsIdentity(labelledBy, identity)
    || [...row.attributes].some(attr => attr.name.startsWith("data-")
      && (attr.value === identity || containsIdentity(attr.value, identity)));
}

function byIdentity(root: HTMLElement, identity: string): HTMLElement {
  const found = records(root).filter(row => hasIdentity(row, identity));
  expect(found, `Stable machine-readable identity for ${identity}`).toHaveLength(1);
  return found[0]!;
}

function separated(node: HTMLElement, first: string, second: string): void {
  const content = text(node);
  const firstAt = content.indexOf(first), secondAt = content.indexOf(second);
  expect(firstAt, `Missing ${first}`).toBeGreaterThanOrEqual(0);
  expect(secondAt, `Missing ${second}`).toBeGreaterThanOrEqual(0);
  const [left, right] = firstAt < secondAt ? [first, second] : [second, first];
  const between = content.slice(content.indexOf(left) + left.length, content.indexOf(right));
  expect(between, `Text separator between ${left} and ${right}`).toMatch(/[\s:;,.|·—–/\-]/);
}

function twelveAgents(): readonly SwarmAgentVM[] {
  return Object.freeze(["alpha", "beta", "gamma"].flatMap(swarm =>
    Array.from({ length: 4 }, (_, index) => Object.freeze(agent({
      agent: `${swarm}-executor-${index + 1}`, swarm,
    })))));
}

const LABELS: ReadonlyArray<readonly [string, string]> = [
  ["Agent|Identity|Name", "executor-a"], ["Harness", "Fixture harness"],
  ["State|Status", "Working"], ["Current task|Task", "T41"],
  ["Active microtask|Microtask", "T41.M02"], ["Last beat|Beat|Liveness", "1s ago"],
];

const STATUS_CASES: ReadonlyArray<{
  name: string; expected: string; agent: SwarmAgentVM; noPlan: boolean;
}> = [
  { name: "deployed without a plan", expected: "Deployed · no plan yet", noPlan: true,
    agent: agent({ lifecycle: "deployed", activity: "idle", tasks: [], current_task_id: null,
      active_micro_id: null, micro_done: null, micro_total: null, last_beat_ts: null, last_beat_age_ms: null }) },
  { name: "finished with open work and a fresh beat", expected: "Finished · open work", noPlan: false,
    agent: agent({ lifecycle: "finished" }) },
  { name: "failed after tasks were released with a fresh beat", expected: "Failed · tasks released", noPlan: false,
    agent: agent({ lifecycle: "failed", tasks: [], current_task_id: null, active_micro_id: null,
      micro_done: null, micro_total: null }) },
  { name: "working without harness registration", expected: "Working · not registered by a harness", noPlan: false,
    agent: (() => {
      const { lifecycle: _lifecycle, run_id: _run, swarm: _swarm, harness: _harness, ...unregistered } = agent();
      return unregistered;
    })() },
];

// Malformed external data crosses the type boundary only here. No global prototype is changed.
function withActivity(value: string, extra: Partial<SwarmAgentVM> = {}): SwarmAgentVM {
  return agent({ ...extra, activity: value as SwarmAgentVM["activity"] });
}

function permutations<T>([a, b, c]: readonly [T, T, T]): readonly (readonly T[])[] {
  return [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
}

afterEach(() => document.body.replaceChildren());

describe("U149 agents strip and chip records", () => {
  it("A1 every displayed agent is a list item belonging to a semantic list", () => {
    const rows = records(mount([agent(), agent({ agent: "executor-b" })]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.matches("li, [role='listitem']"), "Agent row must be a list item").toBe(true);
      expect(row.parentElement?.closest("ul, ol, [role='list']"), "List item must belong to a list").not.toBeNull();
    }
  });

  it("A2 locates the same agent by stable identity after the hostile roster is reordered", () => {
    const input = twelveAgents(), identity = "alpha-executor-2";
    const before = byIdentity(mount(input), identity);
    expect(text(before)).toContain("T41.M02");
    document.body.replaceChildren();
    const reordered = [...input].reverse().map(value => value.agent === identity
      ? Object.freeze({ ...value, current_task_id: "T91", active_micro_id: "T91.M03", activity: "waiting" as const })
      : value);
    const after = byIdentity(mount(Object.freeze(reordered)), identity);
    expect(text(after)).toContain("T91.M03");
    expect(text(after)).toContain("Waiting");
    expect(text(after)).not.toContain("T41.M02");
    expect(input.map(value => value.agent)).toEqual(twelveAgents().map(value => value.agent));
  });

  it.each(LABELS)("A3 row explicitly labels %s and separates its value", (labels, value) => {
    const row = record(mount([agent()]), "executor-a");
    // Whitespace, punctuation, and native definition-list spacing are all accepted.
    expect(text(row)).toMatch(new RegExp(`\\b(?:${labels})(?:\\s*[:·|—–-]\\s*|\\s+)${escape(value)}(?:$|[^a-zA-Z0-9_.-])`, "i"));
  });

  it("A3 chip has text separators between identity, harness, and agent state", () => {
    const chip = renderAgentChip(document, agent());
    separated(chip, "executor-a", "Fixture harness");
    separated(chip, "Fixture harness", "Working");
  });

  for (const example of STATUS_CASES) {
    it(`A4 strip wording: ${example.name}`, () => {
      const row = record(mount([example.agent], example.noPlan), example.agent.agent);
      expect(text(row)).toContain(example.expected);
    });
    it(`A4 chip wording: ${example.name}`, () => {
      expect(text(renderAgentChip(document, example.agent))).toContain(example.expected);
    });
  }

  it("A5 global five-agent cap survives twelve agents across three reordered groups", () => {
    const agents = twelveAgents();
    expect(agents).toHaveLength(12);
    expect(new Set(agents.map(value => value.swarm)).size).toBe(3);
    for (const input of [agents, [...agents].reverse()]) {
      const root = mount(input), rows = records(root);
      expect(rows, "Cap is global, not five agents in each group").toHaveLength(5);
      const shown = agents.filter(value => rows.some(row => text(row).includes(value.agent)));
      expect(shown).toHaveLength(5);
      expect(new Set(shown.map(value => value.swarm)).size).toBeGreaterThan(1);
    }
  });

  it("A6 preserves exact swarm grouping, including absent versus literal Ungrouped", () => {
    const { swarm: _swarm, ...absent } = agent({ agent: "absent-group" });
    const root = mount([absent, agent({ agent: "literal-group", swarm: "Ungrouped" }),
      agent({ agent: "beta-agent", swarm: "beta" }), agent({ agent: "alpha-agent", swarm: "alpha" })]);
    const headings = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role='heading']")]
      .filter(heading => ["Ungrouped", "alpha", "beta"].includes(text(heading)));
    expect(headings.map(heading => text(heading))).toEqual(["Ungrouped", "alpha", "beta", "Ungrouped"]);
    const expected = ["literal-group", "alpha-agent", "beta-agent", "absent-group"];
    for (const [index, heading] of headings.entries()) {
      const group = heading.parentElement!;
      expect(text(group)).toContain(expected[index]!);
      for (const identity of expected.filter(value => value !== expected[index])) expect(text(group)).not.toContain(identity);
    }
  });

  it("A7 absent work and null beat stay explicit and never become an observed zero", () => {
    const row = record(mount([agent({ tasks: [], current_task_id: null, active_micro_id: null,
      micro_done: null, micro_total: null, last_beat_ts: null, last_beat_age_ms: null })]), "executor-a");
    for (const label of ["No current task", "No active microtask", "No beat observed"]) expect(text(row)).toContain(label);
    expect(text(row)).not.toMatch(/\b0s ago\b|\b(?:null|undefined|NaN)\b/);
  });

  it.each([[0, "0s ago"], [999, "0s ago"], [1_999, "1s ago"], [61_999, "61s ago"]] as const)(
    "A7 preserves observed beat age %i ms as %s", (age, expected) => {
      const row = record(mount([agent({ last_beat_ts: NOW - age, last_beat_age_ms: age })]), "executor-a");
      expect(text(row)).toContain(expected);
      expect(text(row)).not.toContain("No beat observed");
    },
  );

  it("A8 missing agent data keeps owner identity and Agent status unavailable", () => {
    const chip = renderAgentChip(document, undefined, "missing-owner");
    expect(text(chip)).toContain("missing-owner");
    expect(text(chip)).toContain("Agent status unavailable");
    expect(text(chip)).not.toMatch(/Working|Not registered by a harness|NaN|undefined/);
  });

  it.each([-1_001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "A9 carried debt never renders invalid beat age %s", age => {
      const row = record(mount([agent({ last_beat_age_ms: age })]), "executor-a");
      const value = text(row);
      expect(value).not.toMatch(/NaN|Infinity|[-−]\d+(?:\.\d+)?\s*s\s+ago|undefined/);
      // Non-finite data may be treated as absent, or clamped to a valid nonnegative age.
      expect(value).toMatch(/No beat observed|\b\d+(?:\.\d+)?\s*(?:s|m|h|d)(?:\s+ago)\b/);
    },
  );

  it.each(["__proto__", "constructor", "toString", "future_activity"])(
    "A10 own-property guard gives a textual fallback for activity %s", value => {
      const malformed = withActivity(value), label = agentState(malformed);
      expect(typeof label).toBe("string");
      expect(label.trim()).not.toBe("");
      for (const root of [mount([malformed]), renderAgentChip(document, malformed)]) {
        expect(text(root)).toContain(label);
        expect(text(root)).not.toMatch(/\[object Object\]|function\s|undefined|future_activity|__proto__|constructor|toString/);
      }
    },
  );

  it.each(["__proto__", "constructor", "toString", "future_activity"])(
    "A11 bucket fallback gives a permutation-invariant urgency order for activity %s", value => {
      const input: readonly [SwarmAgentVM, SwarmAgentVM, SwarmAgentVM] = [
        agent({ agent: "a-working" }), withActivity(value, { agent: "m-malformed" }),
        agent({ agent: "z-failed", lifecycle: "failed" }),
      ];
      const orders = permutations(input).map(permutation => {
        const snapshot = Object.freeze([...permutation]);
        const groups = agentGroups(snapshot);
        expect(groups).toHaveLength(1);
        const ids = groups[0]![1].map(item => item.agent);
        expect([...ids].sort()).toEqual(["a-working", "m-malformed", "z-failed"]);
        return ids.join("|");
      });
      expect(new Set(orders).size, "Malformed activity must not make sorting depend on input permutation").toBe(1);
    },
  );

  it("A12 Show all in Swarm remains a named operable navigation control", () => {
    const root = mount(twelveAgents());
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .filter(button => text(button) === "Show all in Swarm");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[0]!.tabIndex).toBeGreaterThanOrEqual(0);
    expect(buttons[0]!.dataset.nav).toBe("swarm");
  });
});
