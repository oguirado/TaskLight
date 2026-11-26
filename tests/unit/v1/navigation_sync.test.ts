import { describe, expect, it } from "vitest";
import { agent, board, bubble, deterministic, HOSTILE, integrated, lane, mounted, name, projection, text, visible, visibleText } from "./helpers";

deterministic();

function control(root: ParentNode, label: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('button,summary,[role="button"],[role="tab"],a[href]')]
    .find(n => visible(n) && name(n) === label);
  expect(found, `M1 reachable control: ${label}`).toBeDefined(); return found!;
}

function more(root: ParentNode): HTMLElement {
  const button = control(root, "More");
  if (button.tagName === "SUMMARY") button.parentElement?.setAttribute("open", "");
  else if (button.getAttribute("aria-expanded") !== "true") button.click();
  return button;
}

function banner(root: HTMLElement, reason?: string): HTMLElement {
  const candidates = [...root.querySelectorAll<HTMLElement>("*")].filter(n => visible(n) &&
    text(n).startsWith("Can't read this workspace:") && ![...n.children].some(c => text(c).startsWith("Can't read this workspace:")));
  expect(candidates, "M6 explicit error banner, never an empty healthy board").toHaveLength(1);
  expect(text(candidates[0]!).slice("Can't read this workspace:".length).trim().length, "M6 error has a reason").toBeGreaterThan(0);
  if (reason !== undefined) expect(text(candidates[0]!)).toContain(reason);
  return candidates[0]!;
}

describe("V1 M1 default and secondary navigation", () => {
  it("M1 fresh controller mount selects swarm and labels it Agents", () => {
    const wall = integrated();
    expect(wall.host.querySelector(".app")?.getAttribute("data-view"), "Negative control: Wall must no longer be the default").toBe("swarm");
    const agents = control(wall.host, "Agents");
    expect(agents.getAttribute("data-nav")).toBe("swarm");
    expect(visibleText(wall.host)).toContain("z-lead");
  });

  it("M1 More exposes every secondary destination, Models and narration", () => {
    const wall = mounted(); const trigger = more(wall.host);
    // A labelled group or the controlled disclosure panel is enough; no menu tag/class is prescribed.
    const controlled = trigger.getAttribute("aria-controls");
    const group = (controlled ? document.getElementById(controlled) : null) ?? trigger.closest("details") ??
      [...wall.host.querySelectorAll<HTMLElement>('[aria-label="More"],[role="group"],[role="menu"]')]
        .find(n => n.contains(trigger) || /Wall/.test(text(n)));
    expect(group, "M1 secondary navigation belongs to More").toBeTruthy();
    for (const label of ["Wall", "Agenda", "Diary", "Archive", "Memory", "Models"]) {
      const destination = control(wall.host, label);
      expect(group!.contains(destination), `M1 ${label} is in the More group`).toBe(true);
    }
    expect([...group!.querySelectorAll<HTMLElement>('button,summary,[role="button"],a[href]')]
      .some(n => visible(n) && /narrat/i.test(name(n))), "M1 narration remains reachable in More").toBe(true);
    for (const [id, label] of [["wall", "Wall"], ["agenda", "Agenda"], ["diary", "Diary"], ["archive", "Archive"], ["memory", "Memory"]] as const) {
      more(wall.host); control(wall.host, label).click();
      expect(wall.host.querySelector(".app")?.getAttribute("data-view")).toBe(id);
    }
  });

  it.each([["1", "wall"], ["2", "agenda"], ["3", "diary"], ["4", "archive"], ["5", "memory"], ["6", "swarm"]] as const)(
    "M1 preserved shortcut %s reaches %s", (key, view) => {
      const wall = mounted(); wall.host.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(wall.host.querySelector(".app")?.getAttribute("data-view")).toBe(view);
    });

  it("M1 shortcuts remain inert inside editable fields", () => {
    const wall = mounted(), input = document.createElement("input"); wall.host.append(input); input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
    expect(wall.host.querySelector(".app")?.getAttribute("data-view")).toBe("swarm");
  });
});

describe("V1 M6 honest sync at existing store and availability seams", () => {
  const readFailureNotice = "Can't read this workspace: Room data could not be read.";

  it.each(["events", "plan"] as const)("M6 %s read failure retains the last good lanes below the fixed notice", port => {
    const wall = integrated("swarm");
    expect(visibleText(wall.host)).toContain("z-lead");
    const before = visibleText(lane(wall.host, "z-lead"));
    const readerError = "journal permission denied";
    wall[port].mockImplementation(() => { throw new Error(readerError); });
    wall.wall.refresh();
    const error = banner(wall.host), row = lane(wall.host, "z-lead");
    expect(text(error)).toBe(readFailureNotice);
    expect(wall.host.textContent).not.toContain(readerError);
    expect(error.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(visibleText(row)).toContain(before);
    expect(visibleText(wall.host)).not.toContain("No agents in this room");
    expect(wall.post).not.toHaveBeenCalled();
  });

  it("M6 reported projection sync faults are errors even when transport remains linked", () => {
    const wall = integrated("swarm");
    wall.plan.mockReturnValue({ ...wall.result, invalidOps: 1, errors: [{ code: "room_gap" }] }); wall.wall.refresh();
    banner(wall.host);
    expect(visibleText(lane(wall.host, "z-lead"))).toContain("z-lead");
  });

  it("M6 room unavailability shows a reason and retains the last good inventory", () => {
    const wall = integrated("swarm");
    wall.status.link = { kind: "unreachable", reason: "NOT_LISTED" };
    wall.status.rooms = []; wall.status.synced = []; wall.wall.refresh();
    banner(wall.host);
    expect(visibleText(lane(wall.host, "z-lead"))).toContain("z-lead");
    expect(visibleText(wall.host)).not.toContain("No agents in this room");
  });

  it("M6 first unavailable read shows the fixed notice and never invents healthy lanes", () => {
    const wall = integrated("swarm", HOSTILE);
    expect(text(banner(wall.host))).toBe(readFailureNotice);
    expect(wall.host.textContent).not.toContain(HOSTILE);
    expect(wall.host.querySelector("img,script,iframe,[onerror]")).toBeNull();
    expect(visibleText(wall.host)).not.toContain("No agents in this room");
  });

  it("M6 recovery replaces retained content with current lanes and clears the error", () => {
    const wall = integrated("swarm");
    const readerError = "read denied";
    wall.events.mockImplementation(() => { throw new Error(readerError); }); wall.wall.refresh();
    expect(text(banner(wall.host))).toBe(readFailureNotice);
    expect(wall.host.textContent).not.toContain(readerError);
    wall.events.mockReturnValue([]); wall.plan.mockReturnValue({ ...wall.result, projection: projection(board([agent("after-recovery")])) }); wall.wall.refresh();
    expect(visibleText(wall.host)).not.toContain("Can't read this workspace:");
    expect(visibleText(lane(wall.host, "after-recovery"))).toContain("after-recovery");
    expect(visibleText(wall.host)).not.toContain("z-lead");
  });

  it("M6 a genuine healthy empty inventory is distinct from an unavailable room", () => {
    const wall = mounted(board([]));
    expect(visibleText(wall.host)).toContain("No agents in this room");
    expect(visibleText(wall.host)).not.toContain("Can't read this workspace:");
  });
});
