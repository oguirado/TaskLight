import { describe, it, expect } from "vitest";
import { ctxAdmission, createCtxClient, pack, rank, check, toLine, measure, sha256Hex, canonicalJson } from "../../../src/ctx";
import { refEnv } from "./ref";

const sparse = (len: number): unknown[] => { const a: unknown[] = []; a[len] = 1; return a; };
function timed<T>(f: () => T): { r: T; ms: number } { const t = Date.now(); const r = f(); return { r, ms: Date.now() - t }; }

describe("repair1 B1/B4/B17: sparse / oversized arrays are rejected in bounded time", () => {
  it("pack excerpts sparse length 5e6 -> rc 2 fast, no throw", () => {
    const { r, ms } = timed(() => pack({ excerpts: sparse(5e6), maxChars: 100 }));
    expect(r.rc).toBe(2); expect(r.ok).toBe(false); expect(ms).toBeLessThan(500);
  });
  it("rank excerpts sparse -> rc 2 fast", () => {
    const { r, ms } = timed(() => rank({ excerpts: sparse(5e6), terms: ["a"] }));
    expect(r.rc).toBe(2); expect(ms).toBeLessThan(500);
  });
  it("rank terms sparse -> rc 2 fast", () => {
    const { r, ms } = timed(() => rank({ excerpts: [], terms: sparse(5e6) }));
    expect(r.rc).toBe(2); expect(ms).toBeLessThan(500);
  });
  it("check pack.in with sparse excerpts -> rc 2 fast", () => {
    const { r, ms } = timed(() => check({ kind: "pack.in", value: { excerpts: sparse(5e6), maxChars: 100 } }));
    expect(r.rc).toBe(2); expect(ms).toBeLessThan(500);
  });
  it("check envelope with sparse array deep in data -> not ok, fast", () => {
    const { r, ms } = timed(() => check({ kind: "envelope", value: { schema: "ctx.resp/v1", ok: false, rc: 2, verb: "pack", data: { errors: sparse(5e6) }, sha256: "0".repeat(64) } }));
    expect(r.rc).not.toBe(0); expect(ms).toBeLessThan(500);
  });
});

function rig(opts: { postThrows?: boolean } = {}) {
  const posted: { id: unknown }[] = [];
  let cb: (m: unknown) => void = () => undefined;
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const worker = {
    post: (m: unknown) => { if (opts.postThrows) throw new Error("DataCloneError"); posted.push(m as never); },
    onMessage: (f: (m: unknown) => void) => { cb = f; },
  };
  const timer = { set: (ms: number, fn: () => void) => { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } };
  return { posted, timers, reply: (m: unknown) => cb(m), client: createCtxClient(worker, timer) };
}

describe("repair1 B1/B18/B19: client is total", () => {
  it("synchronous post() throw resolves to a sealed rc 2 envelope, cancels timer, fail-closed admission", async () => {
    const r = rig({ postThrows: true });
    const e = await r.client.call("densify", { text: "x" });
    expect(e.rc).toBe(2); expect(e.ok).toBe(false); expect(e.verb).toBe("densify"); expect(e.schema).toBe("ctx.resp/v1");
    expect(Array.isArray((e.data as { errors: unknown[] }).errors)).toBe(true);
    expect(e.sha256).toBe(sha256Hex(canonicalJson(e.data)));
    expect(r.timers.every((t) => t.cancelled)).toBe(true);
    expect(ctxAdmission(e)).toBe("REFUSE_STALE");
  });
  it("post() throw does not break later calls", async () => {
    let fail = true; const posted: { id: unknown }[] = []; let cb: (m: unknown) => void = () => undefined;
    const client = createCtxClient({ post: (m) => { if (fail) throw new Error("x"); posted.push(m as never); }, onMessage: (f) => { cb = f; } },
      { set: () => () => undefined });
    expect((await client.call("measure", { text: "a" })).rc).toBe(2);
    fail = false; const p = client.call("measure", { text: "a" });
    cb({ id: posted[0]!.id, line: toLine(measure({ text: "a" })) });
    expect((await p).rc).toBe(0);
  });
  it.each(["null", "[]", "42", "\"s\"", "{}", "{\"rc\":0}"])("malformed worker reply line %s never yields RULES or throws", async (line) => {
    const r = rig(); const p = r.client.call("measure", { text: "ab" });
    const id = (r.posted[0] as { id: unknown }).id;
    expect(() => r.reply({ id, line })).not.toThrow();
    if (!r.timers[0]!.cancelled) r.timers[0]!.fn(); // dropped replies fall back to the timeout path
    const e = await p;
    let adm: string | undefined;
    expect(() => { adm = ctxAdmission(e); }).not.toThrow();
    expect(adm).toBe("REFUSE_STALE");
  });
  it("reply with rc 0 envelope but wrong sha256 is not admitted as RULES", async () => {
    const r = rig(); const p = r.client.call("measure", { text: "ab" });
    const id = (r.posted[0] as { id: unknown }).id;
    const env = { ...refEnv("measure", 0, { utf16: 2, tokens: null, tokens_source: "absent" }), sha256: "0".repeat(64) };
    r.reply({ id, line: JSON.stringify(env) });
    if (!r.timers[0]!.cancelled) r.timers[0]!.fn();
    expect(ctxAdmission(await p)).toBe("REFUSE_STALE");
  });
});
