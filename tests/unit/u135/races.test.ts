import { describe, expect, it } from "vitest";
import type { NarratorInput, NarratorSnapshot } from "./fixtures";
import { boot, deferred, response, CLOUD, CATEGORY_ITEMS, allCategories, item, input, vm, agent,
  run, flush, rules, promptData, strings, task, micro, dispose } from "./fixtures";
import type { SdkResult } from "./fixtures";

describe("A5 identity and ignored-abort races", () => {
  const changes: Array<[string, (base: NarratorInput) => NarratorInput]> = [
    ["room", base => input({ ...base, vm: vm(undefined, "other-room"), policyRoom: "other-room" })],
    ["binding generation", base => input({ ...base, binding: { providerId: "firebase-hybrid", generation: 2 } })],
    ["binding provider", base => input({ ...base, binding: { providerId: "firebase-ondevice", generation: 2 } })],
    ["privacy", base => input({ ...base, tier: "private" })],
    ["cloud gate", base => input({ ...base, cloudAllowed: false })],
    ["lifecycle", base => input({ ...base, vm: vm([agent("executor-a", "T01", { lifecycle: "failed" })]) })],
    ["current task", base => input({ ...base, vm: vm([agent("executor-a", "T02")]) })],
    ["current microtask", base => input({ ...base, vm: vm([agent("executor-a", "T01", {
      active_micro_id: "T01.M02", micro_done: 1, micro_total: 2,
      tasks: [task("T01", "executor-a", { microtasks: [micro("T01.M01", { state: "done" }), micro("T01.M02")] })],
    })]) })],
    ["blocker", base => input({ ...base, vm: allCategories() })],
    ["needs-you count", base => input({ ...base, vm: vm([agent("executor-a", "T01", { unanswered_questions: 1 })]) })],
  ];
  it.each(changes)("A5 %s supersedes the request and ignores its late cloud completion", async (_label, change) => {
    const old = deferred<SdkResult>();
    const r = boot((_prompt, n) => n === 0 ? old.promise : response({ items: [] }));
    const seen: NarratorSnapshot[] = [];
    r.controller.subscribe(() => seen.push({ ...r.controller.snapshot() }));
    const base = input(); r.controller.update(base); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(1);
    r.controller.update(change(base));
    await flush(r);
    const startedFresh = r.generate.mock.calls.length === 2;
    const current = { ...r.controller.snapshot() }; const publications = seen.length;
    old.resolve(response({ items: [item()] }, CLOUD)); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(2);
    if (startedFresh) {
      expect(r.controller.snapshot()).toEqual(current);
      expect(seen).toHaveLength(publications);
    }
    expect(r.controller.snapshot().source).toBe("ON_DEVICE");
    expect(seen.some(s => s.kind === "generated" && s.source === "IN_CLOUD")).toBe(false);
  });

  const stops: Array<[string, Partial<NarratorInput>]> = [
    ["null policy room", { policyRoom: null }], ["null tier", { tier: null }],
    ["null head", { head: null }], ["null cloud gate", { cloudAllowed: null }],
    ["room mismatch", { policyRoom: "other-room" }],
    ["rules binding", { binding: { providerId: null, generation: 2 } }],
    ["unsupported binding", { binding: { providerId: "remote-test", generation: 2 } }],
  ];
  it.each(stops)("M1/M6 %s invalidates a previously admitted in-flight result", async (_name, patch) => {
    const pending = deferred<SdkResult>(); const r = boot(() => pending.promise);
    r.controller.update(input()); await flush(r);
    r.controller.update(input(patch));
    const current = { ...r.controller.snapshot() }; rules(current);
    pending.resolve(response({ items: [item()] }, CLOUD)); await flush(r);
    expect(r.controller.snapshot()).toEqual(current);
    expect(r.generate).toHaveBeenCalledTimes(1);
  });

  it("M6 a changed waiting_on relationship alone refreshes inference", async () => {
    const r = boot(() => response({ items: [] })); const base = allCategories();
    await run(r, input({ vm: base }));
    const agents = base.agents.map(a => a.agent !== "executor-b" ? a : {
      ...a, waiting_on: [{ task_id: "T02", upstream_id: "T03", owner: "executor-c", missing: false }],
      tasks: a.tasks.map(t => ({ ...t, deps: ["T03"] })),
    });
    r.controller.update(input({ vm: vm(agents) })); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(2);
  });

  it("C.M1 replaces prior-room text synchronously while the next room is generating", async () => {
    const pending = deferred<SdkResult>();
    const r = boot((_prompt, n) => n === 0 ? response() : pending.promise);
    await run(r);
    r.controller.update(input({ vm: vm([agent("room-b-agent", "T02")], "room-b"), policyRoom: "room-b" }));
    const synchronous = r.controller.snapshot();
    expect(synchronous.text).toContain("room-b-agent"); expect(synchronous.text).not.toContain("executor-a");
    expect(synchronous.source).toBeNull();
    await flush(r);
    expect(r.controller.snapshot().kind).toBe("generating");
    expect(r.controller.snapshot().source).toBeNull();
    pending.resolve(response({ items: [item({ agent: "room-b-agent", task: "T02" })] })); await flush(r);
    expect(r.controller.snapshot().kind).toBe("generated");
  });

  it("C.M1 invalid room policy synchronously clears previous generated text", async () => {
    const r = boot(); await run(r);
    r.controller.update(input({ vm: vm([agent("private-agent", "T02")], "demo"), policyRoom: "work", tier: "private" }));
    const snapshot = r.controller.snapshot(); rules(snapshot, "BLOCKED");
    expect(snapshot.text).not.toContain("executor-a"); expect(snapshot.text).toContain("private-agent");
    await flush(r); expect(r.generate).toHaveBeenCalledTimes(1);
  });

  it.each([[20, true], [21, false]] as const)("A5 head delta %i accepts=%s with no head-only retry", async (delta, accepted) => {
    const pending = deferred<SdkResult>(); const r = boot(() => pending.promise);
    r.controller.update(input()); await flush(r);
    r.controller.update(input({ head: 100 + delta })); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await flush(r);
    if (accepted) expect(r.controller.snapshot()).toMatchObject({ kind: "generated", source: "ON_DEVICE" });
    else rules(r.controller.snapshot());
    expect(r.generate).toHaveBeenCalledTimes(1);
  });

  it("C.M6 a semantic change beyond the head bound refreshes and rejects the old result", async () => {
    const pending = deferred<SdkResult>();
    const r = boot((_p, n) => n === 0 ? pending.promise : response({ items: [CATEGORY_ITEMS[2]] }));
    r.controller.update(input()); await flush(r);
    r.controller.update(input({ head: 121, vm: vm([allCategories().agents[2]!]) })); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(2);
    const current = { ...r.controller.snapshot() };
    pending.resolve(response()); await flush(r);
    expect(r.controller.snapshot()).toEqual(current);
  });

  it("A5 disposal suppresses all late publication", async () => {
    const pending = deferred<SdkResult>(); const r = boot(() => pending.promise);
    let publications = 0;
    r.controller.subscribe(() => { publications++; });
    r.controller.update(input()); await flush(r);
    dispose(r); const count = publications;
    pending.resolve(response()); await flush(r);
    expect(publications).toBe(count);
  });

  it("A5 a superseded rejection remains observed", async () => {
    const pending = deferred<SdkResult>();
    const r = boot((_p, n) => n === 0 ? pending.promise : response());
    r.controller.update(input()); await flush(r);
    r.controller.update(input({ binding: { providerId: "firebase-hybrid", generation: 2 } })); await flush(r);
    pending.reject(new Error("Late SDK rejection after cancellation")); await flush(r);
    expect(r.controller.snapshot()).toMatchObject({ kind: "generated", source: "ON_DEVICE" });
  });

  it("M6 superseding updates coalesce into the latest semantic context", async () => {
    const pending = deferred<SdkResult>();
    const r = boot((_p, n) => n === 0 ? pending.promise : response({ items: [] }));
    r.controller.update(input()); await flush(r);
    for (let n = 1; n <= 20; n++)
      r.controller.update(input({ vm: vm([agent(`latest-${n}`, `T${n}`)]) }));
    await flush(r);
    expect(r.generate.mock.calls.length).toBeLessThanOrEqual(2);
    expect(r.generate.mock.calls.length).toBeGreaterThanOrEqual(1);
    pending.resolve(response()); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(2);
    const last = promptData(r.prompts.at(-1)!);
    expect(strings(last)).toContain("latest-20");
    expect(strings(last)).not.toContain("latest-1");
  });

  it("B.M6 repeated Refresh during the current inference is deduplicated", async () => {
    const pending = deferred<SdkResult>(); const r = boot(() => pending.promise);
    r.controller.update(input()); await flush(r);
    for (let n = 0; n < 20; n++) void r.controller.refresh();
    await flush(r); expect(r.generate).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await flush(r); expect(r.generate).toHaveBeenCalledTimes(1);
  });

  it("M6 explicit Refresh after completion makes one new SDK call", async () => {
    const r = boot(); await run(r); void r.controller.refresh(); await flush(r);
    expect(r.generate).toHaveBeenCalledTimes(2);
  });
});

