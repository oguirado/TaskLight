// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyOp, checkConformance, foldPlan, validateOpEvent, validateTemplate } from "../../../src/plan";
import type { PlanProjection } from "../../../src/plan";
import { add, clone, event, freeze, open, projection, template } from "./helpers";

const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
const revoked = Proxy.revocable({}, {}); revoked.revoke();
const throwing = Object.defineProperty({}, "act", {get() { throw new Error("hostile getter"); }});
const hostile: [string, unknown][] = [
  ["null", null], ["undefined", undefined], ["number", 7], ["string", "text"], ["boolean", true],
  ["NaN", NaN], ["Infinity", Infinity], ["cyclic", cyclic], ["bigint", 1n],
  ["symbol", Symbol("hostile")], ["function", () => 1], ["revoked proxy", revoked.proxy], ["getter", throwing],
];

describe("H1 never-throw public boundaries", () => {
  for (const [name, raw] of hostile) {
    it(`H1 foldPlan ${name}`, () => {
      let result: ReturnType<typeof foldPlan> | undefined;
      expect(() => { result = foldPlan(raw, template); }).not.toThrow();
      expect(result).toHaveProperty("projection"); expect(result).toHaveProperty("stats");
      expect(result!.projection).toEqual(projection("empty"));
    });
    it(`H1 applyOp ${name}`, () => {
      const p = freeze(projection()); const before = clone(p);
      let result: ReturnType<typeof applyOp> | undefined;
      expect(() => { result = applyOp(p, raw, template); }).not.toThrow();
      expect(result).toMatchObject({ok: false}); expect(p).toEqual(before);
      expect(result!.projection.tasks).toEqual(before.tasks);
    });
    it(`H1 validateOpEvent ${name}`, () => {
      expect(validateOpEvent(raw)).toBe(false);
    });
    it(`H1 validateTemplate ${name}`, () => {
      const r = validateTemplate(raw); expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    });
    it(`H1 checkConformance ${name}`, () => {
      let result: ReturnType<typeof checkConformance> | undefined;
      expect(() => { result = checkConformance(raw as PlanProjection, template); }).not.toThrow();
      expect(typeof result!.ok).toBe("boolean"); expect(Array.isArray(result!.findings)).toBe(true);
    });
  }
  const malformed: [string, Record<string, unknown>][] = [
    ["boolean lamport", {lamport: true}], ["zero lamport", {lamport: 0}],
    ["negative lamport", {lamport: -1}], ["fraction lamport", {lamport: 1.5}],
    ["unsafe lamport", {lamport: Number.MAX_SAFE_INTEGER + 1}], ["NaN lamport", {lamport: NaN}],
    ["infinite lamport", {lamport: Infinity}], ["NaN ts", {ts: NaN}], ["infinite ts", {ts: Infinity}],
    ["boolean ts", {ts: false}], ["fraction ts", {ts: 1.5}],
    ["positive timestamp bound", {ts: 8.64e15 + 1}], ["negative timestamp bound", {ts: -8.64e15 - 1}],
    ["uppercase event id", {id: "e-AAAAAAAAAAAAAAAA"}],
    ["event id length", {id: "e-00000000000000000"}],
    ["event id", {id: "e-abc"}], ["room leading dash", {room: "-room"}],
    ["room length", {room: "x".repeat(49)}], ["agent length", {agent: "x".repeat(49)}],
    ["room", {room: "Bad Room"}], ["agent", {agent: "Bad Agent"}],
    ["unknown kind", {op: {kind: "unknown"}}], ["cyclic op", {op: cyclic}],
    ["bigint payload", {op: add({estimate: 1n})}], ["function payload", {op: add({estimate: () => 1})}],
    ["symbol payload", {op: add({estimate: Symbol("x")})}],
    ["text UTF-8 overflow", {text: "é".repeat(2049)}],
  ];
  for (const [name, patch] of malformed)
    it(`H1 malformed envelope ${name} rejected without throwing`, () => {
      const raw = event(1, open(), patch);
      expect(validateOpEvent(raw)).toBe(false);
      expect(() => applyOp(projection(), raw, template)).not.toThrow();
      expect(() => foldPlan([raw], template)).not.toThrow();
    });
  for (const ts of [-8.64e15, 8.64e15])
    it(`H1 valid symmetric timestamp boundary ${ts}`, () => expect(validateOpEvent(event(1, open(), {ts}))).toBe(true));
  it("H1 valid identifier and safe-integer boundaries", () => {
    expect(validateOpEvent(event(1, open(), {room: "x".repeat(48), agent: "x".repeat(48), lamport: Number.MAX_SAFE_INTEGER}))).toBe(true);
    expect(validateOpEvent(event(1, open(), {agent: "a.b_c-d", room: "a-1"}))).toBe(true);
  });
  it("H1 text UTF-8 bound inclusive", () => {
    expect(validateOpEvent(event(1, open(), {text: "é".repeat(2048)}))).toBe(true);
    expect(validateOpEvent(event(1, open(), {text: "x".repeat(4096)}))).toBe(true);
    expect(validateOpEvent(event(1, open(), {text: "x".repeat(4097)}))).toBe(false);
  });
  it("H1 operation compact JSON byte overflow is limit_exceeded", () => {
    // Many brief strings stay individually short while the canonical payload exceeds the cap.
    const brief = Object.fromEntries(Array.from({length: 8}, (_, i) => [`field${i}`, "😀".repeat(300)]));
    const e = event(1, {...open(), brief});
    expect(Buffer.byteLength(JSON.stringify(e.op), "utf8")).toBeGreaterThan(8192);
    expect(validateOpEvent(e)).toBe(false);
    expect(applyOp(projection("empty"), e, template)).toMatchObject({ok: false, code: "limit_exceeded"});
  });
  const bounds: [string, Record<string, unknown>, number][] = [
    ["title", add(), 120], ["accept", add(), 160], ["estimate", add(), 32],
  ];
  for (const [field, op, cap] of bounds)
    it(`H1 task ${field} counts Unicode code points`, () => {
      const p = projection("plan_open");
      expect(applyOp(p, event(10, {...op, [field]: "😀".repeat(cap)}), template).ok).toBe(true);
      expect(applyOp(p, event(10, {...op, [field]: "😀".repeat(cap + 1)}), template)).toMatchObject({ok: false, code: "bad_op"}); // A-U60a: field length range = bad_op (Python U55 canonical)
    });
  for (const [field, cap] of [["outcome", 240], ["took", 32]] as const)
    it(`H1 micro ${field} cap`, () => {
      const op = {kind: "micro.set", micro_id: "T01.M01", state: "done"};
      expect(applyOp(projection(), event(10, {...op, [field]: "x".repeat(cap)}), template).ok).toBe(true);
      expect(applyOp(projection(), event(10, {...op, [field]: "x".repeat(cap+1)}), template)).toMatchObject({ok: false, code: "bad_op"}); // A-U60a: field length range = bad_op (Python U55 canonical)
    });

  it("H1 canonical operation payload byte boundary is inclusive", () => {
    const op = add({title: "A", microtasks: Array.from({length: 12}, () => ({text: "x".repeat(80), accept: "x".repeat(160)}))});
    const micros = op.microtasks as {text: string; accept: string}[];
    let remaining = 8192 - Buffer.byteLength(JSON.stringify(op), "utf8");
    for (const micro of micros) for (const field of ["text", "accept"] as const) {
      const n = Math.min(Math.floor(remaining / 3), micro[field].length);
      micro[field] = "😀".repeat(n) + micro[field].slice(n); remaining -= n * 3;
    }
    op.title += "x".repeat(remaining);
    expect(Buffer.byteLength(JSON.stringify(op), "utf8")).toBe(8192);
    expect(validateOpEvent(event(10, op))).toBe(true);
    const overflow = {...op, title: op.title + "x"};
    expect(Buffer.byteLength(JSON.stringify(overflow), "utf8")).toBe(8193);
    expect(validateOpEvent(event(10, overflow))).toBe(false);
    expect(applyOp(projection("plan_open"), event(10, overflow), template)).toMatchObject({ok: false, code: "limit_exceeded"});
  });
  for (const [field, cap] of [["text", 80], ["accept", 160]] as const)
    it(`H1 micro.add ${field} code-point cap`, () => {
      const op = {kind: "micro.add", task_id: "T01", base_rev: 3, text: "Next"};
      expect(applyOp(projection(), event(10, {...op, [field]: "😀".repeat(cap)}), template).ok).toBe(true);
      expect(applyOp(projection(), event(10, {...op, [field]: "😀".repeat(cap+1)}), template)).toMatchObject({ok: false, code: "bad_op"}); // A-U60a: field length range = bad_op (Python U55 canonical)
    });
  it("H1 plan title code-point cap", () => {
    expect(applyOp(projection("empty"), event(1, {...open(), title: "😀".repeat(120)}), template).ok).toBe(true);
    expect(applyOp(projection("empty"), event(1, {...open(), title: "😀".repeat(121)}), template)).toMatchObject({ok: false, code: "bad_op"}); // A-U60a: field length range = bad_op (Python U55 canonical)
  });
  it("H1 cyclic nested op is rejected; getter serialization never escapes", () => {
    const op = add({microtasks: cyclic});
    expect(validateOpEvent(event(10, op))).toBe(false);
    expect(() => applyOp(projection(), event(10, op), template)).not.toThrow();
    const jsonTrap = add({toJSON() { throw new Error("hostile serialization"); }});
    expect(validateOpEvent(event(10, jsonTrap))).toBe(false);
    expect(() => applyOp(projection(), event(10, jsonTrap), template)).not.toThrow();
    const bad = Object.defineProperty(add(), "title", {get() { throw new Error("hostile title"); }});
    expect(validateOpEvent(event(10, bad))).toBe(false);
  });
});

