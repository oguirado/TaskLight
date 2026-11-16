import { describe, expect, it } from "vitest";
import { legacyState, options, projection, result, wallVM } from "./helpers";

describe("R2 archive lifecycle preservation", () => {
  it("keeps successive closures with the same plan id and suppresses only the represented current lifecycle", () => {
    const p = projection("plan_close");
    const first = p.archived_plans[0]!;
    const second = { ...first, title: "Reopened plan", opened_ts: first.closed_ts + 1, closed_ts: first.closed_ts + 1000, outcome: "Second closure" };
    const vm = wallVM([], new Map(), options, [result({
      ...p,
      plan: { ...p.plan!, title: second.title, opened_ts: second.opened_ts, closed_outcome: second.outcome },
      archived_plans: [first, second],
    })]);
    expect(vm.archive.map((a) => [a.title, a.outcome])).toEqual([
      [first.title, first.outcome], [second.title, second.outcome],
    ]);
  });

  it("includes the current closed lifecycle when only an earlier p1 closure is archived", () => {
    const p = projection("plan_close");
    const first = p.archived_plans[0]!;
    const vm = wallVM([], new Map(), options, [result({
      ...p,
      plan: { ...p.plan!, title: "Latest closure", opened_ts: first.closed_ts + 1, closed_outcome: "Latest outcome" },
    })]);
    expect(vm.archive).toHaveLength(2);
    expect(vm.archive[1]).toMatchObject({ title: "Latest closure", outcome: "Latest outcome", archived: "unavailable", took: "unavailable" });
  });

  it("preserves archive entries distinguished by closing time", () => {
    const p = projection("plan_close");
    const first = p.archived_plans[0]!;
    const vm = wallVM([], new Map(), options, [result({
      ...p, plan: null,
      archived_plans: [first, { ...first, closed_ts: first.closed_ts + 1000, outcome: "Another closure" }],
    })]);
    expect(vm.archive.map((a) => a.outcome)).toEqual([first.outcome, "Another closure"]);
  });
});

describe("R2 workspace plan band selection", () => {
  const legacy = { ...legacyState(), room: "first" };
  const plans = [result(projection(), "second")];

  it("omits the band for a selected legacy-only workspace alongside a v2 workspace", () => {
    const vm = wallVM([legacy], new Map(), { ...options, workspace: "first" }, plans);
    expect(vm.workspace).toBe("first");
    expect(vm).not.toHaveProperty("plan");
    expect(vm.tasks.some((t) => t.workspace === "first")).toBe(true);
  });

  it("aligns the initial workspace with the default v2 plan", () => {
    const vm = wallVM([legacy], new Map(), options, plans);
    expect(vm.workspace).toBe("second");
    expect(vm.plan?.title).toBe(plans[0]!.projection.plan!.title);
  });

  it("omits the band when an invalid selection resolves to the legacy workspace", () => {
    const vm = wallVM([legacy], new Map(), { ...options, workspace: "missing" }, plans);
    expect(vm.workspace).toBe("first");
    expect(vm).not.toHaveProperty("plan");
  });

  it("shows the plan when its workspace is selected", () => {
    const vm = wallVM([legacy], new Map(), { ...options, workspace: "second" }, plans);
    expect(vm.workspace).toBe("second");
    expect(vm.plan?.title).toBe(plans[0]!.projection.plan!.title);
  });
});
