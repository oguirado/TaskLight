// Oracle 13: selection storage (ids only, v:1, storage.local via injected store).
import { describe, expect, it } from "vitest";
import { boot, bootReady, gen, selGet, selSet, mkPort, post, nackOf, frames, settle, hostRid, hResult, FakeStore, SEL_KEY } from "./harness";
import { MODEL_SELECTION_KEY } from "../../../extension/src/model_relay";

const selFrame = (rid: string, selection: unknown) => ({ t: "model_sel", v: 1, rid, selection });

describe("O13 selection", () => {
  it("the storage key is u49.model_selection", () => { expect(MODEL_SELECTION_KEY).toBe(SEL_KEY); });
  it("get on an empty store -> {} (works while the host gate is closed)", async () => {
    const h = boot(); const p = mkPort(); post(h, p, selGet("s")); await settle();
    expect(frames(p)).toEqual([selFrame("s", {})]); expect(h.native.sent).toEqual([]); expect(h.store.writes).toEqual([]);
  });
  it("set stores exactly {v:1, ...} under the key, replies model_sel with the stored value, and get round-trips", async () => {
    const h = boot(); const p = mkPort(); const sel = { all: "cloud1", groups: { capsule: "local1", digest: "firebase-hybrid", routing: "a", drift: "b-1" } };
    post(h, p, selSet("s1", sel)); await settle();
    expect(h.store.writes).toEqual([{ key: SEL_KEY, value: { v: 1, ...sel } }]);
    expect(frames(p)).toEqual([selFrame("s1", sel)]);
    p.sent.length = 0; post(h, p, selGet("s2")); await settle();
    expect(frames(p)).toEqual([selFrame("s2", sel)]);
  });
  it("set {} stores {v:1} and replies {}; partial group maps are kept as given", async () => {
    const h = boot(); const p = mkPort();
    post(h, p, selSet("a", {})); await settle(); post(h, p, selSet("b", { groups: { drift: "x" } })); await settle();
    expect(h.store.writes.map((w) => w.value)).toEqual([{ v: 1 }, { v: 1, groups: { drift: "x" } }]);
    expect(frames(p)).toEqual([selFrame("a", {}), selFrame("b", { groups: { drift: "x" } })]);
  });
  it("ids are not checked against the host (unknown endpoint id is stored)", async () => {
    const h = bootReady([]); const p = mkPort(); post(h, p, selSet("a", { all: "not-in-host" })); await settle();
    expect(h.store.writes).toHaveLength(1);
  });
  const rejects: Array<[string, unknown]> = [
    ["URL value", { all: "https://evil.example/v1" }],
    ["value with colon", { all: "a:b" }],
    ["value with slash", { groups: { capsule: "a/b" } }],
    ["url-ish group value", { groups: { digest: "http://x" } }],
    ["unknown group", { groups: { other: "a" } }],
    ["extra top-level key", { all: "a", extra: "b" }],
    ["extra key v", { v: 1, all: "a" }],
    ["33-char id", { all: "a".repeat(33) }],
    ["32-char id is fine only if valid; 33 in group", { groups: { routing: "a".repeat(33) } }],
    ["uppercase id", { all: "Cloud1" }],
    ["leading dash", { all: "-x" }],
    ["empty id", { all: "" }],
    ["non-string id", { all: 5 }],
    ["groups not an object", { groups: "x" }],
    ["groups array", { groups: [] }],
    ["selection null", null],
    ["selection array", []],
    ["selection string", "all"],
  ];
  it.each(rejects)("%s -> bad_request, 0 writes", async (_n, selection) => {
    const h = boot(); const p = mkPort(); post(h, p, selSet("s", selection)); await settle();
    expect(frames(p)).toEqual([nackOf("s", "bad_request")]); expect(h.store.writes).toEqual([]);
  });
  it("sel_set without selection, or with extra frame keys -> bad_request, 0 writes", async () => {
    const h = boot(); const p = mkPort();
    post(h, p, { t: "model_sel_set", v: 1, rid: "x" }); post(h, p, { ...selSet("y", {}), extra: 1 }); await settle();
    expect(frames(p)).toEqual([nackOf("x", "bad_request"), nackOf("y", "bad_request")]); expect(h.store.writes).toEqual([]);
  });
  it("a 32-char valid id is accepted", async () => {
    const h = boot(); const p = mkPort(); post(h, p, selSet("s", { all: "a".repeat(32) })); await settle();
    expect(h.store.writes).toHaveLength(1);
  });
  it("store set failure -> store_failed; get failure -> store_failed", async () => {
    const st = new FakeStore(); st.failSet = true; const h = boot(st); const p = mkPort();
    post(h, p, selSet("s", { all: "a" })); await settle();
    expect(frames(p)).toEqual([nackOf("s", "store_failed")]);
    st.failGet = true; p.sent.length = 0; post(h, p, selGet("g")); await settle();
    expect(frames(p)).toEqual([nackOf("g", "store_failed")]);
  });
  const malformed: unknown[] = [
    "str", 5, null, [], { v: 2, all: "a" }, { all: "a" }, { v: 1, all: "UP" }, { v: 1, all: "https://e/x" }, { v: 1, groups: { x: "a" } },
    { v: 1, all: "a", extra: 1 }, { v: 1, all: "a", groups: { capsule: "BAD" } }, { v: 1, groups: [] },
  ];
  it.each(malformed.map((m) => [JSON.stringify(m), m] as const))("get maps malformed stored value %s to {}", async (_n, stored) => {
    const st = new FakeStore(); st.data.set(SEL_KEY, stored); const h = boot(st); const p = mkPort();
    post(h, p, selGet("s")); await settle();
    expect(frames(p)).toEqual([selFrame("s", {})]); expect(st.writes).toEqual([]);
  });
  it("a valid stored value is returned without the v field", async () => {
    const st = new FakeStore(); st.data.set(SEL_KEY, { v: 1, all: "cloud1" }); const h = boot(st); const p = mkPort();
    post(h, p, selGet("s")); await settle(); expect(frames(p)).toEqual([selFrame("s", { all: "cloud1" })]);
  });
  it("sel_get/set do not use the host queue: answered while a generate is in flight, with 0 extra host sends", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g")); const n = h.native.sent.length;
    post(h, p, selSet("s", { all: "a" })); await settle();
    expect(h.native.sent).toHaveLength(n); expect(p.ofType("model_sel")).toHaveLength(1);
    h.native.emit(hResult(hostRid(h, "model_generate"))); expect(p.ofType("model_result")).toHaveLength(1);
  });
  it("only the one key is ever written", async () => {
    const h = boot(); const p = mkPort(); post(h, p, selSet("s", { all: "a" })); await settle();
    expect(new Set(h.store.writes.map((w) => w.key))).toEqual(new Set([SEL_KEY]));
  });
});
