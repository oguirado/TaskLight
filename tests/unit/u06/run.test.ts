import { afterEach, describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import type { AiConfig } from "../../../src/ai/types";
import { CLOUD, makeFake, ON, OK_ORIGIN, PNG, req, TASKS, type Fake, type Reply, type T } from "./harness";
import { validateTaskOutput, VALID } from "./schemaMock";

vi.mock("../../../src/schema", () => import("./schemaMock"));

const setup = async (config: Partial<AiConfig> = {}, opts: { init?: boolean } = {}) => {
  const fake = makeFake();
  const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true, config });
  if (opts.init) await h.initDevice();
  return { fake, h };
};
const only = (fake: Fake, r: Reply | ((t: T) => Reply)) => { fake.reply = (t) => (typeof r === "function" ? r(t) : r); };
afterEach(() => { vi.restoreAllMocks(); validateTaskOutput.mockClear(); });

describe("source and fallback (O3, B14, B15)", () => {
  it("O3 PREFER_ON_DEVICE: ON_DEVICE source -> ok, fallback false; IN_CLOUD -> ok, fallback true", async () => {
    const { fake, h } = await setup({}, { init: true });
    only(fake, { text: VALID["summary"]!, inferenceSource: ON });
    const a = await h.run(req("summary"));
    expect(a.ok && a.source).toBe("ON_DEVICE");
    expect(a.ok && a.fallback).toBe(false);
    only(fake, { text: VALID["summary"]!, inferenceSource: CLOUD });
    const b = await h.run(req("summary"));
    expect(b.ok && b.source).toBe("IN_CLOUD");
    expect(b.ok && b.fallback).toBe(true);
    if (b.ok) expect(b.value).toEqual({ headline: "h", summary: "s" });
  });

  it("B15 fallback matrix over every mode and source", async () => {
    const cases: Array<[AiConfig["mode_summary"], unknown, string, boolean]> = [
      ["PREFER_ON_DEVICE", ON, "ON_DEVICE", false], ["PREFER_ON_DEVICE", CLOUD, "IN_CLOUD", true],
      ["PREFER_IN_CLOUD", CLOUD, "IN_CLOUD", false], ["PREFER_IN_CLOUD", ON, "ON_DEVICE", true],
      ["ONLY_IN_CLOUD", CLOUD, "IN_CLOUD", false], ["ONLY_ON_DEVICE", ON, "ON_DEVICE", false],
    ];
    for (const [mode, src, expSrc, expFb] of cases) {
      const { fake, h } = await setup({ mode_summary: mode }, { init: true });
      only(fake, { text: VALID["summary"]!, inferenceSource: src });
      const r = await h.run(req("summary"));
      expect(r.ok, `${mode}/${expSrc}`).toBe(true);
      if (r.ok) { expect(r.source).toBe(expSrc); expect(r.fallback).toBe(expFb); }
    }
  });

  it("O4 unknown source (lowercase string, undefined, missing, wrong object) -> BAD_SOURCE, no value, no source", async () => {
    for (const bad of ["on_device", "ON_DEVICE", undefined, null, {}, { sentinel: "ON_DEVICE" }]) {
      const { fake, h } = await setup({}, { init: true });
      only(fake, { text: VALID["summary"]!, inferenceSource: bad });
      const r = await h.run(req("summary"));
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.code).toBe("BAD_SOURCE"); expect(r.source).toBeUndefined(); expect("value" in r).toBe(false); }
    }
    const { fake, h } = await setup({}, { init: true });
    fake.reply = () => ({ text: VALID["summary"]! }); // property absent altogether
    const r = await h.run(req("summary"));
    expect(!r.ok && r.code).toBe("BAD_SOURCE");
  });

  it("the source is never guessed: BAD_SOURCE also for a value that equals neither constant under every mode", async () => {
    for (const mode of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as const) {
      const { fake, h } = await setup({ mode_digest: mode }, { init: true });
      only(fake, { text: VALID["digest"]!, inferenceSource: "in_cloud" });
      const r = await h.run(req("digest"));
      expect(!r.ok && r.code).toBe("BAD_SOURCE");
    }
  });

  it("source is surfaced on every successful result for all five tasks", async () => {
    const { h } = await setup({ mode_screenshot: "ONLY_ON_DEVICE" }, { init: true });
    for (const t of TASKS) {
      const r = await h.run(t === "screenshot" ? req(t, { image: PNG }) : req(t));
      expect(r.ok, t).toBe(true);
      if (r.ok) expect(r.source).toBe(t === "digest" ? "IN_CLOUD" : "ON_DEVICE");
    }
  });
});

