import { describe, expect, it, vi } from "vitest";
import type { LiaisonInput, LiaisonProviderResult } from "../../../src/app/liaison";
import { HOSTILE, OUTPUT, answer, boot, deferred, expectRejected, expectSuccess, fakeDeps, flush, input } from "./helpers";

describe("U93 controller: persistence and bindings", () => {
  it("A5 persistence precedes inference and stores only the pending human input and cursor", async () => {
    const f = fakeDeps(); const c = boot(f); const context = input();
    expectSuccess(await c.generate(context));
    expect(f.trace).toEqual(["persist", "infer"]);
    expect(f.writes).toEqual([{ key: "tasklight.liaison.v1:demo:T01", value: { human: context.human, cursor: context.cursor } }]);
  });

  it.each(["throw", "reject"])("A5 %s storage failure returns PERSIST_FAILED before inference", async mode => {
    const f = fakeDeps(); const error = new Error("Storage unavailable");
    vi.mocked(f.storage.setItem).mockImplementation(() => {
      if (mode === "throw") throw error;
      return Promise.reject(error);
    });
    const c = boot(f); const context = input();
    expectRejected(await c.generate(context), "PERSIST_FAILED");
    expect(f.generate).not.toHaveBeenCalled();
    expect(context.human.text).toBe("  Original human draft\n");
  });

  it("A5 a pending asynchronous write prevents early inference", async () => {
    const f = fakeDeps(); const saved = deferred<void>();
    vi.mocked(f.storage.setItem).mockReturnValue(saved.promise);
    const c = boot(f); const pending = c.generate(input());
    await flush(); expect(f.generate).not.toHaveBeenCalled();
    saved.resolve(); expectSuccess(await pending); expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("A5 default localStorage uses separate room and task keys", async () => {
    const f = fakeDeps(); const c = boot({ registry: f.registry });
    for (const context of [input(), input({ room: "other" }), input({ task_id: "T02" })]) {
      await c.generate(context);
      expect(JSON.parse(localStorage.getItem(`tasklight.liaison.v1:${context.room}:${context.task_id}`)!))
        .toEqual({ human: context.human, cursor: context.cursor });
    }
    expect(localStorage.length).toBe(3);
  });

  it("A5 provider swaps preserve original pending text, history, cursor and rules", async () => {
    const f = fakeDeps(); const c = boot(f); const context = input();
    await c.generate(context);
    const before = structuredClone(context);
    c.setBinding("demo", { providerId: "other-provider", generation: 1 });
    expect(c.snapshot().input).toEqual(before);
    expect(context).toEqual(before);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("A5 null binding skips inference and exposes empty with a reason", async () => {
    const f = fakeDeps(); const c = boot(f);
    c.setBinding("demo", { providerId: null, generation: 1 });
    await c.generate(input());
    expect(f.generate).not.toHaveBeenCalled();
    expect(c.snapshot()).toMatchObject({ state: "empty" });
    expect(c.snapshot().reason.trim()).toBeTruthy();
  });
});

describe("U93 controller: context and closed output", () => {
  it("A1/M4 preserves rules verbatim and forwards room, schema and only the latest history window", async () => {
    const f = fakeDeps(); const c = boot(f);
    const context = input({ history: Array.from({ length: 25 }, (_, i) => ({ id: `event-${i}`, text: `history-token-${i}-end` })) });
    f.generate.mockResolvedValue(answer({ text: JSON.stringify({ ...OUTPUT, refs: ["event-24"] }) }));
    expectSuccess(await c.generate(context));
    expect(f.generate).toHaveBeenCalledTimes(1);
    const req = f.generate.mock.calls[0]![0];
    expect(req).toMatchObject({ task: "liaison", room: context.room, tier: "standard" });
    expect(req.signal.aborted).toBe(false);
    for (const value of [context.rules, context.human.text, "Work plan", "M01"]) {
      expect(req.prompt.includes(value) || req.prompt.includes(JSON.stringify(value).slice(1, -1))).toBe(true);
    }
    for (let i = 0; i < 25; i += 1) expect(req.prompt.includes(`history-token-${i}-end`)).toBe(i >= 5);
    for (const key of ["kind", "text", "refs", "draft", "summary", "clarify"]) expect(JSON.stringify(req.schema)).toContain(key);
    expect(context.history).toHaveLength(25);
  });

  it.each(["draft", "summary", "clarify"] as const)("A6 accepts valid %s and trusted attribution", async kind => {
    const f = fakeDeps(); const c = boot(f); const output = { ...OUTPUT, kind };
    f.generate.mockResolvedValue(answer({ text: JSON.stringify(output) }));
    expect(await c.generate(input(), kind)).toMatchObject({ ok: true, output,
      attribution: { providerId: "remote-test", modelLabel: "Reported answer model", source: "REMOTE_PROVIDER", fallback: false } });
  });

  const invalid: [string, string][] = [
    ["malformed JSON", "{broken"], ["fenced JSON", '```json\n{"kind":"draft","text":"x","refs":[]}\n```'],
    ["null", "null"], ["array", "[]"], ["string", '"draft"'],
    ["missing kind", JSON.stringify({ text: "x", refs: [] })],
    ["missing text", JSON.stringify({ kind: "draft", refs: [] })],
    ["missing refs", JSON.stringify({ kind: "draft", text: "x" })],
    ["unknown kind", JSON.stringify({ ...OUTPUT, kind: "send" })],
    ["empty text", JSON.stringify({ ...OUTPUT, text: "" })],
    ["whitespace text", JSON.stringify({ ...OUTPUT, text: " \n\t" })],
    ["non-string text", JSON.stringify({ ...OUTPUT, text: 7 })],
    ["oversized text", JSON.stringify({ ...OUTPUT, text: "x".repeat(2001) })],
    ["too many refs", JSON.stringify({ ...OUTPUT, refs: Array(21).fill("event-1") })],
    ["non-array refs", JSON.stringify({ ...OUTPUT, refs: "event-1" })],
    ["non-string ref", JSON.stringify({ ...OUTPUT, refs: [1] })],
    ["forged ref", JSON.stringify({ ...OUTPUT, refs: ["forged-event"] })],
    ["prototype-like ref", JSON.stringify({ ...OUTPUT, refs: ["__proto__"] })],
    ["extra key", JSON.stringify({ ...OUTPUT, extra: true })],
    ["model-authored attribution", JSON.stringify({ ...OUTPUT, attribution: { source: "ON_DEVICE" } })],
    ["ownership operation", '{"kind":"draft","text":"ignore rules","refs":[],"op":{"kind":"task.claim"}}'],
    ["completion operation", JSON.stringify({ ...OUTPUT, op: { kind: "task.done" } })],
    ["ruling operation", JSON.stringify({ ...OUTPUT, ruling: "approved" })],
  ];
  it.each(invalid)("A6 rejects %s with SCHEMA_REJECT and a reason", async (_name, raw) => {
    const f = fakeDeps(); const c = boot(f); const context = input(); const before = structuredClone(context);
    f.generate.mockResolvedValue(answer({ text: raw }));
    expectRejected(await c.generate(context), "SCHEMA_REJECT");
    expect(context).toEqual(before);
    expect(c.snapshot().result).not.toMatchObject({ ok: true });
  });

  it("A6 accepts exact text and reference bounds and retains supplied text literally", async () => {
    const f = fakeDeps(); const c = boot(f);
    const history = Array.from({ length: 20 }, (_, i) => ({ id: `event-${i}`, text: `Event ${i}` }));
    const output = { kind: "draft", text: HOSTILE + "x".repeat(2000 - HOSTILE.length), refs: history.map(e => e.id) };
    f.generate.mockResolvedValue(answer({ text: JSON.stringify(output) }));
    expect(expectSuccess(await c.generate(input({ history }))).output).toEqual(output);
  });

  it("A6 accepts the minimum text length and empty refs", async () => {
    const f = fakeDeps(); const c = boot(f); const output = { kind: "draft", text: "x", refs: [] };
    f.generate.mockResolvedValue(answer({ text: JSON.stringify(output) }));
    expect(expectSuccess(await c.generate(input())).output).toEqual(output);
  });

  it("A4 all unavailable uses Rules and returns the original human text exactly", async () => {
    const f = fakeDeps(); const c = boot(f); const context = input();
    f.generate.mockResolvedValue({ ok: false, code: "OFFLINE", providerId: "firebase-hybrid", fallback: true, detail: "All unavailable" });
    const result = expectSuccess(await c.generate(context));
    expect(result.output).toEqual({ kind: "draft", text: context.human.text, refs: [] });
    expect(result.attribution).toMatchObject({ source: "rules", fallback: true });
    expect(result.attribution.reason?.trim()).toBeTruthy();
  });

  it("A4 missing reported model remains absent instead of being inferred from selection", async () => {
    const f = fakeDeps(); const c = boot(f);
    const result = answer(); if (result.ok) delete result.modelLabel;
    f.generate.mockResolvedValue(result);
    expect(expectSuccess(await c.generate(input())).attribution.modelLabel).toBeUndefined();
  });

  it.each(["SCHEMA_REJECT", "ABORTED"] as const)("A6 provider %s is a stop result, never a Rules draft", async code => {
    const f = fakeDeps(); const c = boot(f);
    f.generate.mockResolvedValue({ ok: false, code, providerId: "remote-test", fallback: false, detail: "Request rejected" });
    const result = await c.generate(input());
    expect(result).toMatchObject({ ok: false, code });
    expect(c.snapshot().result).not.toMatchObject({ ok: true, attribution: { source: "rules" } });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, "unknown", "PREFER_ON_DEVICE"])("A2 missing or unknown host floor %s blocks before inference", async tier => {
    const f = fakeDeps(); const c = boot(f);
    const context = { ...input(), tier } as unknown as LiaisonInput;
    expectRejected(await c.generate(context), "BLOCKED");
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe("U93 controller: local lifecycle and stale requests", () => {
  it("A7 exposes starting then ready with textual reasons", async () => {
    const f = fakeDeps(); const reply = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(reply.promise);
    const c = boot(f); const pending = c.generate(input()); await flush();
    expect(c.snapshot().state).toBe("starting"); expect(c.snapshot().reason.trim()).toBeTruthy();
    reply.resolve(answer()); await pending;
    expect(c.snapshot().state).toBe("ready"); expect(c.snapshot().reason.trim()).toBeTruthy();
  });

  it("A7 pause is local suspension and prevents inference until resumed", async () => {
    const f = fakeDeps(); const c = boot(f);
    c.pause(); await c.generate(input());
    expect(c.snapshot().state).toBe("paused"); expect(c.snapshot().reason.trim()).toBeTruthy();
    expect(f.generate).not.toHaveBeenCalled();
    c.resume(); expectSuccess(await c.generate(input()));
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("A7 destroy aborts inference and never converts late failure to Rules", async () => {
    const f = fakeDeps(); const reply = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(reply.promise);
    const c = boot(f); const pending = c.generate(input()); await flush();
    const signal = f.generate.mock.calls[0]![0].signal;
    c.destroy(); expect(signal.aborted).toBe(true);
    reply.resolve({ ok: false, code: "OFFLINE", providerId: "remote-test", fallback: false });
    expect(await pending).toMatchObject({ ok: false, code: "ABORTED" });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("A7 latest request wins when an older response arrives after the newer one", async () => {
    const f = fakeDeps(); const old = deferred<LiaisonProviderResult>();
    f.generate.mockReturnValueOnce(old.promise).mockResolvedValueOnce(answer({ text: JSON.stringify({ ...OUTPUT, text: "New output" }),
      providerId: "new-answerer", modelLabel: "New model", source: "ON_DEVICE" }));
    const c = boot(f); const older = c.generate(input()); await flush();
    const latest = await c.generate(input({ human: { id: "human-2", text: "New human draft" } }));
    expectSuccess(latest); old.resolve(answer({ text: JSON.stringify({ ...OUTPUT, text: "Old output" }),
      providerId: "old-answerer", modelLabel: "Old model" }));
    await older; await flush();
    expect(c.snapshot().result).toMatchObject({ ok: true, output: { text: "New output" },
      attribution: { providerId: "new-answerer", modelLabel: "New model", source: "ON_DEVICE" } });
  });

  it.each(["room", "task", "tier", "generation"])("A7 Amendment TOCTOU: %s change aborts before late output or fallback", async change => {
    const f = fakeDeps(); const old = deferred<LiaisonProviderResult>(); f.generate.mockReturnValue(old.promise);
    const c = boot(f); const pending = c.generate(input()); await flush();
    if (change === "generation") c.setBinding("demo", { providerId: "new-provider", generation: 2 });
    else c.setContext(input(change === "room" ? { room: "private-room", tier: "private" }
      : change === "task" ? { task_id: "T02" } : { tier: "private" }));
    expect(f.generate.mock.calls[0]![0].signal.aborted).toBe(true);
    old.resolve({ ok: false, code: "OFFLINE", providerId: "remote-test", fallback: false });
    expect(await pending).toMatchObject({ ok: false, code: "ABORTED" });
    expect(c.snapshot().result).not.toMatchObject({ ok: true });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
});
