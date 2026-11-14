// SPEC_AMEND_C B31 / B32: LedgerRow log and the G10 check. Oracle A12, A15.
import { describe, expect, test } from "vitest";
import { checkG10, checkSyncedText, createRowLog } from "../../../src/ledger";
import type { LedgerRow } from "../../../src/ledger";
import { SOURCE_FLOORS, effectiveMode } from "../../../src/lens";

const row = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  jobKey: "j1", projectId: "p1", lens_id: "dev", task: "summary", source: "page", tier: "standard",
  floor: "ONLY_ON_DEVICE", requested: "PREFER_IN_CLOUD", effective: "ONLY_ON_DEVICE", inference_source: "ON_DEVICE", ...o,
});

describe("A12 g10_page_cloud (B32)", () => {
  test("page row with floor ONLY_ON_DEVICE served IN_CLOUD -> CLOUD_UNDER_DEVICE_FLOOR; ON_DEVICE control ok", () => {
    const bad = checkG10([row({ inference_source: "IN_CLOUD" })]);
    expect(bad.ok).toBe(false);
    expect(bad.violations).toEqual([{ row: 0, code: "CLOUD_UNDER_DEVICE_FLOOR" }]);
    const ok = checkG10([row({ inference_source: "ON_DEVICE" })]);
    expect(ok).toEqual({ ok: true, violations: [] });
  });
  test("fires when only `effective` is ONLY_ON_DEVICE (floor null) and when only `floor` is (effective drifted)", () => {
    expect(checkG10([row({ floor: null, effective: "ONLY_ON_DEVICE", inference_source: "IN_CLOUD" })]).violations[0]?.code).toBe("CLOUD_UNDER_DEVICE_FLOOR");
    expect(checkG10([row({ floor: "ONLY_ON_DEVICE", effective: "PREFER_IN_CLOUD", inference_source: "IN_CLOUD" })]).violations[0]?.code).toBe("CLOUD_UNDER_DEVICE_FLOOR");
  });
  test("neg: PREFER floors and cloud-allowed rows with IN_CLOUD are fine; skipped jobs (null source) are fine", () => {
    expect(checkG10([row({ source: "agent", floor: null, effective: "PREFER_IN_CLOUD", inference_source: "IN_CLOUD" })]).ok).toBe(true);
    expect(checkG10([row({ source: "tab", floor: "PREFER_ON_DEVICE", effective: "PREFER_ON_DEVICE", inference_source: "IN_CLOUD" })]).ok).toBe(true);
    expect(checkG10([row({ inference_source: null })]).ok).toBe(true);
    expect(checkG10([]).ok).toBe(true);
  });
  test("reports every offending row with its index, in order", () => {
    const rows = [row({ jobKey: "a", inference_source: "IN_CLOUD" }), row({ jobKey: "b" }), row({ jobKey: "c", inference_source: "IN_CLOUD" })];
    expect(checkG10(rows)).toEqual({ ok: false, violations: [{ row: 0, code: "CLOUD_UNDER_DEVICE_FLOOR" }, { row: 2, code: "CLOUD_UNDER_DEVICE_FLOOR" }] });
  });
  test("tolerates malformed rows without throwing (never reports ok for an IN_CLOUD row it cannot read)", () => {
    expect(() => checkG10([null as never, undefined as never, 5 as never, {} as never])).not.toThrow();
    const r = checkG10([{ inference_source: "IN_CLOUD", effective: "ONLY_ON_DEVICE" } as never]);
    expect(r.ok).toBe(false);
  });
});

describe("floors drive the row (U25 SOURCE_FLOORS): page and private sources never go to cloud", () => {
  test("rows built from real floors: every page/doc source and every private-tier row resolves ONLY_ON_DEVICE, and an IN_CLOUD result on them trips G10", () => {
    for (const src of ["page", "doc", "tab", "selection", "agent", "ci", "git"] as const)
      for (const tier of ["private", "standard", "shared"] as const) {
        const floor = SOURCE_FLOORS[src][tier];
        const effective = effectiveMode(floor, "PREFER_IN_CLOUD");
        const r = checkG10([row({ source: src, tier, floor, requested: "PREFER_IN_CLOUD", effective, inference_source: "IN_CLOUD" })]);
        const deviceOnly = floor === "ONLY_ON_DEVICE" || effective === "ONLY_ON_DEVICE";
        expect(r.ok, `${src}/${tier}`).toBe(!deviceOnly);
        if (src === "page" || src === "doc" || tier === "private") expect(deviceOnly, `${src}/${tier}`).toBe(true);
      }
  });
});

