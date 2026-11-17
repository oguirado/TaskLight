import { describe, expect, it } from "vitest";
import { DESTINATIONS, assertFocusContract, assertPanelContract, key, mount, name, nav, navButtons } from "./helpers";

describe("U152 AC1 destination order and shortcuts", () => {
  it("AC1 keeps Wall, Agenda, Diary, Archive, Memory, Swarm in order with shortcuts 1 through 6", () => {
    const { host } = mount();
    const buttons = navButtons(host);
    expect(buttons.map(button => button.dataset.nav)).toEqual(DESTINATIONS.map(([view]) => view));
    expect(buttons.map(name)).toEqual(DESTINATIONS.map(([, label]) => label));
    expect(buttons.map(button => button.getAttribute("aria-keyshortcuts"))).toEqual(DESTINATIONS.map(([, , shortcut]) => shortcut));
    for (const button of buttons) expect(button.type).toBe("button");
  });

  it.each(DESTINATIONS)("AC1 clicking %s selects its view once", (view, label) => {
    const { host, onView } = mount();
    nav(host, view).click();
    expect(onView).toHaveBeenCalledExactlyOnceWith(view);
    expect(host.querySelector(".app")?.getAttribute("data-view")).toBe(view);
    expect(host.querySelector("h1")?.textContent).toBe(label);
  });

  it.each(DESTINATIONS)("AC1 shortcut for %s selects its view once", (view, _label, shortcut) => {
    const { host, onView } = mount();
    key(document.body, shortcut);
    expect(onView).toHaveBeenCalledExactlyOnceWith(view);
    expect(host.querySelector(".app")?.getAttribute("data-view")).toBe(view);
  });
});

describe("U152 AC2 complete tabs or plain navigation", () => {
  it.each(DESTINATIONS)("AC2 %s keeps its selected control focusable and completes roving focus when using tabs", view => {
    const { host, update } = mount();
    update({ view });
    assertFocusContract(host, view);
  });

  it.each(DESTINATIONS)("AC2 %s has resolving tab/panel relationships or removes tab semantics", view => {
    const { host } = mount({ view });
    assertPanelContract(host);
  });

  it.each(["ArrowRight", "ArrowLeft", "Home", "End"])("AC2 %s works for complete tabs; plain buttons retain native focus", value => {
    const { host, onView } = mount({ view: "diary" });
    const selected = nav(host, "diary");
    selected.focus();
    if (selected.getAttribute("role") !== "tab") {
      for (const button of navButtons(host)) {
        button.focus();
        expect(document.activeElement).toBe(button);
        expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      }
      return;
    }
    const group = selected.closest('[role="tablist"]');
    expect(group).not.toBeNull();
    const tabs = [...group!.querySelectorAll<HTMLButtonElement>('button[role="tab"][data-nav]')];
    const current = tabs.indexOf(selected);
    const index = value === "Home" ? 0 : value === "End" ? tabs.length - 1
      : (current + (value === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const destination = tabs[index]!.getAttribute("data-nav");
    key(selected, value);
    const focused = document.activeElement as HTMLElement;
    expect(focused?.getAttribute("data-nav")).toBe(destination);
    // Accept automatic activation and manual activation; native click models activation
    // because this DOM environment does not synthesize browser Enter/Space clicks.
    if (!onView.mock.calls.length) focused.click();
    expect(onView).toHaveBeenCalledExactlyOnceWith(destination);
    expect(host.querySelector(".app")?.getAttribute("data-view")).toBe(destination);
  });

  it("AC2 tab/panel ids remain unique and local when two walls are mounted", () => {
    const first = mount({ view: "wall" });
    const second = mount({ view: "agenda" });
    assertPanelContract(first.host);
    assertPanelContract(second.host);
  });
});
