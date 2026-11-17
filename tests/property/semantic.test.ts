import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { foldPlan } from "../../src/plan/reducer";
import type { PlanningTemplate, PlanProjection } from "../../src/plan/types";
import { createAgentStore } from "../../src/app/agent_store";
import { foldRoomWithStats } from "../../src/agents";

interface Vector {
  id: string; templates: Record<string, PlanningTemplate>; events: unknown[];
  expected_projection: PlanProjection; expected_rejected: PlanProjection["rejected"];
}
interface Event {
  id: string; lamport: number; ts: number; room: string; agent: string;
  act: string; text: string; op?: Record<string, unknown>;
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const vectors = (JSON.parse(readFileSync(new URL("./vectors.baseline.json", import.meta.url), "utf8")) as { cases: Vector[] }).cases;
const template = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8")) as PlanningTemplate;
const seeds = Number(process.env["U116_SEEDS"] ?? "100");
const steps = Number(process.env["U116_STEPS"] ?? "128");
function python<T>(request: unknown): T {
  const child = spawnSync(process.env["PYTHON"] ?? "python3", ["-B", "-m", "bridge.tests.property.probe"], {
    cwd: root, input: JSON.stringify(request), encoding: "utf8", timeout: 180000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 256 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) throw new Error(`Python adapter infrastructure failure: ${child.error?.name ?? child.status}\n${child.stderr}`);
  return JSON.parse(child.stdout) as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}
function firstDifference(a: unknown, b: unknown, path = "$"): string | undefined {
  if (canonical(a) === canonical(b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) { const d = firstDifference(a[i], b[i], `${path}[${i}]`); if (d) return d; }
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!Object.hasOwn(left, k) || !Object.hasOwn(right, k)) return `${path}.${k}`;
      const d = firstDifference(left[k], right[k], `${path}.${k}`); if (d) return d;
    }
  }
  return path;
}
function artifact(name: string, value: unknown) {
  const dir = new URL("./artifacts/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(name, dir), JSON.stringify(value, null, 2) + "\n");
}
function checkStats(events: unknown[], result: ReturnType<typeof foldPlan>) {
  const eligible = events.filter((e): e is Event => !!e && typeof e === "object" &&
    typeof (e as Event).id === "string" && Number.isSafeInteger((e as Event).lamport) && (e as Event).lamport >= 1);
  const byId = new Map(eligible.map(e => [e.id, e]));
  const opCount = [...byId.values()].filter(e => e.act === "op").length;
  expect(result.stats.applied + result.stats.replayed + result.stats.rejected).toBe(opCount);
  expect(result.stats.rejected).toBe(result.projection.rejected.length);
  expect(result.stats.errors.map(e => e.code)).toEqual(result.projection.rejected.map(e => e.code));
}
function minimize(events: Event[], fails: (e: Event[]) => boolean): Event[] {
  let kept = structuredClone(events), changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < kept.length; i++) {
      const trial = [...kept.slice(0, i), ...kept.slice(i + 1)];
      if (fails(trial)) { kept = trial; changed = true; break; }
    }
  }
  for (let i = 0; i < kept.length; i++) for (const key of ["title", "text", "accept", "reason", "note"]) {
    if (typeof kept[i]?.op?.[key] !== "string") continue;
    const trial = structuredClone(kept); trial[i]!.op![key] = "";
    if (fails(trial)) kept = trial;
  }
  return kept;
}

