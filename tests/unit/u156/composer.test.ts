import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountAgentChat } from "../../../src/agentsui";
import type { AgentChatHandle, AgentChatVM } from "../../../src/agentsui/types";
import { Browser } from "./browser";

const root = resolve(import.meta.dirname, "../../..");
const agentsCSS = readFileSync(resolve(root, "styles/agents.css"), "utf8");
const css = readFileSync(resolve(root, "styles/tokens.css"), "utf8") + agentsCSS;
const browser = new Browser();
const draft = "d".repeat(2_000);
const unavailable = "Gemini Nano unavailable: ".padEnd(300, "x");
const vm: AgentChatVM = { room: "private-room", agent: "executor-a", title: "Messages (legacy)",
  task: { id: "T01", assignee: "executor-a" }, messages: [], silent: false, sending: false };
let handle: AgentChatHandle | undefined;
beforeAll(async () => { await browser.start(); }, 20_000);
afterAll(async () => { await browser.close(); });
afterEach(() => { handle?.destroy(); handle = undefined; document.body.replaceChildren(); document.head.replaceChildren(); });

function mount() {
  const host = document.createElement("div"); document.body.append(host);
  handle = mountAgentChat(host, vm);
  handle.setDraft(draft);
  return { host, handle };
}
function markup(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelector("textarea")!.textContent = host.querySelector("textarea")!.value;
  return `<aside class="chat-drawer" data-open="true">${clone.innerHTML}</aside>`;
}

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Layout = { form: Box; input: Box; suggest: Box; send: Box; count: Box; meta: Box; note: Box | null;
  notice: Box | null; overflow: boolean; wraps: boolean; noteText: string | null; draft: string;
  motion: string[]; visible: boolean };
const probe = `(() => {
  const form = document.querySelector('.agent-chat-composer');
  const box = selector => {
    const node = form.querySelector(selector); if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const notice = form.querySelector('.chat-suggest-notice');
  const controls = [...form.querySelectorAll('textarea,button')];
  return { form: (() => { const r = form.getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; })(),
    input: box('.chat-input'), suggest: box('.chat-suggest'), send: box('.chat-send'),
    count: box('.chat-count'), meta: box('.chat-meta'), note: box('.chat-suggest-note'), notice: box('.chat-suggest-notice'),
    overflow: [form, ...form.children].some(n => n.scrollWidth > n.clientWidth + 1),
    wraps: notice ? notice.getBoundingClientRect().height > parseFloat(getComputedStyle(notice).lineHeight) : false,
    noteText: notice?.textContent ?? null, draft: form.querySelector('textarea').value,
    motion: controls.map(n => getComputedStyle(n).transitionDuration),
    visible: controls.every(n => getComputedStyle(n).visibility === 'visible') };
})()`;
function issues(layout: Layout, width: number): string[] {
  const result: string[] = [];
  if (layout.input.width < layout.form.width * 0.6) result.push("input below usable minimum");
  if (width <= 480 && Math.abs(layout.input.width - layout.form.width) > 1) result.push("mobile input lacks its own full row");
  if (layout.overflow) result.push("horizontal overflow");
  const boxes = [layout.input, layout.suggest, layout.send, layout.count, layout.meta, layout.note, layout.notice]
    .filter((box): box is Box => box !== null && box.width > 0 && box.height > 0);
  for (const [i, a] of boxes.entries()) {
    if (a.x < layout.form.x - 1 || a.right > layout.form.right + 1 || a.bottom > layout.form.bottom + 1)
      result.push("content outside composer");
    for (const b of boxes.slice(i + 1)) {
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) result.push("overlapping composer items");
    }
  }
  if (!layout.notice || layout.notice.y < Math.max(layout.send.bottom, layout.meta.bottom) - 1)
    result.push("unavailable note is not below controls and identity");
  if (!layout.wraps) result.push("long unavailable note does not wrap");
  return result;
}
function sendOffset(layout: Layout): number[] {
  return [layout.send.x - layout.form.x, layout.send.y - layout.form.y, layout.send.width, layout.send.height];
}

