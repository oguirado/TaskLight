import { describe, expect, it } from "vitest";
import type { SwarmAgentVM } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { agent, deterministic, freeze, keyboardActivate, micro, task, viewModel } from "../u136/fixtures";
import { opaqueArticlePrune } from "./pruning";

deterministic();

const MARKUP = '<img src="invalid" onerror="alert(1)"><b>same-agent</b>';

function row(name: string, swarm: string, taskId: string): SwarmAgentVM {
  return agent({ agent: name, swarm, current_task_id: taskId, active_micro_id: `${taskId}.M01`,
    tasks: [task(taskId, { assignee: name, microtasks: [micro(`${taskId}.M01`, {
      outcome: `Observed outcome for ${taskId}`,
    })] })] });
}

function ordinaryRows(): SwarmAgentVM[] {
  return [row("executor-a", "alpha", "T01"), row("executor-b", "alpha", "T02"),
    row("executor-c", "beta", "T03")];
}

function hostileRows(): SwarmAgentVM[] {
  return [row("same-agent", "alpha", "T01"), row("same-agent", "beta", "T02"),
    row(MARKUP, "alpha", "T03"), row(MARKUP, "beta", "T04")];
}

function mount(rows: readonly SwarmAgentVM[]): HTMLElement {
  const root = renderSwarmView(document, freeze(viewModel(rows)));
  document.body.append(root);
  expect(root.isConnected).toBe(true);
  expect(root.querySelectorAll(".swarm-card")).toHaveLength(rows.length);
  return root;
}

