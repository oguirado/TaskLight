import { describe, expect, it, vi } from "vitest";
import { foldPlan } from "../../../src/plan";
import type { PlanProjection } from "../../../src/plan";
import { toWallVM } from "../../../src/app/agent_store";
import { IDS, feed, hash, history, opening, event, opts, python, result, starterResolver, storeWith, template, wall } from "./helpers";

describe("U67 pinned template oracle", () => {
  it("A1 fixture is six valid MCP-shaped operations without an opening phase", () => {
    const events = history();
    expect(events).toHaveLength(6);
    expect(events[0]!.op).not.toHaveProperty("phase");
    const folded = foldPlan(events, template());
    expect(folded.stats).toMatchObject({ applied: 6, rejected: 0, invalid: 0 });
    expect(folded.projection.tasks.map(t => t.deps)).toEqual([[], ["T01"], ["T02"]]);
  });
  it("A1 starter resolver selects discovery and all ordered phase labels and exits", () => {
    const t = template(); const s = feed(storeWith(starterResolver()));
    expect(s.plan("oracle")?.projection.plan?.phase).toBe("discovery");
    expect(wall(s).plan?.phases).toEqual(t.phases.map(p => ({ ...p, active: p.id === "discovery" })));
  });
  it("M1 passes the pinned id and hash to the supplied resolver", () => {
    const t = template(); const resolve = vi.fn(() => t); const s = feed(storeWith(resolve));
    expect(s.plan("oracle")?.projection.plan?.phase).toBe("discovery");
    expect(resolve).toHaveBeenCalledWith(t.id, t.hash);
  });
  it("M3 uses resolved template order and literal labels and exits rather than capitalized ids", () => {
    const raw = template();
    const custom = { ...raw, phases: [...raw.phases].reverse().map(p => ({ ...p, label: `Stage: ${p.label}`, exit: `Exit: ${p.exit}` })) };
    const t = { ...custom, hash: hash(custom) };
    const s = feed(storeWith(() => t), history(t));
    expect(wall(s).plan?.phases).toEqual(t.phases.map(p => ({ ...p, active: p.id === t.phases[0]!.id })));
  });
  it("M1 resolves the latest opening in event order despite reversed arrival", () => {
    const first = template("blank"), latest = template();
    const resolve = vi.fn((id: string, pinned: string) => [first, latest].find(t => t.id === id && t.hash === pinned));
    const events = [event(1, opening(first)), event(2, { kind: "plan.close", base_rev: 1 }), event(3, opening(latest))];
    const s = feed(storeWith(resolve), [...events].reverse());
    expect(s.plan("oracle")?.projection.plan?.phase).toBe("discovery");
    expect(resolve).toHaveBeenCalledWith(latest.id, latest.hash);
    expect(wall(s).plan?.phases.map(p => p.id)).toEqual(latest.phases.map(p => p.id));
  });
  it("M1 resolves room pins independently", () => {
    const web = template(), blank = template("blank");
    const s = storeWith((id, pinned) => [web, blank].find(t => t.id === id && t.hash === pinned));
    s.ingest(event(1, opening(web), "web")); s.ingest(event(2, opening(blank), "blank"));
    expect(s.plan("web")?.projection.plan?.phase).toBe(web.phases[0]!.id);
    expect(s.plan("blank")?.projection.plan?.phase).toBe(blank.phases[0]!.id);
  });
  it("A2 no resolver retains the band and skips the empty opening phase", () => {
    const s = feed(storeWith());
    expect(s.plan("oracle")?.projection).toEqual(foldPlan(history()).projection);
    const vm = wall(s); expect(vm.plan).toBeDefined();
    expect(vm.plan!.phases.map(p => ({ id: p.id, label: p.label }))).toEqual([
      { id: "discovery", label: "Discovery" }, { id: "design", label: "Design" }, { id: "build", label: "Build" },
    ]);
    expect(vm.plan!.phases.every(p => !p.active)).toBe(true);
  });
  it("A3 wrong resolved hash falls back to untemplated folding and preserves the band", () => {
    const s = feed(storeWith(() => ({ ...template(), hash: "0".repeat(64) })));
    expect(s.plan("oracle")?.projection).toEqual(foldPlan(history()).projection);
    expect(wall(s).plan).toBeDefined();
    expect(wall(s).plan!.phases.some(p => p.id === "")).toBe(false);
  });
  it("M1 a resolved template without a hash cannot authorize templated folding", () => {
    const { hash: _missing, ...unhashed } = template();
    const s = feed(storeWith(() => unhashed));
    expect(s.plan("oracle")?.projection).toEqual(foldPlan(history()).projection);
    expect(wall(s).plan).toBeDefined();
  });
  it("M1 unresolved template falls back without dropping the band", () => {
    const s = feed(storeWith(() => undefined));
    expect(s.plan("oracle")?.projection).toEqual(foldPlan(history()).projection);
    expect(wall(s).plan).toBeDefined();
  });
  it("A4 throwing resolver cannot escape plan or wall and uses the untemplated projection", () => {
    const resolve = vi.fn(() => { throw new Error("Lookup unavailable"); });
    const s = feed(storeWith(resolve));
    expect(() => s.plan("oracle")).not.toThrow();
    expect(s.plan("oracle")?.projection).toEqual(foldPlan(history()).projection);
    expect(() => wall(s)).not.toThrow();
    expect(wall(s).plan).toBeDefined();
    expect(resolve).toHaveBeenCalled();
  });
  it.each((["", null, 17, {}, []] as unknown[]).map(value => [value] as const))("M3 hostile plan phase %j is skipped without dropping valid task phases", value => {
    const p = foldPlan(history()).projection;
    const hostile = { ...p, plan: { ...p.plan!, phase: value }, tasks: [...p.tasks, { ...p.tasks[0]!, id: "T04", phase: value }] } as unknown as PlanProjection;
    const vm = toWallVM([], new Map(), opts, [result(hostile)]);
    expect(vm.plan).toBeDefined();
    expect(vm.plan!.phases.map(p => p.id)).toEqual(["discovery", "design", "build"]);
  });
  it("M4 A1 full store projection equals Python fold with the same pinned template", () => {
    const t = template(); const events = history(t);
    const expected = python<PlanProjection>([
      "import json, sys", "from bridge.plan.fold import fold_plan",
      "x = json.load(sys.stdin)", "print(json.dumps(fold_plan(x['events'], templates={x['template']['id']: x['template']})))",
    ].join("\n"), { events, template: t });
    expect(expected.plan?.phase).toBe("discovery"); expect(expected.rejected).toEqual([]);
    const s = feed(storeWith(() => t), events);
    expect(s.plan("oracle")?.projection).toEqual(expected);
  });
  it("M5 empty store keeps the existing no-plan behavior", () => {
    const resolve = vi.fn(() => template()); const s = storeWith(resolve);
    expect(s.plan("missing")).toBeUndefined(); expect(s.plans()).toEqual([]);
    expect(wall(s).plan).toBeUndefined(); expect(resolve).not.toHaveBeenCalled();
  });
});

describe("U67 starter resolver contract", () => {
  it("A5 independent JSON hashes equal bridge.plan.template canonical hashes", () => {
    const all = IDS.map(id => template(id));
    const reference = python<string[]>([
      "import json, sys", "from bridge.plan.template import template_hash",
      "print(json.dumps([template_hash(t) for t in json.load(sys.stdin)]))",
    ].join("\n"), all);
    expect(all.map(t => t.hash)).toEqual(reference);
  });
  it.each(IDS)("M2 A5 %s returns the entire bundled JSON with its real canonical hash", id => {
    const t = template(id); const resolve = starterResolver();
    expect(resolve(id, t.hash!)).toEqual(t);
  });
  it.each(IDS)("A5 %s refuses an incorrect hash", id => {
    expect(starterResolver()(id, "0".repeat(64))).toBeUndefined();
  });
  it.each(["unknown-template", "__proto__", "constructor", ""])("A5 unknown or hostile id %j is unresolved", id => {
    expect(starterResolver()(id, template().hash!)).toBeUndefined();
  });
});