describe("H2 prototype pollution canaries", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const poison = () => JSON.parse(`{"${key}":{"polluted":true,"prototype":{"p":1}}}`) as Record<string, unknown>;
    for (const where of ["op", "brief", "event"])
      it(`H2 ${key} inside ${where}`, () => {
        const raw = event(10, open());
        const hostileEvent = where === "op" ? {...raw, op: {...raw.op, ...poison()}}
          : where === "brief" ? {...raw, op: {...raw.op, brief: poison()}} : {...raw, ...poison()};
        expect(validateOpEvent(hostileEvent)).toBe(false);
        expect(applyOp(projection("empty"), hostileEvent, template).ok).toBe(false);
        expect(foldPlan([hostileEvent], template).projection.plan).toBeNull();
        expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
        expect(({} as Record<string, unknown>)["p"]).toBeUndefined();
      });
    it(`H2 ${key} template`, () => {
      expect(validateTemplate({...clone(template), ...poison()}).ok).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
    it(`H2 ${key} events array own key`, () => {
      const events = Object.assign([event(1, open())], poison());
      expect(foldPlan(events, template).projection.plan).toBeNull();
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
  }
  it("H2 combined JSON.parse canary nested inside op", () => {
    const poison = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"p":1}}}');
    expect(validateOpEvent(event(10, {...open(), brief: poison}))).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("H3 mixed legacy and v2 stream", () => {
  it("H3 valid legacy events ignored without increasing invalid", () => {
    const events = [null, 4, "text", event(1, {}, {act: "heartbeat"}),
      event(2, {}, {act: "plan", plan: {title: "Legacy", steps: [{text: "Step"}]}}), event(3, open())];
    const r = foldPlan(freeze(events), template);
    expect(r.stats.invalid).toBe(0); expect(r.projection.plan).toMatchObject({id: "p1", rev: 3});
    expect(r.projection.tasks).toEqual([]);
  });
  it("H3 structurally malformed act=op increments invalid", () => {
    const r = foldPlan([{act: "op"}, event(1, open())], template);
    expect(r.stats.invalid).toBe(1); expect(r.projection.plan!.rev).toBe(1);
  });
});