describe("U156 legacy composer", () => {
  it.each([1280, 480, 390].flatMap(width => [false, true].map(reduced => ({ width, reduced }))))(
    "keeps the input usable and notes below controls at $width px (reduced=$reduced)", async ({ width, reduced }) => {
      const { host, handle } = mount();
      await browser.load(css, markup(host), { width, reduced });
      const before = await browser.evaluate<Layout>(probe);
      handle.update({ ...vm, suggestion: "A suggestion must not replace this draft", suggestNotice: unavailable });
      await browser.load(css, markup(host), { width, reduced });
      const after = await browser.evaluate<Layout>(probe);
      expect(unavailable).toHaveLength(300);
      expect(issues(after, width)).toEqual([]);
      expect(after.noteText).toBe(unavailable);
      expect(after.draft).toBe(draft);
      expect(sendOffset(after)).toEqual(sendOffset(before));
      expect(after.visible).toBe(true);
      if (reduced) expect(after.motion.every(value => value.split(",").every(part => parseFloat(part) === 0))).toBe(true);
      await browser.evaluate("document.querySelector('.chat-input').focus()");
      await browser.tab();
      expect(await browser.evaluate("document.activeElement.className")).toBe("chat-suggest");
      await browser.tab();
      expect(await browser.evaluate("document.activeElement.className")).toBe("chat-send");
    });

  it("preserves the long draft, selection and focus through a requested and failed suggestion", async () => {
    const { host } = mount();
    const style = document.createElement("style"); style.textContent = agentsCSS; document.head.append(style);
    const onSend = vi.fn();
    let fail!: (reason: Error) => void;
    const request = new Promise<void>((_, reject) => { fail = reject; });
    handle!.destroy();
    handle = mountAgentChat(host, vm, { onSend, onSuggest: () => {
      handle!.update({ ...vm, suggestNotice: "Requesting an on-device suggestion" });
      return request.catch(() => { handle!.update({ ...vm, suggestNotice: unavailable }); });
    } });
    // The remount only installs the test handler; the real request/failure updates reuse these controls.
    handle.setDraft(draft);
    const currentInput = host.querySelector("textarea")!;
    currentInput.focus(); currentInput.setSelectionRange(17, 91, "backward");
    const currentSuggest = host.querySelector<HTMLButtonElement>(".chat-suggest")!;
    const currentSend = host.querySelector<HTMLButtonElement>(".chat-send")!;
    currentSuggest.click();
    expect(document.activeElement).toBe(currentInput);
    expect(currentInput.value).toBe(draft);
    fail(new Error("on-device model unavailable"));
    await request.catch(() => undefined);
    expect(host.querySelector("textarea")).toBe(currentInput);
    expect(host.querySelector(".chat-suggest")).toBe(currentSuggest);
    expect(host.querySelector(".chat-send")).toBe(currentSend);
    expect(document.activeElement).toBe(currentInput);
    expect([currentInput.selectionStart, currentInput.selectionEnd, currentInput.selectionDirection]).toEqual([17, 91, "backward"]);
    expect(currentInput.value).toBe(draft);
    expect(onSend).not.toHaveBeenCalled();
    const notice = host.querySelector<HTMLElement>(".chat-suggest-notice")!;
    expect(notice.textContent).toBe(unavailable);
    expect(getComputedStyle(notice).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(notice).gridArea).toBe("notice");
  });

  it("rejects the old grid with the same layout oracle (negative control)", async () => {
    const { host, handle } = mount();
    handle.update({ ...vm, suggestNotice: unavailable });
    await browser.load(css, markup(host), { width: 1280 });
    expect(issues(await browser.evaluate<Layout>(probe), 1280)).toEqual([]);
    // A-U156: retain the obsolete grid only as a rejected negative control.
    const oldGrid = `.agent-chat-composer {
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-areas: "input suggest send" "count count count" "note note note";
    }`;
    await browser.load(css + oldGrid, markup(host), { width: 1280 });
    expect(issues(await browser.evaluate<Layout>(probe), 1280)).toContain("input below usable minimum");
  });
});