describe("output checks (O5, O8, B16, B17)", () => {
  it("O5 off-schema output is rejected via the U05 validator with UNKNOWN_FIELD at html, no value", async () => {
    const { fake, h } = await setup({}, { init: true });
    only(fake, { text: JSON.stringify({ headline: "h", summary: "s", html: "<b>x</b>" }), inferenceSource: ON });
    const r = await h.run(req("summary"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SCHEMA_REJECT");
      expect(r.rejects).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_FIELD", path: "html" })]));
      expect("value" in r).toBe(false);
      expect(r.source).toBe("ON_DEVICE");
    }
  });

  it("B17 delegates to validateTaskOutput(task, text, ctx) exactly once with the ctx given", async () => {
    const { fake, h } = await setup({}, { init: true });
    only(fake, { text: VALID["digest"]!, inferenceSource: CLOUD });
    const ctx = { knownProjectIds: new Set(["p1"]) };
    await h.run(req("digest", { ctx }));
    expect(validateTaskOutput).toHaveBeenCalledTimes(1);
    const args = validateTaskOutput.mock.calls[0]!;
    expect(args[0]).toBe("digest");
    expect(args[1]).toBe(VALID["digest"]);
    expect(args[2]).toBe(ctx);
  });

  it("B17 unparsable and wrong-shaped text for every task is rejected, never returned as ok", async () => {
    for (const t of TASKS) {
      const { fake, h } = await setup({}, { init: true });
      only(fake, { text: "not json {{", inferenceSource: ON });
      const r = await h.run(t === "screenshot" ? req(t, { image: PNG }) : req(t));
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.code).toBe("SCHEMA_REJECT");
    }
  });

  it("B17 a throw from text() is SDK_ERROR and run does not reject", async () => {
    const { fake, h } = await setup({}, { init: true });
    only(fake, { text: () => { throw new Error("blocked"); }, inferenceSource: ON });
    const r = await h.run(req("summary"));
    expect(!r.ok && r.code).toBe("SDK_ERROR");
  });

  it("O8 private tier: resolved ONLY_ON_DEVICE; IN_CLOUD source -> PRIVACY_VIOLATION, no value", async () => {
    const { fake, h } = await setup({}, { init: true });
    only(fake, { text: VALID["summary"]!, inferenceSource: CLOUD });
    const r = await h.run(req("summary", { tier: "private" }));
    expect(r.meta.mode).toBe("ONLY_ON_DEVICE");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("PRIVACY_VIOLATION"); expect("value" in r).toBe(false); expect(r.source).toBe("IN_CLOUD"); }
    // and the model that served it was the one built with the ONLY_ON_DEVICE mode
    expect(fake.calls).toHaveLength(1);
  });

  it("B16 is checked before validation: invalid text + IN_CLOUD under ONLY_ON_DEVICE -> PRIVACY_VIOLATION, validator never called", async () => {
    const { fake, h } = await setup({ mode_summary: "ONLY_ON_DEVICE" }, { init: true });
    only(fake, { text: "garbage", inferenceSource: CLOUD });
    const r = await h.run(req("summary"));
    expect(!r.ok && r.code).toBe("PRIVACY_VIOLATION");
    expect(validateTaskOutput).not.toHaveBeenCalled();
  });

  it("B6/B7/B8 each force ONLY_ON_DEVICE so an IN_CLOUD answer is a privacy violation (screenshot, kill switch)", async () => {
    for (const [cfg, r] of [[{}, req("screenshot", { image: PNG })], [{ kill_switch_cloud: true, mode_digest: "PREFER_IN_CLOUD" as const }, req("digest")]] as const) {
      const { fake, h } = await setup(cfg, { init: true });
      only(fake, { text: VALID[r.task]!, inferenceSource: CLOUD });
      const res = await h.run(r);
      expect(res.meta.mode).toBe("ONLY_ON_DEVICE");
      expect(!res.ok && res.code).toBe("PRIVACY_VIOLATION");
    }
  });
});

