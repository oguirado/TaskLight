import { describe, expect, it } from "vitest";
import { renderNarrator } from "../../../src/views/narrator";
import { MARKUP, HOSTILE, mounted } from "./fixtures";
import type { NarratorSnapshot } from "./fixtures";

function button(root: HTMLElement): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(b =>
    /Refresh narration/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
  expect(found, "Accessible Refresh narration button").toBeDefined();
  return found!;
}
function activate(control: HTMLButtonElement, key: "Enter" | " "): void {
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
  control.dispatchEvent(down); control.dispatchEvent(up);
  // jsdom omits the native activation default for buttons.
  if (!down.defaultPrevented && !up.defaultPrevented) control.click();
}

describe("M8 narrator view", () => {
  it("M8 labels the panel and provides a keyboard-focusable Refresh narration button", () => {
    const { root, refresh } = mounted({ kind: "rules", source: null, text: "No agents deployed" }, renderNarrator);
    expect(root.textContent).toContain("Swarm narration"); expect(root.textContent).toContain("Rules summary");
    const control = button(root); expect(control.disabled).toBe(false); expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    control.focus(); expect(document.activeElement).toBe(control);
    control.click(); expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["Enter", " "] as const)("M8 Refresh supports keyboard key %s", key => {
    const { root, refresh } = mounted({ kind: "rules", source: null, text: "No agents deployed" }, renderNarrator);
    const control = button(root); control.focus(); activate(control, key);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ON_DEVICE", "ON_DEVICE · Gemini Nano"],
    ["IN_CLOUD", "IN_CLOUD · gemini-4-hydrogen · fallback"],
  ] as const)("M7 displays actual %s source beside narration", (source, label) => {
    const { root } = mounted({ kind: "generated", source, text: "executor-a is working on T01." }, renderNarrator);
    expect((root.textContent ?? "").replace(/\s+/g, " ")).toContain(label);
  });

  it.each(["NEEDS_SETUP", "OFFLINE", "TIMEOUT", "SCHEMA_REJECT", "BODY_TOO_LARGE", "BLOCKED", "FIREBASE_FAILED"] as const)(
    "M7 rules reason %s is visible without generated-source attribution", reason => {
      const snapshot: NarratorSnapshot = { kind: "rules", source: null, reason, text: "executor-a: Liveness unknown." };
      const { root } = mounted(snapshot, renderNarrator);
      expect(root.textContent).toMatch(/Rules summary/i);
      expect(root.textContent).toContain(snapshot.text);
      expect(root.textContent).not.toMatch(/ON_DEVICE ·|IN_CLOUD ·|Gemini Nano/);
      // Wording is intentionally open: a human explanation or the provider code is acceptable.
      const withoutContent = (root.textContent ?? "").replace(snapshot.text, "").replace(/Rules summary|Swarm narration|Refresh narration/gi, "");
      expect(withoutContent.replace(/[\s·:—-]/g, "").length).toBeGreaterThan(0);
    },
  );

  it("C.M7 generating shows current rules with no old source attribution", () => {
    const { root } = mounted({ kind: "generating", source: null, text: "current-room-agent: Liveness unknown." }, renderNarrator);
    expect(root.textContent).toContain("current-room-agent");
    expect(root.textContent).not.toMatch(/ON_DEVICE ·|IN_CLOUD ·|Gemini Nano/);
  });

  it("A4 retained malicious strings remain text and cannot create DOM markup", () => {
    const text = `Failed: ${MARKUP} ${HOSTILE}`;
    const { root } = mounted({ kind: "rules", source: null, text }, renderNarrator);
    expect(root.textContent).toContain(text);
    expect(root.querySelector("img, system, script, iframe")).toBeNull();
    expect(root.querySelector("[onerror], [onclick]")).toBeNull();
  });

  it("M8 grants no composer, terminal, room mutation or implicit refresh", () => {
    const { root, refresh } = mounted({ kind: "rules", source: null, text: "No agents deployed" }, renderNarrator);
    expect(root.querySelector("textarea, input, [contenteditable=true], form, iframe")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(root.textContent).not.toMatch(/send message|open terminal|change room/i);
  });
});
