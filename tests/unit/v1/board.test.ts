import { describe, expect, it } from "vitest";
import { agent, board, bubble, deterministic, freeze, HOSTILE, identity, lane, micro, microNode,
  mounted, name, render, task, text, tree, visible, visibleText } from "./helpers";

deterministic();

describe("V1 M2 inventory header", () => {
  it("M2 sums waiting idle registered, keeps finished separate, and includes nonzero failed unknown", () => {
    const states = ["working", "working", "waiting", "idle", "registered", "finished", "failed", "unknown"] as const;
    const vm = board(states.map((state, i) => agent(`worker-${i}`, { state, tasks: [], current_task_id: null })));
    const root = render(vm);
    const regions = [...root.querySelectorAll<HTMLElement>('[aria-live="polite"],[role="status"]')]
      .filter(n => text(n).includes("2 working"));
    expect(regions, "M2 one polite inventory summary").toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-live") ?? "polite").toBe("polite");
    expect(text(regions[0]!)).toBe("2 working · 3 waiting · 1 finished · 1 failed · 1 unknown");
    expect(regions[0]!.querySelector("br")).toBeNull();
  });

  it("M2 zero failed unknown are omitted and a genuine empty healthy room has zero totals", () => {
    const root = render(board([]));
    const summary = [...root.querySelectorAll<HTMLElement>('[aria-live="polite"],[role="status"]')]
      .find(n => text(n) === "0 working · 0 waiting · 0 finished");
    expect(summary, "M2 zero inventory is a known count").toBeDefined();
    expect(text(summary!)).not.toMatch(/failed|unknown/);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("M2 a refresh publishes one summary change and an unchanged refresh does not reannounce", async () => {
    const vm = board([agent("worker", { state: "registered", activity: "idle", tasks: [] })]);
    const wall = mounted(vm);
    const summaries = () => [...wall.host.querySelectorAll<HTMLElement>('[aria-live="polite"],[role="status"]')]
      .filter(n => /\d+ working · \d+ waiting · \d+ finished/.test(text(n)));
    expect(summaries(), "M2 a single live summary exists before observing updates").toHaveLength(1);
    const observed: string[] = [];
    const observer = new MutationObserver(records => {
      for (const region of summaries()) {
        if (records.some(r => region.contains(r.target) || r.target === region ||
          [...r.addedNodes].some(n => n === region || n.contains(region)))) observed.push(text(region));
      }
    });
    observer.observe(wall.host, { subtree: true, childList: true, characterData: true });
    try {
      wall.update(board([agent("worker", { tasks: [] })]));
      await Promise.resolve();
      expect(summaries()).toHaveLength(1);
      expect(text(summaries()[0]!)).toBe("1 working · 0 waiting · 0 finished");
      expect(observed, "M2 changed inventory is announced once").toEqual(["1 working · 0 waiting · 0 finished"]);
      observed.length = 0;
      wall.update(board([agent("worker", { tasks: [] })]));
      await Promise.resolve();
      expect(observed, "M2 unchanged inventory is silent").toEqual([]);
    } finally { observer.disconnect(); }
  });
});

describe("V1 M3 lanes", () => {
  it("M3 preserves inventory order despite lexical and legacy activity grouping order", () => {
    const vm = tree(), root = render(vm);
    const identities = vm.agents.map(a => identity(root, a.agent));
    const inDOMOrder = [...identities].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    expect(inDOMOrder).toEqual(identities);
    expect(new Set(vm.agents.map(a => lane(root, a.agent))).size).toBe(vm.agents.length);
  });

  it("M3 children and grandchildren are inside their own parent lane, never sibling roots", () => {
    const root = render(tree()), parent = lane(root, "z-lead"), child = lane(root, "b-child"), leaf = lane(root, "a-leaf");
    expect(parent.contains(child), "Negative control: flat children must fail").toBe(true);
    expect(child.contains(leaf)).toBe(true);
    expect(parent.contains(lane(root, "a-root"))).toBe(false);
  });

  it("M3 every lane exposes harness and inventory state without opening agent metadata", () => {
    const vm = tree(), root = render(vm);
    for (const a of vm.agents) {
      const contents = visibleText(lane(root, a.agent));
      expect(contents).toContain(a.harness);
      expect(contents.toLowerCase()).toContain(a.state);
    }
  });

  it("M3 renders all owned tasks in plan order", () => {
    const vm = tree(), root = render(vm), lead = lane(root, "z-lead");
    const buttons = vm.agents[0]!.tasks.map(t => bubble(lead, t.title));
    expect(buttons[0]!.compareDocumentPosition(buttons[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  });
  it("M3 retains taskless inventory agents with No tasks yet", () => {
    const vm = tree(), root = render(vm);
    for (const a of vm.agents.slice(1)) expect(visibleText(lane(root, a.agent))).toContain("No tasks yet");
  });
});

describe("V1 M4 task and microtask semantics", () => {
  it("M4 every task, including a noncurrent task, is a collapsed named disclosure", () => {
    const vm = board(), root = render(vm);
    for (const t of vm.agents[0]!.tasks) {
      const button = bubble(root, t.title);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(name(button)).toContain(`${t.title}, ${t.state}, ${t.microtasks.filter(m => m.state === "done").length}/${t.microtasks.length}`);
    }
    expect([...root.querySelectorAll<HTMLElement>("*")].some(n => visible(n) && name(n).includes("Micro T09.M04"))).toBe(false);
  });

  it("M4 expansion exposes every microtask title state and completion alternative", () => {
    const t = task(), root = render(), button = bubble(root, t.title); button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const nodes = t.microtasks.map(m => {
      const node = microNode(root, m.text);
      expect(name(node)).toContain(`${m.text}, ${m.state}, ${m.state === "done" ? 1 : 0}/1`);
      return node;
    });
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(nodes.every(n => !n.isConnected || !visible(n))).toBe(true);
  });

  it.each([
    [[], "active", "0/0"],
    [[micro("T09.M01", "done"), micro("T09.M02", "pending")], "active", "1/2"],
    [[micro("T09.M01", "done"), micro("T09.M02", "done")], "done", "2/2"],
  ] as const)("M4 completion alternative handles %j without assuming completion from lifecycle", (micros, state, fraction) => {
    const t = task("T09", { state, microtasks: micros });
    const root = render(board([agent("z-lead", { lifecycle: "finished", state: "finished", tasks: [t] })]));
    expect(name(bubble(root, t.title))).toContain(`${t.title}, ${state}, ${fraction}`);
    expect(root.outerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("M4 hostile task microtask and harness strings remain passive text; rendering cannot mutate the snapshot", () => {
    const t = task("T09", { title: HOSTILE, microtasks: [micro("T09.M01", "pending", HOSTILE + " micro")] });
    const vm = freeze(board([agent("z-lead", { tasks: [t], harness: HOSTILE + " harness" })]));
    const before = JSON.stringify(vm), root = render(vm);
    expect(root.querySelector("img,script,iframe,[onerror],[onclick]")).toBeNull();
    expect(JSON.stringify(vm)).toBe(before);
    bubble(root, HOSTILE).click();
    expect(name(microNode(root, HOSTILE + " micro"))).toContain(HOSTILE + " micro");
    expect(root.querySelector("img,script,iframe,[onerror],[onclick]")).toBeNull();
    expect(JSON.stringify(vm)).toBe(before);
  });
});

describe("V1 M5 agent failure is independent of task states", () => {
  it.each(["failed", "unknown"] as const)("M5 %s has a name marker and preserves authoritative task and microtask states", state => {
    const t = task(), a = agent("z-lead", { state, lifecycle: state === "failed" ? "failed" : "alive", tasks: [t] });
    const root = render(board([a])), row = lane(root, a.agent);
    const marker = state === "failed" ? "×" : "?";
    expect(text(identity(root, a.agent).parentElement!), "M5 marker beside agent identity").toContain(marker);
    const button = bubble(row, t.title);
    expect(name(button)).toContain(`${t.title}, active, 1/4`); button.click();
    for (const m of t.microtasks) expect(name(microNode(row, m.text))).toContain(`${m.text}, ${m.state},`);
  });
});
