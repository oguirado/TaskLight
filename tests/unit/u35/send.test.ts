import { afterEach, describe, expect, it } from "vitest";
import { cleanup, click, counter, input, key, mount, mountSpied, sendBtn, submitForm, txt, type, utf8 } from "./helpers";
import { FIXTURE } from "./fixture";

afterEach(cleanup);

const LIMIT = 4096;

describe("U35 C3 send enablement", () => {
  it("disabled initially (empty)", () => {
    const { host } = mount();
    expect(sendBtn(host).disabled).toBe(true);
  });

  it.each([[" "], ["   \n\t "], ["\n"]])("whitespace-only %j keeps send disabled", (v) => {
    const { host } = mount();
    type(host, v);
    expect(sendBtn(host).disabled).toBe(true);
  });

  it("enabled for non-empty text, disabled again when cleared", () => {
    const { host } = mount();
    type(host, "hello");
    expect(sendBtn(host).disabled).toBe(false);
    type(host, "");
    expect(sendBtn(host).disabled).toBe(true);
  });

  it("enabled for text with surrounding whitespace", () => {
    const { host } = mount();
    type(host, "  hi  ");
    expect(sendBtn(host).disabled).toBe(false);
  });

  it("disabled while vm.sending is true even with text; re-enabled by update(sending:false) (draft kept)", () => {
    const { host, handle } = mount();
    type(host, "hello");
    handle.update({ ...FIXTURE, sending: true });
    expect(sendBtn(host).disabled).toBe(true);
    expect(input(host).value).toBe("hello");
    handle.update({ ...FIXTURE, sending: false });
    expect(sendBtn(host).disabled).toBe(false);
  });

  it("mounted with sending:true: typing does not enable send", () => {
    const { host } = mount({ ...FIXTURE, sending: true });
    type(host, "hello");
    expect(sendBtn(host).disabled).toBe(true);
  });

  const cases: [string, string, number, boolean][] = [
    ["ASCII exactly 4096 bytes", "a".repeat(LIMIT), LIMIT, true],
    ["ASCII 4097 bytes", "a".repeat(LIMIT + 1), LIMIT + 1, false],
    ["e-acute x2048 = 4096 bytes (2048 chars)", "é".repeat(2048), 4096, true],
    ["e-acute x2049 = 4098 bytes (only 2049 chars)", "é".repeat(2049), 4098, false],
    ["a + e-acute x2047 + a = 4096 bytes", "a" + "é".repeat(2047) + "a", 4096, true],
    ["a + e-acute x2048 = 4097 bytes", "a" + "é".repeat(2048), 4097, false],
    ["emoji x1024 = 4096 bytes (1024 code points, 2048 UTF-16 units)", "\u{1F600}".repeat(1024), 4096, true],
    ["emoji x1025 = 4100 bytes", "\u{1F600}".repeat(1025), 4100, false],
    ["emoji x1023 + 'abcd' = 4096 bytes", "\u{1F600}".repeat(1023) + "abcd", 4096, true],
    ["emoji x1023 + 'abcde' = 4097 bytes", "\u{1F600}".repeat(1023) + "abcde", 4097, false],
    ["CJK x1365 = 4095 bytes", "中".repeat(1365), 4095, true],
    ["CJK x1366 = 4098 bytes", "中".repeat(1366), 4098, false],
  ];
  it.each(cases)("%s", (_n, text, bytes, ok) => {
    expect(utf8(text)).toBe(bytes); // oracle self-check
    const { host } = mount();
    type(host, text);
    expect(sendBtn(host).disabled).toBe(!ok);
    expect(txt(counter(host))).toBe(`${bytes} / ${LIMIT}`);
    expect(counter(host).hasAttribute("data-over")).toBe(!ok);
  });

  it("limit applies to the trimmed text: 4096 bytes plus surrounding whitespace is still sendable", () => {
    const { host, spies } = mountSpied();
    type(host, "  " + "a".repeat(LIMIT) + "\n\n");
    expect(sendBtn(host).disabled).toBe(false);
    click(sendBtn(host));
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(spies.onSend).toHaveBeenCalledWith("a".repeat(LIMIT));
  });

  it("counter counts UTF-8 bytes of a short multi-byte string", () => {
    const { host } = mount();
    type(host, "héllo \u{1F600}");
    expect(txt(counter(host))).toBe(`${utf8("héllo \u{1F600}")} / 4096`);
    expect(utf8("héllo \u{1F600}")).toBe(11);
  });

  it("data-over is removed when the text shrinks back under the limit", () => {
    const { host } = mount();
    type(host, "a".repeat(LIMIT + 5));
    expect(counter(host).hasAttribute("data-over")).toBe(true);
    type(host, "a".repeat(10));
    expect(counter(host).hasAttribute("data-over")).toBe(false);
    expect(txt(counter(host))).toBe("10 / 4096");
  });

  it("counter and over state survive update()", () => {
    const { host, handle } = mount();
    type(host, "a".repeat(LIMIT + 1));
    handle.update({ ...FIXTURE });
    expect(txt(counter(host))).toBe("4097 / 4096");
    expect(counter(host).hasAttribute("data-over")).toBe(true);
    expect(sendBtn(host).disabled).toBe(true);
  });
});

