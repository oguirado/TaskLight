import { afterEach, describe, expect, it } from "vitest";
import { cleanup, click, counter, input, mount, mountSpied, q, qa, sendBtn, suggestBtn, txt, type } from "./helpers";
import { FIXTURE } from "./fixture";

afterEach(cleanup);

const NOTE = "Drafted by Gemini Nano on this device — review before sending.";
const withSuggestion = (s: string) => ({ ...FIXTURE, suggestion: s });

describe("U35 C4 suggestion", () => {
  it("suggest button calls onSuggest once and nothing else", () => {
    const { host, spies } = mountSpied();
    click(suggestBtn(host));
    expect(spies.onSuggest).toHaveBeenCalledTimes(1);
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(input(host).value).toBe("");
  });

  it("suggest click with a draft present does not clear or send it", () => {
    const { host, spies } = mountSpied();
    type(host, "my draft");
    click(suggestBtn(host));
    expect(input(host).value).toBe("my draft");
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("suggest without handlers does not throw", () => {
    const { host } = mount();
    expect(() => click(suggestBtn(host))).not.toThrow();
  });

  it("update() with a suggestion on an empty textarea drafts it, with the exact note", () => {
    const { host, handle, spies } = mountSpied();
    handle.update(withSuggestion("Please add the migration steps."));
    expect(input(host).value).toBe("Please add the migration steps.");
    expect(txt(q(host, "p.chat-suggest-note"))).toBe(NOTE);
    expect(qa(host, "p.chat-suggest-note").length).toBe(1);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("a suggestion present at mount is drafted too", () => {
    const { host, spies } = mountSpied(withSuggestion("From mount"));
    expect(input(host).value).toBe("From mount");
    expect(txt(q(host, "p.chat-suggest-note"))).toBe(NOTE);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("the drafted suggestion is never auto-sent, even across further updates", () => {
    const { handle, spies } = mountSpied();
    handle.update(withSuggestion("Draft A"));
    handle.update(withSuggestion("Draft A"));
    handle.update({ ...withSuggestion("Draft A"), sending: true });
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("the drafted text enables send and updates the byte counter", () => {
    const { host, handle } = mount();
    handle.update(withSuggestion("héllo"));
    expect(sendBtn(host).disabled).toBe(false);
    expect(txt(counter(host))).toBe("6 / 4096");
  });

  it("the draft is editable and sends the edited trimmed text only when the user submits", () => {
    const { host, handle, spies } = mountSpied();
    handle.update(withSuggestion("Draft A"));
    type(host, " Draft A, edited ");
    click(sendBtn(host));
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    expect(spies.onSend).toHaveBeenCalledWith("Draft A, edited");
  });

  it("a non-empty textarea is never overwritten by a suggestion", () => {
    const { host, handle } = mount();
    type(host, "typing something");
    handle.update(withSuggestion("Should not replace"));
    expect(input(host).value).toBe("typing something");
  });

  it("an edited draft survives a later update carrying the same or a new suggestion", () => {
    const { host, handle } = mount();
    handle.update(withSuggestion("First"));
    type(host, "First, then my edit");
    handle.update(withSuggestion("First"));
    handle.update(withSuggestion("Second"));
    expect(input(host).value).toBe("First, then my edit");
  });

  it("no suggestion: no note and the textarea is untouched", () => {
    const { host, handle } = mount();
    handle.update(FIXTURE);
    expect(qa(host, "p.chat-suggest-note").length).toBe(0);
    expect(input(host).value).toBe("");
  });

  it("an empty-string suggestion is treated as absent", () => {
    const { host, handle } = mount();
    handle.update(withSuggestion(""));
    expect(input(host).value).toBe("");
    expect(qa(host, "p.chat-suggest-note").length).toBe(0);
  });

  it("the note is a p element inside the section", () => {
    const { host } = mountSpied(withSuggestion("x"));
    expect(q(host, "section.agent-chat p.chat-suggest-note").tagName).toBe("P");
  });

  it("suggestion text with HTML is placed in the textarea literally", () => {
    const { host } = mount(withSuggestion("<b>bold</b> & more"));
    expect(input(host).value).toBe("<b>bold</b> & more");
    expect(host.querySelector("b")).toBeNull();
  });
});