describe("pre-call checks (O7, O10, O12, B9-B11, B13)", () => {
  it("O7 screenshot pinned ONLY_ON_DEVICE despite mode_screenshot=PREFER_IN_CLOUD; webp -> INPUT_REJECTED, called false, 0 calls", async () => {
    const { fake, h } = await setup({ mode_screenshot: "PREFER_IN_CLOUD" }, { init: true });
    const bad = await h.run(req("screenshot", { image: { mimeType: "image/webp", data: "AAAA" } }));
    expect(!bad.ok && bad.code).toBe("INPUT_REJECTED");
    expect(bad.meta.called).toBe(false);
    expect(fake.calls).toHaveLength(0);
    const ok = await h.run(req("screenshot", { image: PNG }));
    expect(ok.meta.mode).toBe("ONLY_ON_DEVICE");
    expect(ok.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("B10 image rules: jpeg ok; image on a non-screenshot task, screenshot without image, odd mime -> INPUT_REJECTED with 0 calls", async () => {
    const { fake, h } = await setup({}, { init: true });
    const jpeg = await h.run(req("screenshot", { image: { mimeType: "image/jpeg", data: "AAAA" } }));
    expect(jpeg.ok).toBe(true);
    fake.calls.length = 0;
    const results = [
      await h.run(req("summary", { image: PNG })),
      await h.run(req("screenshot")),
      await h.run(req("screenshot", { image: { mimeType: "image/gif", data: "AAAA" } })),
      await h.run(req("screenshot", { image: { mimeType: "IMAGE/PNG", data: "AAAA" } })),
      await h.run(req("status", { image: PNG })),
    ];
    for (const r of results) { expect(!r.ok && r.code).toBe("INPUT_REJECTED"); expect(r.meta.called).toBe(false); }
    expect(fake.calls).toHaveLength(0);
  });

  it("O10 ONLY_ON_DEVICE before initDevice -> DEVICE_NOT_INITIALISED with 0 calls; after initDevice 1 call and ready", async () => {
    const { fake, h } = await setup({ mode_status: "ONLY_ON_DEVICE" });
    const r = await h.run(req("status"));
    expect(!r.ok && r.code).toBe("DEVICE_NOT_INITIALISED");
    expect(r.meta.called).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fake.handles.every((x) => x.inits === 0)).toBe(true);
    const st = await h.initDevice();
    expect(st).toEqual({ state: "ready" });
    expect(h.deviceStatus()).toEqual({ state: "ready" });
    const r2 = await h.run(req("status"));
    expect(r2.ok).toBe(true);
    expect(r2.meta.called).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("B11 screenshot and private tier also yield DEVICE_NOT_INITIALISED before init", async () => {
    const { fake, h } = await setup();
    const a = await h.run(req("screenshot", { image: PNG }));
    const b = await h.run(req("summary", { tier: "private" }));
    expect(!a.ok && a.code).toBe("DEVICE_NOT_INITIALISED");
    expect(!b.ok && b.code).toBe("DEVICE_NOT_INITIALISED");
    expect(fake.calls).toHaveLength(0);
  });

  it("B11 PREFER_* modes do not wait for the device: they call the SDK even before initDevice", async () => {
    const { fake, h } = await setup();
    const r = await h.run(req("summary"));
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("O12 prompt of 7301 chars -> INPUT_OVER_BUDGET with 0 calls; 7300 -> exactly 1 call", async () => {
    const { fake, h } = await setup({}, { init: true });
    const over = await h.run(req("summary", { prompt: "x".repeat(7301) }));
    expect(!over.ok && over.code).toBe("INPUT_OVER_BUDGET");
    expect(over.meta.called).toBe(false);
    expect(fake.calls).toHaveLength(0);
    const edge = await h.run(req("summary", { prompt: "x".repeat(7300) }));
    expect(edge.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("B9 budget applies to cloud modes too and follows ondevice_max_input_tokens", async () => {
    const { fake, h } = await setup({ mode_summary: "ONLY_IN_CLOUD", ondevice_max_input_tokens: 10 }, { init: true });
    const a = await h.run(req("summary", { prompt: "y".repeat(11) }));
    expect(!a.ok && a.code).toBe("INPUT_OVER_BUDGET");
    const b = await h.run(req("summary", { prompt: "y".repeat(10) }));
    expect(b.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("B13 call shape: text-only is generateContent(prompt) on the task's own handle; screenshot is [prompt, inlineData]", async () => {
    const { fake, h } = await setup({}, { init: true });
    await h.run(req("summary", { prompt: "hello" }));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.req).toBe("hello");
    expect(fake.calls[0]!.handle).toBe(fake.last("summary"));
    await h.run(req("screenshot", { prompt: "look", image: { mimeType: "image/png", data: "QUJD" } }));
    expect(fake.calls[1]!.req).toEqual(["look", { inlineData: { data: "QUJD", mimeType: "image/png" } }]);
    expect(fake.calls[1]!.handle).toBe(fake.last("screenshot"));
    expect(fake.calls[1]!.handle.params.inCloudParams.generationConfig.responseMimeType).toBe("application/json");
  });

  it("B13 exactly one generateContent per run, only on the module's injected handles (sole caller)", async () => {
    const { fake, h } = await setup({}, { init: true });
    for (const t of TASKS) await h.run(t === "screenshot" ? req(t, { image: PNG }) : req(t));
    expect(fake.calls).toHaveLength(5);
    expect(fake.handles).toHaveLength(5);
    expect(fake.handles.map((x) => x.calls.length)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("error classification and never-reject (O11, B18)", () => {
  it("O11 ONLY_ON_DEVICE throw -> ON_DEVICE_UNAVAILABLE; ONLY_IN_CLOUD PERMISSION_DENIED -> APP_CHECK_REJECTED; never rejects", async () => {
    const a = await setup({ mode_status: "ONLY_ON_DEVICE" }, { init: true });
    only(a.fake, { throws: new Error("x") });
    const ra = await a.h.run(req("status"));
    expect(!ra.ok && ra.code).toBe("ON_DEVICE_UNAVAILABLE");
    const b = await setup({ mode_status: "ONLY_IN_CLOUD" }, { init: true });
    only(b.fake, { throws: new Error("403 PERMISSION_DENIED") });
    const rb = await b.h.run(req("status"));
    expect(!rb.ok && rb.code).toBe("APP_CHECK_REJECTED");
    await expect(b.h.run(req("status"))).resolves.toBeDefined();
  });

  it("B18 full table: PERMISSION_DENIED wins in every mode; ONLY_IN_CLOUD -> CLOUD_UNAVAILABLE; PREFER_* -> SDK_ERROR", async () => {
    for (const mode of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD", "ONLY_ON_DEVICE"] as const) {
      const { fake, h } = await setup({ mode_summary: mode }, { init: true });
      only(fake, { throws: new Error("PERMISSION_DENIED: App Check") });
      const r = await h.run(req("summary"));
      expect(!r.ok && r.code, mode).toBe("APP_CHECK_REJECTED");
    }
    const exp = { PREFER_ON_DEVICE: "SDK_ERROR", PREFER_IN_CLOUD: "SDK_ERROR", ONLY_IN_CLOUD: "CLOUD_UNAVAILABLE", ONLY_ON_DEVICE: "ON_DEVICE_UNAVAILABLE" } as const;
    for (const mode of Object.keys(exp) as Array<keyof typeof exp>) {
      const { fake, h } = await setup({ mode_summary: mode }, { init: true });
      only(fake, { throws: new Error("boom") });
      const r = await h.run(req("summary"));
      expect(!r.ok && r.code, mode).toBe(exp[mode]);
      expect(r.meta.called).toBe(true);
    }
  });

  it("non-Error throws (string, undefined, object) are classified, not propagated", async () => {
    for (const thrown of ["PERMISSION_DENIED", undefined, { message: "PERMISSION_DENIED" }, 42]) {
      const { fake, h } = await setup({ mode_summary: "ONLY_IN_CLOUD" }, { init: true });
      only(fake, { throws: thrown });
      const r = await h.run(req("summary"));
      expect(r.ok).toBe(false);
    }
  });

  it("run never rejects when the SDK throws synchronously from generateContent", async () => {
    const { fake, h } = await setup({}, { init: true });
    for (const hd of fake.handles) hd.generateContent = (() => { throw new Error("sync"); }) as never;
    await expect(h.run(req("summary"))).resolves.toMatchObject({ ok: false, code: "SDK_ERROR" });
  });

  it("B18 kill switch on with a task whose default is ONLY_IN_CLOUD: detail notes CLOUD_DISABLED when the call fails", async () => {
    const { fake, h } = await setup({ kill_switch_cloud: true, mode_summary: "ONLY_IN_CLOUD" }, { init: true });
    only(fake, { throws: new Error("x") });
    const r = await h.run(req("summary"));
    expect(r.meta.mode).toBe("ONLY_ON_DEVICE");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail ?? "").toContain("CLOUD_DISABLED");
  });
});

describe("meta and side effects (B19)", () => {
  it("meta reports task, resolved mode, configGen, prompt_version and called", async () => {
    const { h } = await setup({ prompt_version: "v9" }, { init: true });
    const r = await h.run(req("digest"));
    expect(r.meta).toEqual({ task: "digest", mode: "PREFER_IN_CLOUD", configGen: 0, prompt_version: "v9", called: true });
  });

  it("B19 no logging, no clock reads, no DOM mutation while running (ok, reject, and error paths)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const now = vi.spyOn(Date, "now");
    const perf = vi.spyOn(performance, "now");
    const body = document.body.innerHTML;
    const { fake, h } = await setup({}, { init: true });
    await h.run(req("summary", { prompt: "SECRET-PROMPT" }));
    only(fake, { text: "SECRET-OUTPUT", inferenceSource: ON });
    await h.run(req("summary", { prompt: "SECRET-PROMPT" }));
    only(fake, { throws: new Error("boom SECRET-PROMPT") });
    await h.run(req("summary", { prompt: "SECRET-PROMPT" }));
    expect(fake.calls).toHaveLength(3);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(perf).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe(body);
  });

  it("run does not mutate the request", async () => {
    const { h } = await setup({}, { init: true });
    const r = Object.freeze({ ...req("summary"), ctx: Object.freeze({ knownProjectIds: new Set(["a"]) }) });
    await expect(h.run(r)).resolves.toMatchObject({ ok: true });
    expect(validateTaskOutput).toHaveBeenCalledTimes(1);
  });
});

describe("privacy gap (spec B3 vs B7/B16) [see ORACLE.md, advisory]", () => {
  it("a private-tier request is served by an instance built with mode ONLY_ON_DEVICE, so the prompt can never reach the cloud", async () => {
    const { fake, h } = await setup({}, { init: true });
    await h.run(req("summary", { tier: "private" }));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.handle.params.mode).toBe(fake.modeConst("ONLY_ON_DEVICE"));
  });
});
