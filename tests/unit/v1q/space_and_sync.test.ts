import { describe, expect, it, vi } from "vitest";
import { board, bubble, deterministic, render } from "../v1/helpers";

// V1q (V1 r2 review debts 1-2).
deterministic();

const key = (button: HTMLButtonElement, type: "keydown" | "keyup") =>
  button.dispatchEvent(new KeyboardEvent(type, { key: " ", code: "Space", bubbles: true, cancelable: true }));

describe("V1q Space suppression and sync banner", () => {
  it("a later assistive-technology click (no pointerdown) still toggles after Space when the browser cancelled the synthesized click", () => {
    const button = bubble(render(), "Task T09");
    button.focus();
    key(button, "keydown");
    key(button, "keyup");
    vi.runAllTimers();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("an empty sync_error still names a reason", () => {
    const root = render({ ...board(), sync_error: "" } as ReturnType<typeof board>);
    const banner = root.querySelector(".swarm-sync-error");
    expect(banner).not.toBeNull();
    expect((banner?.textContent ?? "").replace(/\s+/g, " ").trim()).toBe("Can't read this workspace: reason unknown");
  });
});
