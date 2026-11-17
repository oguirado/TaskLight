import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { applyOp, emptyProjection, foldPlan } from "../../../src/plan/reducer";
import { validateOpShapeCode } from "../../../src/plan/validate";
import type { PlanOpEvent, PlanProjection, PlanningTemplate } from "../../../src/plan/types";
import type { RoomEvent } from "../../../src/agents/types";

type Row = {
  agent: string; state: string; run_id: string | null; harness: string | null;
  parent: { agent: string; run_id: string | null } | null; children: string[];
  last_seen_lamport: number | null; last_seen_ts: number | null;
  current: { task_id: string; micro_id: string | null } | null;
  counts: { tasks_owned: number; micros_done: number; micros_total: number };
};
type Inventory = { agents: Row[]; totals: Record<string, number> };
type Case = {
  name: string; room: string; now: number; events: RoomEvent[];
  expected: Inventory; connected?: boolean; membership_only?: string[];
  state_only?: Record<string, Partial<Row>>;
};
const root = process.cwd();
const fixture = JSON.parse(readFileSync(join(root, "bridge/tests/room/c2/fixtures/inventories.json"), "utf8")) as {
  template: PlanningTemplate; cases: Case[];
};
const legacy = JSON.parse(readFileSync(join(root, "bridge/tests/room/c2/fixtures/legacy_fold.json"), "utf8")) as {
  template: PlanningTemplate; histories: { name: string; events: PlanOpEvent[]; expected_json: string }[];
};
const states = ["working", "waiting", "idle", "registered", "finished", "failed", "unknown"];
const fields = ["agent", "state", "run_id", "harness", "parent", "children", "last_seen_lamport", "last_seen_ts", "current", "counts"] as const;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function folded(c: Case): PlanProjection {
  const result = foldPlan(c.events as unknown as PlanOpEvent[], fixture.template);
  expect(result.projection.rejected, "M1 shared history must replay without rejection").toEqual([]);
  return result.projection;
}
function view(c: Case, projection = folded(c)) {
  return deriveSwarmViewModel({ room: c.room, projection, events: c.events,
    nowMs: c.now, connected: c.connected ?? true });
}
function canonical(vm: ReturnType<typeof deriveSwarmViewModel>): Inventory {
  for (const row of vm.agents) {
    for (const key of fields) expect(row, `M3 inventory field ${key} is absent`).toHaveProperty(key);
  }
  expect(vm, "M5 inventory totals are absent").toHaveProperty("totals");
  const raw = vm as unknown as Inventory;
  return { agents: raw.agents.map(row => Object.fromEntries(fields.map(key => [key, row[key]])) as Row), totals: raw.totals };
}
function assertContract(value: Inventory) {
  expect(Object.keys(value.totals).sort()).toEqual([...states, "total"].sort());
  expect(value.totals.total).toBe(value.agents.length);
  expect(states.reduce((n, state) => n + value.totals[state]!, 0)).toBe(value.totals.total);
  expect(new Set(value.agents.map(row => row.agent)).size).toBe(value.agents.length);
  for (const state of states) expect(value.totals[state]).toBe(value.agents.filter(row => row.state === state).length);
  for (const row of value.agents) {
    expect(states).toContain(row.state);
    expect(row.children).toEqual([...row.children].sort());
    expect(Object.keys(row.counts).sort()).toEqual(["micros_done", "micros_total", "tasks_owned"]);
    for (const value of Object.values(row.counts)) {
      expect(Number.isInteger(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(row.counts.micros_done).toBeLessThanOrEqual(row.counts.micros_total);
  }
}
function pythonInventory(c: Case): Inventory {
  const child = spawnSync("python3", ["-B", "-m", "bridge.tests.room.c2.inventory_probe"], {
    cwd: root, input: JSON.stringify({ case: c.name }), encoding: "utf8", timeout: 5000,
    maxBuffer: 128 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(child.error, "bounded Python inventory probe must start").toBeUndefined();
  expect(child.status, child.stderr.trim().split("\n").at(-1)).toBe(0);
  const result = JSON.parse(child.stdout) as { ok: boolean; reason?: string; inventory: Inventory };
  expect(result.ok, result.reason ?? "M8 Python agents_list is missing").toBe(true);
  return result.inventory;
}

describe("C2 M2-M6/M8 shared fixed-clock inventories", () => {
  for (const c of fixture.cases) it(`shared_${c.name}`, () => {
    const vm = view(copy(c));
    // A-C2a: check lifecycle/assignment membership before row shape, excluding authors alone.
    const names = c.membership_only ?? (c.state_only ? null : c.expected.agents.map(row => row.agent));
    if (names) expect(vm.agents.map(row => row.agent)).toEqual(c.membership_only ? names.slice().sort() : names);
    const actual = canonical(vm);
    assertContract(actual);
    if (c.membership_only) expect(actual.agents.map(row => row.agent).sort()).toEqual(c.membership_only.slice().sort());
    else if (c.state_only) {
      for (const [agent, expected] of Object.entries(c.state_only)) {
        expect(actual.agents.find(row => row.agent === agent)).toMatchObject(expected);
      }
    } else expect(actual).toEqual(c.expected);
  });
});

describe("C2 M8 actual Python/TypeScript differential inventory", () => {
  for (const c of fixture.cases) it(`parity_${c.name}`, () => {
    // Both sides are real implementations; neither side is an oracle replacement.
    const python = pythonInventory(c);
    const typescript = canonical(view(copy(c)));
    expect(typescript).toEqual(python);
  });
});

describe("C2 M1 lifecycle schema and parent replay", () => {
  const op = (extra: Record<string, unknown> = {}) => ({ kind: "agent.lifecycle", state: "deployed", run_id: "r1", op_id: "parent01", ...extra });
  const event = (n: number, agent: string, extra: Record<string, unknown> = {}): PlanOpEvent => ({
    id: `e-${String(n).padStart(16, "0")}`, room: "demo", agent, act: "op", text: "", lamport: n, ts: 100000 + n,
    op: op(extra) as unknown as PlanOpEvent["op"],
  });
  it("accepts_each_optional_parent_field_and_both_syntax_boundaries", () => {
    for (const fields of [{ parent_agent: "a" }, { parent_run_id: "R_1-x" },
      { parent_agent: "a".repeat(48), parent_run_id: "R".repeat(64) }]) {
      expect(validateOpShapeCode(op(fields)), "M1 valid optional parent metadata rejected").toBeNull();
    }
  });
  it("rejects_hostile_parent_agent_syntax", () => {
    for (const value of ["", "UPPER", "../escape", "bad\nagent", "a".repeat(49), null, 1, {}, []]) {
      expect(validateOpShapeCode(op({ parent_agent: value }))).not.toBeNull();
    }
  });
  it("rejects_hostile_parent_run_syntax", () => {
    for (const value of ["", "../escape", "bad run", "r\n", "r".repeat(65), null, 1, {}, []]) {
      expect(validateOpShapeCode(op({ parent_run_id: value }))).not.toBeNull();
    }
  });
  it("keeps_unresolved_parent_metadata_in_fold_and_replay", () => {
    const e = event(1, "child", { parent_agent: "unseen", parent_run_id: "parent-r1" });
    const result = applyOp(emptyProjection(), e, fixture.template);
    expect(result.ok, "M1 valid parent lifecycle rejected").toBe(true);
    if (!result.ok) return;
    const record = result.projection.agent_lifecycle?.child as Record<string, unknown>;
    const parent = (record.parent ?? {}) as Record<string, unknown>;
    expect(record.parent_agent ?? parent.agent).toBe("unseen");
    expect(record.parent_run_id ?? parent.run_id).toBe("parent-r1");
    const repeated = foldPlan([e, copy(e)], fixture.template).projection;
    expect(repeated).toEqual(result.projection);
  });
  it("rejects_self_parent_without_mutating_input_projection", () => {
    const initial = emptyProjection(); const before = copy(initial);
    expect(applyOp(initial, event(1, "child", { parent_agent: "child", parent_run_id: "r1" }), fixture.template).ok).toBe(false);
    expect(initial).toEqual(before);
  });
  it("rejects_transitive_parent_cycle_after_admitting_unresolved_edges", () => {
    let state = emptyProjection();
    for (const [n, agent, parent] of [[1, "first", "second"], [2, "second", "third"]] as const) {
      const result = applyOp(state, event(n, agent, { parent_agent: parent, parent_run_id: "r1" }), fixture.template);
      expect(result.ok, "M1 acyclic unresolved parent edge rejected").toBe(true);
      if (!result.ok) return;
      state = result.projection;
    }
    const before = copy(state);
    expect(applyOp(state, event(3, "third", { parent_agent: "first", parent_run_id: "r1" }), fixture.template).ok).toBe(false);
    expect(state).toEqual(before);
  });
});

describe("C2 M1 preserved legacy folds", () => {
  for (const h of legacy.histories) it(`legacy_${h.name}`, () => {
    expect(JSON.parse(JSON.stringify(foldPlan(h.events, legacy.template).projection))).toEqual(JSON.parse(h.expected_json));
  });
});

describe("C2 M2/M4/M6 browser-specific guards", () => {
  const named = (name: string) => copy(fixture.cases.find(c => c.name === name)!);
  // A-C2a: a missing plan does not turn message authors into agent registrations.
  it("excludes_message_only_authors_when_projection_is_absent", () => {
    const c = named("message_only_authors");
    expect(view(c, null as unknown as PlanProjection).agents.map(row => row.agent)).toEqual([]); // A-C2a
  });
  it("ignores_foreign_room_authors_and_message_recipients", () => {
    const c = named("message_only_authors");
    c.events.push({ ...copy(c.events[0]!), id: "e-ffffffffffffffff", room: "other", agent: "foreign", lamport: 4 });
    expect(view(c).agents.map(row => row.agent)).toEqual([]); // A-C2a: no author or recipient membership.
  });
  it("sync_disconnect_forces_unknown_before_working", () => {
    const c = named("working_current_and_counts"); c.connected = false;
    expect(canonical(view(c)).agents.find(row => row.agent === "worker")?.state).toBe("unknown");
  });
  it("terminal_status_survives_sync_disconnect", () => {
    const c = named("explicit_failed_survives_staleness"); c.connected = false;
    expect(canonical(view(c)).agents[0]!.state).toBe("failed");
  });
  it("reordered_and_duplicated_events_produce_identical_inventory", () => {
    const c = named("tree_first_seen_order"); const initial = canonical(view(c));
    c.events = [...c.events.reverse(), copy(c.events[0]!)];
    expect(canonical(view(c))).toEqual(initial);
  });
  it("does_not_mutate_events_or_projection", () => {
    const c = named("fresh_alive"); const projection = folded(c); const before = copy({ c, projection });
    view(c, projection);
    expect({ c, projection }).toEqual(before);
  });
});
