import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAgentChat } from "../../../src/agentsui";
import type { AgentChatHandle, AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import { FIXTURE } from "./fixture";
import { cleanup, input, key, mount, q, sendBtn, suggestBtn, type } from "./helpers";

afterEach(cleanup);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 15));
  }
};

/** VM with every control present: silent banner (escalate) and drift banner (accept). */
const FULL: AgentChatVM = {
  ...FIXTURE,
  silent: true,
  silentFor: "12 min",
  drift: { verdict: "drift", reason: "Scope changed.", added: ["a"], removed: ["b"], source: "device" },
};

describe("U35 review1 C3: one click / one Ctrl+Enter sends exactly once even if onSend synchronously restores a suggestion", () => {
  const SUGG: AgentChatVM = { ...FIXTURE, suggestion: "Draft", sending: false };
  const setup = () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const box: { handle?: AgentChatHandle } = {};
    const onSend = vi.fn<(t: string) => void>(() => { box.handle?.update({ ...SUGG }); });
    const handle = mountAgentChat(host, SUGG, { onSend });
    box.handle = handle;
    return { host, handle, onSend };
  };

  it("native click on button.chat-send calls onSend once with the draft", async () => {
    const { host, handle, onSend } = setup();
    try {
      expect(input(host).value).toBe("Draft");
      sendBtn(host).click();
      await flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith("Draft");
    } finally { handle.destroy(); host.remove(); }
  });

  it("dispatched MouseEvent click on button.chat-send calls onSend once", async () => {
    const { host, handle, onSend } = setup();
    try {
      sendBtn(host).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flush();
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally { handle.destroy(); host.remove(); }
  });

  it("the restored suggestion stays in the textarea and is not auto-sent", async () => {
    const { host, handle, onSend } = setup();
    try {
      sendBtn(host).click();
      await flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(input(host).value).toBe("Draft");
      expect(sendBtn(host).disabled).toBe(false);
    } finally { handle.destroy(); host.remove(); }
  });

  it("Ctrl+Enter calls onSend once and does not auto-send the restored suggestion", async () => {
    const { host, handle, onSend } = setup();
    try {
      key(input(host), "Enter", { ctrlKey: true });
      await flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith("Draft");
      expect(input(host).value).toBe("Draft");
    } finally { handle.destroy(); host.remove(); }
  });

  it("Meta+Enter calls onSend once", async () => {
    const { host, handle, onSend } = setup();
    try {
      key(input(host), "Enter", { metaKey: true });
      await flush();
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally { handle.destroy(); host.remove(); }
  });

  it("a second deliberate click afterwards sends again (one send per activation)", async () => {
    const { host, handle, onSend } = setup();
    try {
      sendBtn(host).click();
      sendBtn(host).click();
      await flush();
      expect(onSend).toHaveBeenCalledTimes(2);
    } finally { handle.destroy(); host.remove(); }
  });
});

describe("U35 review1 C9: only unmodified digits 1-4 are stopped", () => {
  const docSpy = () => {
    const fn = vi.fn<(e: KeyboardEvent) => void>();
    document.addEventListener("keydown", fn);
    return { fn, off: () => document.removeEventListener("keydown", fn) };
  };
  const MODS = ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const;
  const cases = ["1", "2", "3", "4"].flatMap((d) => MODS.map((m) => [d, m] as const));

  it.each(cases)("digit %s with %s reaches a document-level keydown listener", (d, mod) => {
    const { host } = mount();
    const s = docSpy();
    try {
      key(input(host), d, { [mod]: true });
      expect(s.fn).toHaveBeenCalledTimes(1);
    } finally { s.off(); }
  });

  it("Shift+digit (layout symbol keys such as '!') reaches the document", () => {
    const { host } = mount();
    const s = docSpy();
    try {
      key(input(host), "1", { shiftKey: true, code: "Digit1" });
      expect(s.fn).toHaveBeenCalledTimes(1);
    } finally { s.off(); }
  });

  it.each(["1", "2", "3", "4"])("plain digit %s does not reach the document and is not default-prevented", (d) => {
    const { host } = mount();
    const s = docSpy();
    try {
      const ev = key(input(host), d);
      expect(s.fn).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    } finally { s.off(); }
  });
});

describe("U35 review1 DISP_03: handler failures are contained", () => {
  type Name = keyof AgentChatHandlers;
  const NAMES: Name[] = ["onSend", "onSuggest", "onEscalate", "onAcceptDrift", "onClose"];

  const trigger = (host: HTMLElement, name: Name): void => {
    switch (name) {
      case "onSend": type(host, "hello"); sendBtn(host).click(); break;
      case "onSuggest": suggestBtn(host).click(); break;
      case "onEscalate": q(host, "button.chat-escalate").click(); break;
      case "onAcceptDrift": q(host, "button.chat-accept-drift").click(); break;
      case "onClose": q(host, "button.agent-chat-close").click(); break;
    }
  };

  // Plain function + manual call log: a vi.fn wrapper would attach a .then to a returned
  // promise (to record its result) and thereby mask a genuinely unhandled rejection.
  const withHandler = (name: Name, fn: () => unknown): { spy: { mock: { calls: unknown[][] } }; handlers: AgentChatHandlers } => {
    const calls: unknown[][] = [];
    const plain = (...args: unknown[]): unknown => { calls.push(args); return fn(); };
    return { spy: { mock: { calls } }, handlers: { [name]: plain } as unknown as AgentChatHandlers };
  };
  const nCalls = (s: { mock: { calls: unknown[][] } }): number => s.mock.calls.length;

  it.each(NAMES)("%s returning a rejected promise causes no unhandled rejection", async (name) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { spy, handlers } = withHandler(name, () => Promise.reject(new Error("port failed")));
      const { host } = mount(FULL, handlers);
      trigger(host, name);
      await flush();
      expect(nCalls(spy)).toBe(1);
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it.each(NAMES)("%s as an async function that throws causes no unhandled rejection", async (name) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { spy, handlers } = withHandler(name, async () => { throw new Error("async port failure"); });
      const { host } = mount(FULL, handlers);
      trigger(host, name);
      await flush();
      expect(nCalls(spy)).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it.each(NAMES)("%s throwing synchronously does not propagate out of event dispatch", async (name) => {
    const winErr = vi.fn();
    window.addEventListener("error", winErr);
    try {
      const { spy, handlers } = withHandler(name, () => { throw new Error("sync port failure"); });
      const { host } = mount(FULL, handlers);
      expect(() => trigger(host, name)).not.toThrow();
      await flush();
      expect(nCalls(spy)).toBe(1);
      expect(winErr).not.toHaveBeenCalled();
    } finally { window.removeEventListener("error", winErr); }
  });

  it("Ctrl+Enter with a rejecting or throwing onSend is contained", async () => {
    const unhandled = vi.fn();
    const winErr = vi.fn();
    process.on("unhandledRejection", unhandled);
    window.addEventListener("error", winErr);
    try {
      for (const fn of [() => Promise.reject(new Error("r")), () => { throw new Error("s"); }]) {
        const { handlers } = withHandler("onSend", fn);
        const { host } = mount(FULL, handlers);
        type(host, "hello");
        expect(() => key(input(host), "Enter", { ctrlKey: true })).not.toThrow();
      }
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(winErr).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      window.removeEventListener("error", winErr);
    }
  });

  it("after a rejected onSend the composer remains usable", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { spy, handlers } = withHandler("onSend", () => Promise.reject(new Error("nope")));
      const { host } = mount(FULL, handlers);
      type(host, "one");
      sendBtn(host).click();
      await flush();
      type(host, "two");
      sendBtn(host).click();
      await flush();
      expect(spy.mock.calls.map((c) => c[0])).toEqual(["one", "two"]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it.each(["onSuggest", "onClose", "onAcceptDrift"] as const)("after a rejected %s a second activation still calls the handler", async (name) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { spy, handlers } = withHandler(name, () => Promise.reject(new Error("nope")));
      const { host } = mount(FULL, handlers);
      trigger(host, name);
      await flush();
      trigger(host, name);
      await flush();
      expect(nCalls(spy)).toBe(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
