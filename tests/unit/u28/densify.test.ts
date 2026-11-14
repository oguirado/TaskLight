import { describe, it, expect } from "vitest";
import { densify, toLine } from "../../../src/ctx";
import { errs, fixIn, fixOut } from "./ref";

const d = (text: string) => densify({ text }).data as { text: string; chars_in: number; chars_out: number;
  ansi_removed: number; blank_removed: number; repeats_removed: number };

describe("C2 densify_rules", () => {
  const input = "\x1b[31mERR\x1b[0m\r\n\n\n\nx\nx\nx\n";
  it("removes ANSI, blank runs, repeated lines", () => {
    const o = d(input);
    expect(o.text).toBe("ERR\n\nx\n");
    expect(o.ansi_removed).toBe(2);
    expect(o.repeats_removed).toBe(2);
    expect(o.blank_removed).toBe(2); // ASSUMPTION: counts lines removed (see ORACLE.md)
    expect(o.chars_in).toBe(input.length);
    expect(o.chars_out).toBe(7);
  });
  it("second pass removes zero in every category", () => {
    const o = d(d(input).text);
    expect([o.ansi_removed, o.blank_removed, o.repeats_removed]).toEqual([0, 0, 0]);
    expect(o.text).toBe("ERR\n\nx\n");
  });
  it("matches golden densify_01", () => {
    expect(toLine(densify(fixIn("densify_01")))).toBe(fixOut("densify_01"));
  });
});

describe("B6 steps", () => {
  it("CRLF -> LF", () => { expect(d("a\r\nb").text).toBe("a\nb"); });
  it("OSC terminated by BEL and by ESC backslash", () => {
    expect(d("a\x1b]0;title\x07b").text).toBe("ab");
    expect(d("a\x1b]8;;http://x\x1b\\b").text).toBe("ab");
    expect(d("a\x1b]0;t\x07b\x1b[2Kc").ansi_removed).toBe(2);
  });
  it("CSI with params and final in @-~", () => {
    expect(d("\x1b[1;32;40mG\x1b[0m\x1b[2J").text).toBe("G");
  });
  it("whitespace-only lines collapse like blank lines into one empty line", () => {
    expect(d("a\n  \n\t\n\nb").text).toBe("a\n\nb");
  });
  it("non-consecutive duplicates are kept", () => {
    expect(d("a\nb\na\nb").text).toBe("a\nb\na\nb");
  });
  it("is deterministic across runs", () => {
    const i = "\x1b[0mz\n\n\nz\nz\r\n";
    expect(toLine(densify({ text: i }))).toBe(toLine(densify({ text: i })));
  });
  it("idempotent on noisy input", () => {
    const noisy = "\x1b[1mA\x1b[0m\n\n\n \n\nA\nA\n\x1b]0;t\x07B\nB\n\n\n";
    const o = d(d(noisy).text);
    expect([o.ansi_removed, o.blank_removed, o.repeats_removed]).toEqual([0, 0, 0]);
  });
});

describe("B5 size cap", () => {
  it("65536 chars accepted (control)", () => { expect(densify({ text: "a".repeat(65536) }).rc).toBe(0); });
  it("65537 chars -> rc 2", () => { expect(densify({ text: "a".repeat(65537) }).rc).toBe(2); });
  it("bad shapes -> rc 2 with sorted errors, path never echoes text", () => {
    const secret = "SECRET-TOKEN-123";
    const r = densify({ text: secret, [secret]: 1 });
    expect(r.rc).toBe(2);
    expect(errs(r).some((e) => e.code === "UNKNOWN_FIELD")).toBe(true);
    expect(JSON.stringify(errs(r).map((e) => e.path))).not.toContain("text\":\"" + secret);
    expect(densify({ text: 5 }).rc).toBe(2);
    expect(errs(densify({ text: 5 }))[0]?.code).toBe("WRONG_TYPE");
    expect(errs(densify({}))[0]).toEqual({ code: "MISSING_FIELD", path: "text" });
    const wrong = errs(densify({ text: 12345 }));
    expect(wrong.every((e) => !e.path.includes("12345"))).toBe(true);
  });
});