it("both languages consume independently frozen expectations and every prefix", () => {
  const replies = python<Array<{ projection: PlanProjection; prefixes: PlanProjection[] }>>({ mode: "vectors", cases: vectors });
  vectors.forEach((v, index) => {
    const before = canonical(v), t = Object.values(v.templates)[0];
    expect(Object.keys(v.templates).length, "multi-template registry API is unavailable").toBeLessThanOrEqual(1);
    freeze(v);
    expect(replies[index]!.projection, v.id).toEqual(v.expected_projection);
    const actual = foldPlan(v.events, t).projection;
    if (canonical(actual) !== canonical(v.expected_projection)) {
      const expected = v.expected_projection;
      const minimized = minimize(v.events as Event[], events => canonical(foldPlan(events, t).projection) !== canonical(python({ mode: "fold", events, templates: v.templates })));
      artifact(`failure-vector-${v.id}.json`, { id: v.id, original: v.events, minimized,
        first_difference: firstDifference(python({ mode: "fold", events: minimized, templates: v.templates }), foldPlan(minimized, t).projection), expected, actual });
    }
    expect(actual, v.id).toEqual(v.expected_projection);
    expect(v.expected_projection.rejected).toEqual(v.expected_rejected);
    for (let i = 0; i <= v.events.length; i++) {
      const r = foldPlan(v.events.slice(0, i), t);
      expect(r.projection, `${v.id} prefix ${i}`).toEqual(replies[index]!.prefixes[i]);
      checkStats(v.events.slice(0, i), r);
    }
    expect(canonical(v)).toBe(before);
  });
});

it("shared adapter corruption is detected by explicit expectations", () => {
  const v = vectors.find(c => c.id === "equal_lamport_reverse_id")!;
  const broken = { ...v.expected_projection, tasks: [] };
  const both = [() => broken, () => broken];
  expect(both[0]!()).toEqual(both[1]!());
  for (const adapter of both) expect(() => expect(adapter()).toEqual(v.expected_projection)).toThrow();
});

it("generated mixed histories agree at every prefix and pass independent invariants", () => {
  expect(Number.isInteger(seeds) && seeds >= 1).toBe(true);
  const pack = python<{ version: string; cases: Array<{ seed: number; events: Event[]; hash: string; prefixes: PlanProjection[] }> }>({ mode: "generated", seeds, steps });
  let prefixes = 0;
  for (const c of pack.cases) {
    expect(hash(c.events)).toBe(c.hash);
    const before = canonical([c.events, template]); freeze(c.events); freeze(template);
    for (let i = 0; i <= c.events.length; i++) {
      const input = c.events.slice(0, i), actual = foldPlan(input, template);
      const expected = c.prefixes[i]!;
      if (canonical(actual.projection) !== canonical(expected)) {
        const fails = (events: Event[]) => canonical(foldPlan(events, template).projection) !== canonical(python<PlanProjection>({ mode: "fold", events }));
        const minimized = minimize(input, fails);
        artifact(`failure-${c.seed}.json`, { seed: c.seed, original: input, minimized,
          first_difference: firstDifference(python({ mode: "fold", events: minimized }), foldPlan(minimized, template).projection) });
      }
      expect(actual.projection, `seed ${c.seed}, prefix ${i}, path ${firstDifference(expected, actual.projection)}`).toEqual(expected);
      checkStats(input, actual); prefixes++;
    }
    expect(canonical([c.events, template])).toBe(before);
    // Only identical duplicates occur in these histories, so this permutation is legal.
    expect(foldPlan([...c.events].reverse(), template).projection).toEqual(c.prefixes.at(-1));
    expect(foldPlan([...c.events, ...c.events.slice(0, 8)], template).projection).toEqual(c.prefixes.at(-1));
  }
  artifact("differential.json", { status: "PASS", stage: "baseline", generator: pack.version, seeds, steps, prefixes,
    history_hashes: pack.cases.map(c => ({ seed: c.seed, sha256: c.hash })) });
  console.log(`semantic-history-check: ${seeds} seeds, ${prefixes} prefixes, zero unexplained projection divergences`);
});

