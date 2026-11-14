import { describe, expect, it } from "vitest";
import { silentAgents, toTaskVM } from "../../../src/agents";
import type { AgentState, DriftVerdict } from "../../../src/agents/types";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import type { AccentVM, WallVM } from "../../../src/views/types";
import { userTime, DOCS, LAUNCH, NOW, UNIQUE, foldAll, pick, stateOf } from "./fixture";

const ACCENTS: readonly AccentVM[] = ["rose", "iris", "sky", "slate", "lagoon", "saffron"];
const model: WallVM["model"] = { state: "ready", label: "Gemini Nano ready" };
const opts = { nowMs: NOW, model, network: "online" } as const;
const drift: DriftVerdict = { verdict: "drift", reason: "An in-progress step was edited.", source: "device" };
const taskId = (s: AgentState): string => `agent:${s.room}:${s.agent}`;
const states = foldAll(UNIQUE);
const verdicts = new Map<string, DriftVerdict>([["agent:launch:claude", drift]]);

describe("toWallVM mapping", () => {
  const t0 = (name: string, fn: (vm: WallVM) => void): void => { it(name, () => fn(toWallVM(states, verdicts, opts))); };

  t0("one workspace per room (id and name are the room slug), valid lens and accent", (vm) => {
    expect(vm.workspaces.map((w) => w.id).sort()).toEqual([DOCS, LAUNCH]);
    for (const w of vm.workspaces) {
      expect(w.name).toBe(w.id);
      expect(["dev", "study"]).toContain(w.lens);
      expect(ACCENTS).toContain(w.accent);
    }
    expect(new Set(vm.workspaces.map((w) => w.id)).size).toBe(2);
  });

  t0("the active workspace is an existing one (first room alphabetically), view wall, scope workspace, no agenda/archive", (vm) => {
    expect(vm.workspace).toBe(DOCS);
    expect(vm.view).toBe("wall");
    expect(vm.archiveScope).toBe("workspace");
    expect(vm.agenda).toEqual([]);
    expect(vm.archive).toEqual([]);
  });

  t0("model and network are passed through untouched; now is the formatted time of nowMs (U38 V1)", (vm) => {
    expect(vm.model).toEqual(model);
    expect(vm.network).toBe("online");
    expect(vm.now).toBe(userTime(NOW, NOW));
    expect(vm.now).toMatch(/^\d{2}:\d{2}$/);
    expect(toWallVM(states, verdicts, { ...opts, network: "offline", model: { state: "downloading", label: "Downloading" } })).toMatchObject({ network: "offline", model: { state: "downloading", label: "Downloading" } });
  });

  t0("one task per agent state, each equal to U34 toTaskVM with the room workspace, its verdict and the workspace accent", (vm) => {
    expect(vm.tasks).toHaveLength(4);
    for (const s of states) {
      const ws = vm.workspaces.find((w) => w.id === s.room);
      const v = verdicts.get(taskId(s));
      const expected = toTaskVM(s, v === undefined ? { workspace: s.room, nowMs: NOW, accent: ws!.accent } : { workspace: s.room, nowMs: NOW, accent: ws!.accent, verdict: v });
      expect(vm.tasks.find((t) => t.id === taskId(s))).toEqual(expected);
    }
  });

  t0("every task belongs to a workspace of the VM; tasks ordered by room then agent", (vm) => {
    const ids = new Set(vm.workspaces.map((w) => w.id));
    for (const t of vm.tasks) expect(ids.has(t.workspace)).toBe(true);
    expect(vm.tasks.map((t) => t.id)).toEqual(["agent:docs-site:gemini", "agent:docs-site:writer", "agent:launch:claude", "agent:launch:codex"]);
  });

  t0("attention and status reflect verdicts, silence and open questions", (vm) => {
    const t = (id: string) => vm.tasks.find((x) => x.id === id)!;
    expect(t("agent:launch:claude").attention).toBe("high"); // drift verdict
    expect(t("agent:launch:claude").title).toBe("Refactor auth module");
    expect(t("agent:launch:codex").status).toBe("waiting"); // open question L14
    expect(t("agent:docs-site:gemini").status).toBe("idle"); // silent since minute 4
    expect(t("agent:docs-site:gemini").attention).toBe("high");
    expect(t("agent:docs-site:writer").status).toBe("running");
    const needsUser = toWallVM(states, new Map([["agent:launch:claude", { ...drift, verdict: "needs_user" as const }]]), opts);
    expect(needsUser.tasks.find((x) => x.id === "agent:launch:claude")!.attention).toBe("now");
  });

  t0("silent agents (U34 silentAgents) are exactly the idle tasks", (vm) => {
    expect(silentAgents(states, NOW)).toEqual(["gemini"]);
    expect(vm.tasks.filter((t) => t.status === "idle").map((t) => t.project)).toEqual(["gemini"]);
  });

  t0("verdicts for unknown ids are ignored; a missing verdict changes nothing else", (vm) => {
    const none = toWallVM(states, new Map(), opts);
    const stray = toWallVM(states, new Map([["agent:nowhere:ghost", drift]]), opts);
    expect(stray).toEqual(none);
    expect(none.tasks.find((x) => x.id === "agent:launch:claude")!.attention).toBe("low");
  });

  t0("is a pure function of its inputs and does not mutate them", (vm) => {
    const copy = structuredClone(states);
    expect(toWallVM(states, verdicts, opts)).toEqual(vm);
    expect(states).toEqual(copy);
  });

  t0("works from the store: store.states() gives the same VM", (vm) => {
    const s = createAgentStore();
    for (const e of UNIQUE) s.ingest(e);
    expect(toWallVM(s.states(), verdicts, opts)).toEqual(vm);
  });
});

describe("toWallVM degenerate inputs", () => {
  it("no states: no workspaces, no tasks, empty active workspace id", () => {
    const vm = toWallVM([], new Map(), opts);
    expect(vm.workspaces).toEqual([]);
    expect(vm.tasks).toEqual([]);
    expect(vm.workspace).toBe("");
  });
  it("a single room yields a single workspace", () => {
    const only = states.filter((s) => s.room === LAUNCH);
    const vm = toWallVM(only, verdicts, opts);
    expect(vm.workspaces.map((w) => w.id)).toEqual([LAUNCH]);
    expect(vm.workspace).toBe(LAUNCH);
    expect(vm.tasks).toHaveLength(2);
  });
  it("hostile agent/room-like text is data (ids are built by string concatenation only)", () => {
    const evil: AgentState = { ...stateOf(states, LAUNCH, "codex"), agent: "__proto__", lastText: "<script>alert(1)</script>" };
    const vm = toWallVM([evil], new Map(), opts);
    expect(pick(vm.tasks, 0).id).toBe("agent:launch:__proto__");
    expect(pick(vm.tasks, 0).summary).toBe("<script>alert(1)</script>");
  });
});
