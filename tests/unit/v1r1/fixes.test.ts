import { describe, expect, it } from "vitest";
import { activate, agent, board, bubble, deterministic, lane, render, task } from "../v1/helpers";

deterministic();

function space(button: HTMLButtonElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  return event;
}

describe("V1r1 blocking regressions", () => {
  it("toggles once for Space followed by a synthesized click", () => {
    const button = bubble(render(), "Task T09");
    button.focus();
    expect(space(button).defaultPrevented).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    space(button);
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps Enter and pointer clicks toggling once", () => {
    const button = bubble(render(), "Task T09");
    activate(button, "Enter");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    activate(button, "Enter");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("allows a pointer click after Space when no synthesized click arrives", () => {
    const button = bubble(render(), "Task T09");
    space(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(task().microtasks)("exposes accessible text for $state microtasks without labelling a generic span", micro => {
    const root = render();
    bubble(root, "Task T09").click();
    const title = [...root.querySelectorAll<HTMLElement>(".swarm-microtask-title")]
      .find(node => node.textContent === micro.text);
    expect(title).toBeDefined();
    expect(title!.tagName).toBe("SPAN");
    expect(title!.hasAttribute("aria-label")).toBe(false);
    expect(title!.getAttribute("aria-hidden")).toBe("true");
    const accessible = title!.parentElement!.querySelector<HTMLElement>(".swarm-sr-only");
    expect(accessible?.textContent).toBe(`${micro.text}, ${micro.state}, ${micro.state === "done" ? 1 : 0}/1`);
    expect(accessible?.closest('[aria-hidden="true"], [hidden]')).toBeNull();
  });

  it("renders an empty runtime agent state as Unknown without throwing", () => {
    const vm = board([agent("empty-state", { state: "unknown", tasks: [] })]);
    // Empty lifecycle strings can arrive in parsed snapshots despite the static state union.
    Object.assign(vm.agents[0]!, { state: "" });
    let root: HTMLElement | undefined;
    expect(() => { root = render(vm); }).not.toThrow();
    const row = lane(root!, "empty-state");
    expect(row.querySelector(".swarm-inventory-state")?.textContent).toBe("Unknown");
  });
});