it("removing the TypeScript ID tie-breaker is witnessed and detected", () => {
  const v = vectors.find(c => c.id === "equal_lamport_reverse_id")!;
  expect(foldPlan(v.events, Object.values(v.templates)[0]).projection).toEqual(v.expected_projection);
  const native = Array.prototype.sort;
  let activated = false;
  const spy = vi.spyOn(Array.prototype, "sort").mockImplementation(function(this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    const entries = this as Array<{ raw?: unknown; lamport?: number; id?: string }>;
    if (entries.length === 2 && entries.every(e => e?.raw !== undefined && typeof e.lamport === "number") && entries[0]!.lamport === entries[1]!.lamport && entries[0]!.id! > entries[1]!.id!) {
      activated = true;
      return Reflect.apply(native, this, [(a: { lamport: number }, b: { lamport: number }) => a.lamport - b.lamport]) as unknown[];
    }
    return Reflect.apply(native, this, [compare]) as unknown[];
  });
  let bad: PlanProjection;
  try { bad = foldPlan(v.events, Object.values(v.templates)[0]).projection; } finally { spy.mockRestore(); }
  expect(activated).toBe(true);
  expect(() => expect(bad).toEqual(v.expected_projection)).toThrow();
  artifact("typescript-mutations.json", [{ id: "remove-id-order-typescript", applied: 1, activated: 1, detected: 1, infrastructure_failures: [] }]);
});

it("hostile Lamport and prototype/reason payloads cannot grant authority", () => {
  const v = vectors.find(c => c.id === "equal_lamport_reverse_id")!;
  const t = Object.values(v.templates)[0];
  const hostile = { ...v.events[0] as Event, id: "hostile", lamport: true };
  expect(foldPlan([...v.events, hostile], t).projection).toEqual(v.expected_projection);
  expect(foldPlan([hostile], t).stats.invalid).toBe(1);
  const payload = JSON.parse('{"kind":"task.set","task_id":"T01","base_rev":1,"reason":{"__proto__":{"admin":true}}}');
  const result = foldPlan([...v.events, { ...v.events[0] as Event, id: "hostile-reason", lamport: 2, op: payload }], t);
  expect(result.projection.tasks).toEqual(v.expected_projection.tasks);
  expect(result.projection.rejected.at(-1)?.code).toBe("bad_op");
  expect(Object.hasOwn(Object.prototype, "admin")).toBe(false);
});

it("late ingestion and changed resolver content change independently refolded views", () => {
  const v = vectors.find(c => c.id === "equal_lamport_reverse_id")!;
  const open = { ...v.events[1] as Event, id: "e-0000000000000001", lamport: 1 };
  const add = { ...v.events[0] as Event, id: "e-0000000000000002", lamport: 2 };
  let resolved = structuredClone(template);
  const store = createAgentStore({ templates: () => resolved });
  const check = () => {
    const all = store.events("oracle");
    expect(store.plan("oracle")!.projection).toEqual(foldPlan(all, resolved).projection);
    expect(store.states()).toEqual(foldRoomWithStats(all).states);
  };
  expect(store.ingest(add)).toBe(true); check();
  const stale = structuredClone(store.plan("oracle")!.projection);
  expect(store.ingest(open)).toBe(true); check();
  expect(store.plan("oracle")!.projection).not.toEqual(stale);
  expect(() => expect(stale).toEqual(foldPlan(store.events("oracle"), resolved).projection)).toThrow();
  const memory: Event = { ...add, id: "e-0000000000000003", lamport: 3,
    op: { kind: "memory.set", section: "notes", text: "Changed result", base_rev: 0 } };
  expect(store.ingest(memory)).toBe(true); check();
  const cached = structuredClone(store.plan("oracle")!.projection);
  resolved = { ...structuredClone(template), memory_sections: template.memory_sections.map(s => ({ ...s, max_chars: 1 })) };
  check();
  expect(store.plan("oracle")!.projection).not.toEqual(cached);
  expect(() => expect(cached).toEqual(foldPlan(store.events("oracle"), resolved).projection)).toThrow();
  // At baseline these are semantic controls. An actual U113 invalidation target is absent.
});
