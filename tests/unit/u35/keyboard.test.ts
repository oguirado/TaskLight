import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, input, key, log, mount, mountSpied, q, section, type } from "./helpers";
import { FIXTURE } from "./fixture";

afterEach(cleanup);

const DIGITS = ["1", "2", "3", "4"] as const;
const docSpy = () => {
  const fn = vi.fn<(e: KeyboardEvent) => void>();
  document.addEventListener("keydown", fn);
  return { fn, off: () => document.removeEventListener("keydown", fn) };
};

describe("U35 C9 digit keys typed in the textarea do not reach document shortcuts", () => {
  it.each(DIGITS)("plain %s keydown on the textarea never reaches a document listener", (d) => {
    const { host } = mount();
    const s = docSpy();
    try {
      const ev = key(input(host), d);
      expect(s.fn).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false); // the digit must still be typed
    } finally { s.off(); }
  });

  it("propagation is stopped for digits only after typing text too (focus + draft present)", () => {
    const { host } = mount();
    type(host, "abc");
    input(host).focus();
    const s = docSpy();
    try {
      for (const d of DIGITS) key(input(host), d);
      expect(s.fn).not.toHaveBeenCalled();
    } finally { s.off(); }
  });

  it.each(DIGITS.flatMap((d) => (["ctrlKey", "metaKey", "altKey"] as const).map((m) => [d, m] as const)))("%s with %s still reaches the document", (d, mod) => {
    const { host } = mount();
    const s = docSpy();
    try {
      key(input(host), d, { [mod]: true });
      expect(s.fn).toHaveBeenCalledTimes(1);
    } finally { s.off(); }
  });

  it.each(["0", "5", "9", "a", "A", "Enter", "Escape", "Tab", "Backspace", "ArrowLeft", " ", "/", "?"])("other key %j reaches the document", (k) => {
    const { host } = mount();
    const s = docSpy();
    try {
      key(input(host), k);
      expect(s.fn).toHaveBeenCalledTimes(1);
      expect(s.fn.mock.calls[0]?.[0].key).toBe(k);
    } finally { s.off(); }
  });

  it("Ctrl+Enter (submit) still bubbles to the document", () => {
    const { host, spies } = mountSpied();
    type(host, "x");
    const s = docSpy();
    try {
      key(input(host), "Enter", { ctrlKey: true });
      expect(spies.onSend).toHaveBeenCalledTimes(1);
      expect(s.fn).toHaveBeenCalledTimes(1);
    } finally { s.off(); }
  });

  it("digit keydowns from other elements of the chat are not stopped (only the textarea is special)", () => {
    const { host } = mount();
    const s = docSpy();
    try {
      key(section(host), "1");
      key(log(host), "2");
      key(q(host, "button.chat-send"), "3");
      expect(s.fn).toHaveBeenCalledTimes(3);
    } finally { s.off(); }
  });

  it("only keydown is affected: keyup/keypress of digits still bubble", () => {
    const { host } = mount();
    const seen: string[] = [];
    const f = (e: Event) => seen.push(e.type);
    document.addEventListener("keyup", f);
    document.addEventListener("keypress", f);
    try {
      input(host).dispatchEvent(new KeyboardEvent("keyup", { key: "1", bubbles: true }));
      input(host).dispatchEvent(new KeyboardEvent("keypress", { key: "1", bubbles: true }));
      expect(seen).toEqual(["keyup", "keypress"]);
    } finally { document.removeEventListener("keyup", f); document.removeEventListener("keypress", f); }
  });

  it("still holds after update() (listener survives re-render, no duplicates break it)", () => {
    const { host, handle } = mount();
    handle.update({ ...FIXTURE, silent: true });
    handle.update(FIXTURE);
    const s = docSpy();
    try {
      key(input(host), "3");
      expect(s.fn).not.toHaveBeenCalled();
      key(input(host), "x");
      expect(s.fn).toHaveBeenCalledTimes(1);
    } finally { s.off(); }
  });

  it("a listener on the ancestor host also does not see the digit (stopped at the textarea)", () => {
    const { host } = mount();
    const f = vi.fn();
    host.addEventListener("keydown", f);
    key(input(host), "2");
    expect(f).not.toHaveBeenCalled();
    key(input(host), "z");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("works for an element mounted in a host that is a nested container (events bubble through custom ancestors)", () => {
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    const inner = document.createElement("div");
    outer.appendChild(inner);
    const { host } = mount();
    inner.appendChild(host);
    const f = vi.fn();
    outer.addEventListener("keydown", f);
    key(input(host), "4");
    expect(f).not.toHaveBeenCalled();
    key(input(host), "q");
    expect(f).toHaveBeenCalledTimes(1);
    outer.remove();
  });
});