describe("A15 unavailable_no_cloud_leak (ledger side)", () => {
  test("a skipped private job is recorded with inference_source null; zero IN_CLOUD rows; G10 ok", () => {
    const log = createRowLog();
    log.record(row({ jobKey: "skip1", source: "agent", tier: "private", floor: "ONLY_ON_DEVICE", requested: "PREFER_IN_CLOUD", effective: "ONLY_ON_DEVICE", inference_source: null }));
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0]!.inference_source).toBeNull();
    expect(log.rows().filter((r) => r.inference_source === "IN_CLOUD")).toHaveLength(0);
    expect(log.check()).toEqual({ ok: true, violations: [] });
  });
});

describe("createRowLog (B31)", () => {
  test("records every job in order, including skipped ones; check() agrees with checkG10", () => {
    const log = createRowLog();
    log.record(row({ jobKey: "a" })); log.record(row({ jobKey: "b", inference_source: null })); log.record(row({ jobKey: "c", inference_source: "IN_CLOUD" }));
    expect(log.rows().map((r) => r.jobKey)).toEqual(["a", "b", "c"]);
    expect(log.check()).toEqual(checkG10(log.rows()));
    expect(log.check().violations).toEqual([{ row: 2, code: "CLOUD_UNDER_DEVICE_FLOOR" }]);
  });
  test("one row per jobKey: a duplicate record does not add a second row", () => {
    const log = createRowLog();
    log.record(row({ jobKey: "a" })); log.record(row({ jobKey: "a" }));
    expect(log.rows()).toHaveLength(1);
  });
  test("rows are copies: later mutation of the recorded object or of rows() output does not alter the log", () => {
    const log = createRowLog(); const r = row({ jobKey: "a" });
    log.record(r); r.inference_source = "IN_CLOUD";
    expect(log.rows()[0]!.inference_source).toBe("ON_DEVICE");
    try { (log.rows() as LedgerRow[]).push(row({ jobKey: "zz" })); } catch { /* frozen ok */ }
    try { (log.rows()[0] as { projectId: string }).projectId = "hacked"; } catch { /* frozen ok */ }
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0]!.projectId).toBe("p1");
  });
  test("a row carries no text: unknown extra keys on the recorded object are not retained", () => {
    const log = createRowLog();
    log.record({ ...row(), headline: "SECRET-HL", prompt: "SECRET-P" } as never);
    expect(JSON.stringify(log.rows())).not.toContain("SECRET");
  });
  test("garbage never throws", () => {
    const log = createRowLog();
    for (const g of [null, undefined, 3, "x", [], {}]) expect(() => log.record(g as never)).not.toThrow();
    expect(log.rows().every((r) => typeof r.jobKey === "string")).toBe(true);
  });
  test("pack_hash is optional and preserved when present (hash only, B29 never a source of text)", () => {
    const log = createRowLog();
    log.record(row({ jobKey: "a", pack_hash: "abc123" })); log.record(row({ jobKey: "b" }));
    expect(log.rows()[0]!.pack_hash).toBe("abc123");
    expect("pack_hash" in log.rows()[1]!).toBe(false);
  });
});

describe("checkSyncedText: TEXT_SYNCED_PRIVATE / TEXT_SYNCED_PAGE (B32, proposed API)", () => {
  test("private tier with any text key synced -> TEXT_SYNCED_PRIVATE; status/attention only is ok", () => {
    const bad = checkSyncedText([{ source: "agent", tier: "private", synced: { status: "running", headline: "H" } }]);
    expect(bad.ok).toBe(false);
    expect(bad.violations).toContainEqual({ row: 0, code: "TEXT_SYNCED_PRIVATE" });
    for (const k of ["headline", "summary", "next_action", "steps"]) expect(checkSyncedText([{ source: "agent", tier: "private", synced: { [k]: "x" } }]).ok, k).toBe(false);
    expect(checkSyncedText([{ source: "agent", tier: "private", synced: { status: "running", attention: "low", progress: 3 } }])).toEqual({ ok: true, violations: [] });
  });
  test("page-sourced standard capsule: only status, attention, progress may be synced", () => {
    const bad = checkSyncedText([{ source: "page", tier: "standard", synced: { status: "reading", summary: "PAGE-TEXT" } }]);
    expect(bad.violations).toContainEqual({ row: 0, code: "TEXT_SYNCED_PAGE" });
    expect(checkSyncedText([{ source: "page", tier: "standard", synced: { status: "reading", attention: "low", progress: 40 } }]).ok).toBe(true);
  });
  test("neg: a standard agent-sourced capsule may sync text; indices are reported per doc", () => {
    const r = checkSyncedText([{ source: "agent", tier: "standard", synced: { headline: "ok" } }, { source: "page", tier: "shared", synced: { headline: "leak" } }]);
    expect(r.violations.map((v) => v.row)).toEqual([1]);
    expect(r.violations[0]!.code).toBe("TEXT_SYNCED_PAGE");
  });
});