describe("U35 C3 submit", () => {
  it("button click calls onSend once with the trimmed text, then clears the textarea", () => {
    const { host, spies } = mountSpied();
    type(host, "  hello world \n");
    click(sendBtn(host));
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(spies.onSend).toHaveBeenCalledWith("hello world");
    expect(input(host).value).toBe("");
    expect(sendBtn(host).disabled).toBe(true);
    expect(txt(counter(host))).toBe("0 / 4096");
  });

  it("inner newlines and multi-byte text are preserved verbatim", () => {
    const { host, spies } = mountSpied();
    type(host, "line1\n\n  line3 é\u{1F600}");
    click(sendBtn(host));
    expect(spies.onSend).toHaveBeenCalledWith("line1\n\n  line3 é\u{1F600}");
  });

  it("clicking send twice in a row sends once (second click on an empty, disabled composer)", () => {
    const { host, spies } = mountSpied();
    type(host, "once");
    click(sendBtn(host));
    click(sendBtn(host));
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("a submit event on the form also sends once (button click does not double fire)", () => {
    const { host, spies } = mountSpied();
    type(host, "via submit");
    const ev = submitForm(host);
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(spies.onSend).toHaveBeenCalledWith("via submit");
    expect(ev.defaultPrevented).toBe(true);
    expect(input(host).value).toBe("");
  });

  it("submit with empty/whitespace text never calls onSend (and is default-prevented)", () => {
    const { host, spies } = mountSpied();
    expect(submitForm(host).defaultPrevented).toBe(true);
    type(host, "  \n ");
    submitForm(host);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("submit over the byte limit never calls onSend and keeps the draft", () => {
    const { host, spies } = mountSpied();
    type(host, "é".repeat(2049));
    submitForm(host);
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(input(host).value).toBe("é".repeat(2049));
  });

  it("submit while sending never calls onSend and keeps the draft", () => {
    const { host, handle, spies } = mountSpied();
    type(host, "wait");
    handle.update({ ...FIXTURE, sending: true });
    submitForm(host);
    key(input(host), "Enter", { ctrlKey: true });
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(input(host).value).toBe("wait");
  });

  it("send without handlers does not throw and still clears the textarea", () => {
    const { host } = mount();
    type(host, "no handlers");
    expect(() => click(sendBtn(host))).not.toThrow();
    expect(input(host).value).toBe("");
  });

  it("onSend that throws does not leave the component broken for the next send", () => {
    const calls: string[] = [];
    const { host } = mount(FIXTURE, { onSend: (t) => { calls.push(t); if (calls.length === 1) throw new Error("boom"); } });
    type(host, "first");
    try { click(sendBtn(host)); } catch { /* handler error may surface */ }
    type(host, "second");
    try { click(sendBtn(host)); } catch { /* ignore */ }
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("U35 C3 keyboard submit", () => {
  it.each([["ctrlKey"], ["metaKey"]] as const)("%s+Enter submits exactly once with trimmed text and clears", (mod) => {
    const { host, spies } = mountSpied();
    type(host, "  keyboard send ");
    key(input(host), "Enter", { [mod]: true });
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(spies.onSend).toHaveBeenCalledWith("keyboard send");
    expect(input(host).value).toBe("");
  });

  it("Ctrl+Enter is default-prevented (no stray newline is inserted)", () => {
    const { host } = mountSpied();
    type(host, "x");
    expect(key(input(host), "Enter", { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it("plain Enter does not submit and is not default-prevented (inserts a newline)", () => {
    const { host, spies } = mountSpied();
    type(host, "multi");
    const ev = key(input(host), "Enter");
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    expect(input(host).value).toBe("multi");
  });

  it("Shift+Enter and Alt+Enter do not submit", () => {
    const { host, spies } = mountSpied();
    type(host, "multi");
    key(input(host), "Enter", { shiftKey: true });
    key(input(host), "Enter", { altKey: true });
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter on empty or whitespace-only text does nothing", () => {
    const { host, spies } = mountSpied();
    key(input(host), "Enter", { ctrlKey: true });
    type(host, "   ");
    key(input(host), "Enter", { metaKey: true });
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter over the byte limit does nothing and keeps the draft", () => {
    const { host, spies } = mountSpied();
    type(host, "a".repeat(LIMIT + 1));
    key(input(host), "Enter", { ctrlKey: true });
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(input(host).value.length).toBe(LIMIT + 1);
  });

  it("Ctrl+Enter then Ctrl+Enter again sends once (textarea cleared)", () => {
    const { host, spies } = mountSpied();
    type(host, "twice");
    key(input(host), "Enter", { ctrlKey: true });
    key(input(host), "Enter", { ctrlKey: true });
    expect(spies.onSend).toHaveBeenCalledTimes(1);
  });

  it("other Ctrl combinations (Ctrl+a) do not submit", () => {
    const { host, spies } = mountSpied();
    type(host, "text");
    key(input(host), "a", { ctrlKey: true });
    expect(spies.onSend).not.toHaveBeenCalled();
  });
});