function normalized(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Explicit card names must not fall back to concatenating the whole card body. */
function declaredName(node: HTMLElement): string {
  const refs = node.getAttribute("aria-labelledby");
  if (refs !== null) {
    const ids = refs.trim().split(/\s+/).filter(Boolean);
    expect(ids.length, "A naming relationship must contain a target").toBeGreaterThan(0);
    return ids.map(id => {
      const targets = [...node.ownerDocument.querySelectorAll<HTMLElement>("[id]")]
        .filter(target => target.id === id);
      expect(targets, "Each accessible naming reference resolves exactly once").toHaveLength(1);
      return normalized(targets[0]!.textContent);
    }).join(" ");
  }
  return normalized(node.getAttribute("aria-label"));
}

function controlName(node: HTMLElement): string {
  return declaredName(node) || normalized(node.textContent);
}

function taskButton(card: HTMLElement, id: string): HTMLButtonElement {
  const found = [...card.querySelectorAll<HTMLButtonElement>("button")]
    .filter(button => controlName(button) === `View task ${id}`);
  expect(found, `Exactly one View task ${id} control`).toHaveLength(1);
  return found[0]!;
}

function cardFor(root: HTMLElement, entry: SwarmAgentVM): HTMLElement {
  const cards = [...root.querySelectorAll<HTMLElement>(".swarm-card")].filter(card => {
    const name = card.querySelector<HTMLElement>(".swarm-agent-name");
    const group = card.closest<HTMLElement>(".swarm-group");
    return name?.textContent === entry.agent
      && group?.querySelector(".swarm-group-title")?.textContent?.startsWith(`${entry.swarm} (`);
  });
  expect(cards, "A card is located by exact swarm and agent identity").toHaveLength(1);
  return cards[0]!;
}

function metadataButton(card: HTMLElement): HTMLButtonElement {
  const found = [...card.querySelectorAll<HTMLButtonElement>("button[aria-controls][aria-expanded]")]
    .filter(button => !controlName(button).startsWith("View task "));
  expect(found, "One metadata disclosure per agent").toHaveLength(1);
  return found[0]!;
}

function metadataTarget(button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute("aria-controls");
  expect(id, "Metadata must name its target").toBeTruthy();
  const matches = [...document.querySelectorAll<HTMLElement>("[id]")].filter(node => node.id === id);
  expect(matches, "Metadata target resolves uniquely without CSS escaping assumptions").toHaveLength(1);
  return matches[0]!;
}

function metadataIds(root: HTMLElement, rows: readonly SwarmAgentVM[]): Record<string, string> {
  return Object.fromEntries(rows.map(entry => {
    const button = metadataButton(cardFor(root, entry));
    const target = metadataTarget(button);
    return [JSON.stringify([entry.swarm, entry.agent]), target.id];
  }));
}

function detail(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(".swarm-detail");
  expect(panel, "Opening a task must expose its existing local detail").not.toBeNull();
  return panel!;
}

function escapeFrom(node: Element): void {
  node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

function expectPrunedControls(root: HTMLElement, rows: readonly SwarmAgentVM[]): void {
  const expected = rows.flatMap(entry => {
    const card = cardFor(root, entry);
    return entry.current_task_id === null ? [metadataButton(card)]
      : [taskButton(card, entry.current_task_id), metadataButton(card)];
  });
  // A missing renderer or empty input must never make this check vacuously green.
  expect(expected.length).toBeGreaterThan(0);
  const allTaskButtons = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .filter(button => controlName(button).startsWith("View task "));
  const required = [...new Set([...expected, ...allTaskButtons])];
  const emitted = new Set(opaqueArticlePrune(root));
  const missing = required.filter(button => !emitted.has(button)).map(controlName);
  expect(missing, "Every task and metadata button survives opaque-article pruning").toEqual([]);
}

describe("U146 fail-first acceptance oracle", () => {
  it("A1 cards use a non-article container and never the article role", () => {
    const rows = ordinaryRows(), root = mount(rows);
    for (const entry of rows) {
      const card = cardFor(root, entry);
      expect(card.localName, "Article roots conceal nested controls").not.toBe("article");
      expect((card.getAttribute("role") ?? "").split(/\s+/)).not.toContain("article");
    }
  });

  it("A1 each card has an explicit accessible name containing its agent identity", () => {
    const rows = ordinaryRows(), root = mount(rows);
    for (const entry of rows) expect(declaredName(cardFor(root, entry))).toContain(entry.agent);
  });

  it("A2 metadata IDs survive an equivalent render after intervening renders", () => {
    const rows = ordinaryRows(), first = mount(rows), before = metadataIds(first, rows);
    first.remove();
    mount([row("intervening-agent", "other", "T09")]).remove();
    const second = mount(rows);
    expect(metadataIds(second, rows), "An agent identity must not depend on a render counter").toEqual(before);
  });

  it("A2 metadata IDs follow identities through reordering and changing activity", () => {
    const rows = ordinaryRows(), first = mount(rows), before = metadataIds(first, rows);
    first.remove();
    const changed = [...rows].reverse().map<SwarmAgentVM>((entry, index) => ({ ...entry,
      activity: index === 0 ? "needs_you" : "waiting", last_beat_age_ms: 9_000 }));
    expect(metadataIds(mount(changed), changed)).toEqual(before);
  });

  it("A2 replacing an agent identity does not reuse the previous metadata target ID", () => {
    const original = row("executor-a", "alpha", "T01"), first = mount([original]);
    const oldId = metadataTarget(metadataButton(cardFor(first, original))).id;
    first.remove();
    const replacement = row("executor-new", "alpha", "T01"), second = mount([replacement]);
    expect(metadataTarget(metadataButton(cardFor(second, replacement))).id).not.toBe(oldId);
  });

  it.each(["pointer", "Enter", "Space", "card pointer"] as const)(
    "A3 opening detail by %s moves focus inside that detail", activation => {
      const entry = ordinaryRows()[0]!, root = mount([entry]), card = cardFor(root, entry);
      const trigger = taskButton(card, "T01");
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      if (activation === "pointer") trigger.click();
      else if (activation === "card pointer") card.click();
      else keyboardActivate(trigger, activation === "Space" ? " " : "Enter");
      const panel = detail();
      expect(panel.textContent).toContain("Observed outcome for T01");
      expect(panel.contains(document.activeElement), "Focus enters the detail container or a descendant").toBe(true);
    });

  it.each(["T01", "T02"])("A4 Escape returns to the exact %s trigger among duplicate agent names", taskId => {
    const rows = hostileRows(), root = mount(rows), entry = rows.find(item => item.current_task_id === taskId)!;
    const trigger = taskButton(cardFor(root, entry), taskId);
    trigger.focus(); trigger.click();
    const panel = detail();
    expect(panel.textContent).toContain(`Observed outcome for ${taskId}`);
    // Isolate preserved Escape return from the missing focus-entry behavior.
    const inside = panel.querySelector<HTMLElement>("button") ?? panel;
    inside.focus();
    expect(panel.contains(document.activeElement)).toBe(true);
    escapeFrom(document.activeElement!);
    expect(panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("A5 summaries, metadata and opened details expose no chat or terminal controls", () => {
    const rows = ordinaryRows(), root = mount(rows);
    const assertReadOnly = (): void => {
      expect(root.querySelector("textarea, form, [contenteditable='true'], [role='textbox']")).toBeNull();
      for (const control of root.querySelectorAll<HTMLElement>("button, a, input, [role='button'], [role='link']")) {
        const label = [controlName(control), control.getAttribute("title"), control.getAttribute("href"),
          control.getAttribute("placeholder"), control.getAttribute("data-nav")].join(" ");
        expect(label).not.toMatch(/\b(chat|terminal|composer|shell|send message|execute command)\b/i);
      }
    };
    assertReadOnly();
    for (const entry of rows) {
      const card = cardFor(root, entry);
      metadataButton(card).click(); assertReadOnly();
      taskButton(card, entry.current_task_id!).click(); assertReadOnly();
      escapeFrom(document.activeElement ?? document.body);
    }
  });

  it.each(["ordinary", "duplicate and markup-like names", "registration only"] as const)(
    "A6 opaque-article pruning retains every task and metadata button: %s", fixture => {
      const rows = fixture === "ordinary" ? ordinaryRows() : fixture === "duplicate and markup-like names"
        ? hostileRows() : [agent({ agent: "registration-only", swarm: "alpha", lifecycle: "deployed",
          tasks: [], current_task_id: null, active_micro_id: null, micro_done: null, micro_total: null,
          activity: "idle", last_beat_ts: null, last_beat_age_ms: null })];
      expectPrunedControls(mount(rows), rows);
    });

  it("A7 duplicate names across swarm labels have distinct independently operable metadata targets", () => {
    const rows = hostileRows(), root = mount(rows), ids = metadataIds(root, rows);
    expect(new Set(Object.values(ids)).size).toBe(rows.length);
    const toggles = rows.map(entry => metadataButton(cardFor(root, entry)));
    const targets = toggles.map(metadataTarget);
    for (const [selected, toggle] of toggles.entries()) {
      toggle.click();
      for (const [index, other] of toggles.entries()) {
        expect(other.getAttribute("aria-expanded")).toBe(String(index === selected));
        expect(targets[index]!.hidden).toBe(index !== selected);
      }
      toggle.click();
    }
  });

  it("A7 metadata identity remains stable for duplicate and markup-like names across rerenders", () => {
    const rows = hostileRows(), first = mount(rows), before = metadataIds(first, rows);
    first.remove();
    expect(metadataIds(mount([...rows].reverse()), rows)).toEqual(before);
  });

  it("A7 markup-like names remain literal and inert in cards, metadata and detail", () => {
    const rows = hostileRows(), root = mount(rows);
    const assertInert = (): void => {
      expect(root.querySelector("img, script, iframe, object, embed, [onerror], [onload], [onclick]")).toBeNull();
    };
    for (const entry of rows.filter(item => item.agent === MARKUP)) {
      const card = cardFor(root, entry);
      expect(card.querySelector(".swarm-agent-name")?.textContent).toBe(MARKUP);
      const toggle = metadataButton(card);
      expect(controlName(toggle)).toContain(MARKUP);
      const target = metadataTarget(toggle);
      toggle.click(); expect(target.hidden).toBe(false); assertInert();
      taskButton(card, entry.current_task_id!).click();
      expect(detail().textContent).toContain(MARKUP); assertInert();
      escapeFrom(document.activeElement ?? document.body);
    }
  });

  it.each(["native article", "explicit article role"] as const)(
    "A8 negative control restoring %s hides nested controls but emits the article", variant => {
      // Mutate an in-memory fixture only; production sources remain untouched.
      const root = document.createElement("section"), container = document.createElement("section");
      container.setAttribute("aria-label", "Agent fixture");
      const taskControl = document.createElement("button"), metadata = document.createElement("button");
      taskControl.textContent = "View task T01"; metadata.textContent = "Agent details · executor-a";
      container.append(taskControl, metadata); root.append(container);
      expect(opaqueArticlePrune(root)).toEqual(expect.arrayContaining([taskControl, metadata]));
      let opaque: HTMLElement = container;
      if (variant === "native article") {
        opaque = document.createElement("article");
        opaque.append(...container.childNodes); container.replaceWith(opaque);
      } else container.setAttribute("role", "article");
      const emitted = opaqueArticlePrune(root);
      expect(emitted).toContain(opaque);
      expect(emitted).not.toContain(taskControl);
      expect(emitted).not.toContain(metadata);
    });
});
