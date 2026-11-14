import { describe, expect, it, vi } from "vitest";
import { runParity } from "../../../src/ai/parity";
import type { HybridParamsShape, ModelFactory, ParityCase, ParityRow } from "../../../src/ai/types";
import { CLOUD, makeFake, modeNameOf, ON, TASKS, type Reply, type T } from "./harness";
import { TASK_SCHEMAS, VALID } from "./schemaMock";

vi.mock("../../../src/schema", () => import("./schemaMock"));

const cases = (task: T, n: number): ParityCase[] =>
  Array.from({ length: n }, (_, i) => ({ task, prompt: `p${i}` }));
const isRed = (rows: ParityRow[]) => rows.some((r) => r.t4) || rows.some((r) => r.source === "ON_DEVICE" && !r.constraintPresent);
const row = (rows: ParityRow[], task: T, source: ParityRow["source"]) => rows.find((r) => r.task === task && r.source === source)!;

describe("O15 / B20 parity (T4)", () => {
  it("runs each case on a forced ONLY_ON_DEVICE and a forced ONLY_IN_CLOUD instance built with the B4 params", async () => {
    const fake = makeFake();
    const rows = await runParity(cases("summary", 3), fake);
    const modes = new Set(fake.createdParams.map((p) => modeNameOf(p)));
    expect(modes).toEqual(new Set(["ONLY_ON_DEVICE", "ONLY_IN_CLOUD"]));
    for (const p of fake.createdParams) {
      expect(p.onDeviceParams.promptOptions.responseConstraint).toBe(TASK_SCHEMAS["summary"]!.schema);
      expect(p.inCloudParams.generationConfig.responseSchema).toBe(TASK_SCHEMAS["summary"]!.schema);
      expect(p.inCloudParams.generationConfig.maxOutputTokens).toBe(200);
    }
    expect(fake.calls).toHaveLength(6); // 3 cases x 2 sources
    expect(rows).toHaveLength(2);
    expect(row(rows, "summary", "ON_DEVICE")).toMatchObject({ n: 3, rejects: 0, rate: 0, t4: false, constraintPresent: true });
    expect(row(rows, "summary", "IN_CLOUD")).toMatchObject({ n: 3, rejects: 0, rate: 0, t4: false, constraintPresent: true });
    expect(isRed(rows)).toBe(false);
  });

  it("O15 scripted 1/10 reject on cloud: rate 0.1, t4 true, overall red; on-device row stays clean", async () => {
    const fake = makeFake();
    let k = 0;
    const base = fake.reply;
    fake.reply = (task, p) => {
      if (modeNameOf(p) === "ONLY_IN_CLOUD" && k++ === 4) return { text: "off schema", inferenceSource: CLOUD };
      return base(task, p);
    };
    const rows = await runParity(cases("summary", 10), fake);
    const c = row(rows, "summary", "IN_CLOUD");
    expect(c.n).toBe(10);
    expect(c.rejects).toBe(1);
    expect(c.rate).toBeCloseTo(0.1, 10);
    expect(c.t4).toBe(true);
    expect(row(rows, "summary", "ON_DEVICE").t4).toBe(false);
    expect(isRed(rows)).toBe(true);
  });

  it("t4 threshold is strictly > 0.05: 1/20 is not red, 2/20 is", async () => {
    for (const [rejectCount, expected] of [[1, false], [2, true]] as const) {
      const fake = makeFake();
      let k = 0;
      const base = fake.reply;
      fake.reply = (task, p) => (modeNameOf(p) === "ONLY_ON_DEVICE" && k++ < rejectCount ? { text: "{", inferenceSource: ON } : base(task, p));
      const rows = await runParity(cases("next_action", 20), fake);
      const r = row(rows, "next_action", "ON_DEVICE");
      expect(r.rate).toBeCloseTo(rejectCount / 20, 10);
      expect(r.t4).toBe(expected);
    }
  });

  it("rejects counts SCHEMA_REJECT, BAD_SOURCE and SDK_ERROR", async () => {
    const fake = makeFake();
    let k = 0;
    const base = fake.reply;
    fake.reply = (task, p): Reply => {
      if (modeNameOf(p) !== "ONLY_IN_CLOUD") return base(task, p);
      const i = k++;
      if (i === 0) return { text: "nope", inferenceSource: CLOUD };            // SCHEMA_REJECT
      if (i === 1) return { text: VALID["summary"]!, inferenceSource: "x" };   // BAD_SOURCE
      if (i === 2) return { throws: new Error("boom") };                        // SDK_ERROR
      return base(task, p);
    };
    const rows = await runParity(cases("summary", 8), fake);
    expect(row(rows, "summary", "IN_CLOUD").rejects).toBe(3);
    expect(row(rows, "summary", "IN_CLOUD").n).toBe(8);
  });

  it("O15 factory wrapper that strips onDeviceParams: on-device row has constraintPresent false and overall is red", async () => {
    const inner = makeFake();
    const stripping: ModelFactory = {
      modeConst: (m) => inner.modeConst(m), sourceConst: inner.sourceConst,
      create: (p: HybridParamsShape) => {
        const { onDeviceParams: _drop, ...rest } = p;
        return inner.create(rest as unknown as HybridParamsShape);
      },
    };
    // harness maps handles via responseSchema, which the wrapper keeps
    const rows = await runParity(cases("status", 4), stripping);
    expect(row(rows, "status", "ON_DEVICE").constraintPresent).toBe(false);
    expect(isRed(rows)).toBe(true);
  });

  it("parity covers each permitted source; screenshot remains on-device under the privacy rule", async () => {
    const fake = makeFake();
    const all = TASKS.flatMap((t) => cases(t, 2));
    const withImg = all.map((c) => (c.task === "screenshot" ? { ...c, image: { mimeType: "image/png", data: "AAAA" } } : c));
    const rows = await runParity(withImg, fake);
    expect(rows).toHaveLength(9);
    for (const t of TASKS) for (const s of ["ON_DEVICE", "IN_CLOUD"] as const) {
      if(t === "screenshot" && s === "IN_CLOUD") {
        expect(rows.find(r => r.task === t && r.source === s)).toBeUndefined();
        continue;
      }
      expect(row(rows, t, s), `${t}/${s}`).toMatchObject({ n: 2, constraintPresent: true });
    }
    expect(fake.calls.filter(c => c.task === "screenshot" && modeNameOf(c.handle.params) === "ONLY_IN_CLOUD")).toHaveLength(0);
  });

  it("uses cfg overrides (max_output_tokens, model_name) through the same builder", async () => {
    const fake = makeFake();
    await runParity(cases("digest", 1), fake, { max_output_tokens: 33, model_name: "zzz" });
    expect(fake.createdParams.length).toBeGreaterThanOrEqual(2);
    for (const p of fake.createdParams) {
      expect(p.inCloudParams.generationConfig.maxOutputTokens).toBe(33);
      expect(p.inCloudParams.model).toBe("zzz");
    }
  });

  it("empty case list yields no rows and creates no failing state", async () => {
    await expect(runParity([], makeFake())).resolves.toEqual([]);
  });
});