describe("A6 semantic refresh without event refolding", () => {
  it("A6 immutable same-class beat bursts cause no extra inference; expiry to unknown does", async () => {
    const r = boot((_p, n) => response({ items: [item({ kind: n === 0 ? "working" : "liveness_unknown" })] }));
    await run(r);
    for (let n = 1; n <= 30; n++) r.controller.update(input({ head: 100 + n,
      vm: vm([agent("executor-a", "T01", { last_beat_ts: 99_000 + n, last_beat_age_ms: 1000 - n })]) }));
    await flush(r); expect(r.generate).toHaveBeenCalledTimes(1);
    r.controller.update(input({ head: 131, vm: vm([agent("executor-a", "T01", { activity: "unknown",
      last_beat_age_ms: 90_001, last_beat_ts: 9999 })]) }));
    await flush(r); expect(r.generate).toHaveBeenCalledTimes(2);
    expect(r.controller.snapshot().text).toMatch(/Liveness unknown/i);
  });

  it("A6 failed lifecycle outranks fresh beats in rules and rejects fabricated working", async () => {
    const r = boot(); const a = agent("executor-a", "T01", { lifecycle: "failed", activity: "working" });
    const snapshot = await run(r, input({ vm: vm([a]) }));
    rules(snapshot, "SCHEMA_REJECT"); expect(snapshot.text).toMatch(/failed/i);
    for (let n = 1; n <= 20; n++) r.controller.update(input({ vm: vm([{ ...a, last_beat_ts: 99_000 + n,
      last_beat_age_ms: 1000 - n }]) }));
    await flush(r); expect(r.generate).toHaveBeenCalledTimes(1);
    expect(r.controller.snapshot().text).toMatch(/failed/i);
  });

  it("M1 the supplied unknown class remains unknown despite a contradictory fresh timestamp", async () => {
    const r = boot(() => response({ items: [item({ kind: "liveness_unknown" })] }));
    const snapshot = await run(r, input({ vm: vm([agent("executor-a", "T01", {
      activity: "unknown", last_beat_ts: 100_000, last_beat_age_ms: 0,
    })]) }));
    expect(snapshot.kind).toBe("generated"); expect(snapshot.text).toMatch(/Liveness unknown/i);
  });
});
