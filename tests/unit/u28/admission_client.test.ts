import { describe, it, expect } from "vitest";
import { ctxAdmission, createCtxClient, sha256Hex, canonicalJson, toLine, measure, CTX_LIMITS } from "../../../src/ctx";
import { handleWorkerMessage } from "../../../src/ctx/worker";
import { refEnv } from "./ref";

describe("C12 admission_map", () => {
  const adm = (rc: number) => ctxAdmission(refEnv("pack", rc, rc === 0 ? {} : { errors: [] }) as never);
  it("rc 0 -> RULES", () => { expect(adm(0)).toBe("RULES"); });
  it.each([4, 6, 2, 7, 124])("rc %i -> REFUSE_STALE", (rc) => { expect(adm(rc)).toBe("REFUSE_STALE"); });
});

function rig() {
  const posted: { id: unknown; verb: string; input: unknown }[] = [];
  let cb: (m: unknown) => void = () => undefined;
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const worker = { post: (m: unknown) => { posted.push(m as never); }, onMessage: (f: (m: unknown) => void) => { cb = f; } };
  const timer = { set: (ms: number, fn: () => void) => { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } };
  return { posted, timers, reply: (m: unknown) => cb(m), client: createCtxClient(worker, timer) };
}

describe("C13 timeout_124 and client protocol", () => {
  it("posts {id, verb, input} and arms a CTX_TIMEOUT_MS timer", () => {
    const r = rig(); void r.client.call("measure", { text: "x" });
    expect(r.posted).toHaveLength(1);
    expect(Object.keys(r.posted[0]!).sort()).toEqual(["id", "input", "verb"]);
    expect(r.posted[0]).toMatchObject({ verb: "measure", input: { text: "x" } });
    expect(r.timers.map((t) => t.ms)).toEqual([2000]); expect(CTX_LIMITS.CTX_TIMEOUT_MS).toBe(2000);
  });
  it("worker never replies: after 2000 ms -> rc 124 envelope; late reply ignored", async () => {
    const r = rig(); const p = r.client.call("pack", { excerpts: [], maxChars: 5 });
    r.timers[0]!.fn();
    const e = await p;
    expect(e.rc).toBe(124); expect(e.ok).toBe(false); expect(e.verb).toBe("pack"); expect(e.schema).toBe("ctx.resp/v1");
    expect(e.data).toEqual({ errors: [] });
    expect(e.sha256).toBe(sha256Hex(canonicalJson({ errors: [] })));
    const id = (r.posted[0] as { id: unknown }).id;
    expect(() => r.reply({ id, line: toLine(measure({ text: "late" })) })).not.toThrow();
    expect(await p).toBe(e);
    const p2 = r.client.call("measure", { text: "ok" });
    const id2 = (r.posted[1] as { id: unknown }).id;
    expect(id2).not.toBe(id);
    r.reply({ id: id2, line: toLine(measure({ text: "ok" })) });
    expect((await p2).rc).toBe(0);
  });
  it("normal reply resolves to the parsed envelope and cancels the timer", async () => {
    const r = rig(); const p = r.client.call("measure", { text: "ab" });
    const id = (r.posted[0] as { id: unknown }).id;
    const line = toLine(measure({ text: "ab" }));
    r.reply({ id: "unknown-id", line: "{}" });
    r.reply({ id, line });
    expect(toLine(await p)).toBe(line); expect(r.timers[0]!.cancelled).toBe(true);
  });
  it("two concurrent calls get distinct ids and route correctly", async () => {
    const r = rig(); const a = r.client.call("measure", { text: "a" }); const b = r.client.call("measure", { text: "bb" });
    const [ia, ib] = r.posted.map((m) => (m as { id: unknown }).id); expect(ia).not.toBe(ib);
    r.reply({ id: ib, line: toLine(measure({ text: "bb" })) }); r.reply({ id: ia, line: toLine(measure({ text: "a" })) });
    expect(((await a).data as { utf16: number }).utf16).toBe(1); expect(((await b).data as { utf16: number }).utf16).toBe(2);
  });
});

describe("worker handler", () => {
  it("{id,verb,input} -> {id,line} with line === toLine(verb(input))", () => {
    const o = handleWorkerMessage({ id: "z", verb: "measure", input: { text: "a😀é" } });
    expect(o).toEqual({ id: "z", line: toLine(measure({ text: "a😀é" })) });
    expect(JSON.parse(o.line).data.utf16).toBe(4);
  });
  it("unknown verb does not throw and is not ok", () => {
    const o = handleWorkerMessage({ id: 1, verb: "bogus", input: {} });
    expect(JSON.parse(o.line).ok).toBe(false);
  });
});
