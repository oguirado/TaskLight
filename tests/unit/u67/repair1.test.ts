import { describe, expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { canonicalStarterTemplateHash } from "../../../src/app/starter_templates";
import { event, feed, opening, template, wall } from "./helpers";

function neutralTemplate() {
  const t = { ...template("web-app"), id: "neutral" };
  t.hash = canonicalStarterTemplateHash(t);
  return t;
}

function neutralEvents(t = neutralTemplate()) {
  return [event(1, opening(t)), event(2, {
    kind: "task.add", title: "Discover requirements", type: t.task_types[0]!.id,
    phase: "discovery", accept: "Verified",
    microtasks: [{ text: "Gather requirements", accept: "Verified" }],
  })];
}

describe("U67 repair: resolved neutral template precedence", () => {
  it("uses resolved web-app phases, labels and exits in order with discovery active", () => {
    const t = neutralTemplate();
    const events = neutralEvents(t);
    expect(events[0]!.op).not.toHaveProperty("phase");
    const store = feed(createAgentStore({ templates: () => t }), events);
    expect(store.plan("oracle")?.projection.plan?.phase).toBe("discovery");
    expect(wall(store).plan?.phases).toEqual(
      t.phases.map(p => ({ ...p, active: p.id === "discovery" })),
    );
  });

  it("keeps built-in neutral phases when the resolver returns no template", () => {
    const store = feed(createAgentStore({ templates: () => undefined }), neutralEvents());
    expect(wall(store).plan?.phases).toEqual([
      { id: "start", label: "Start", exit: "Ready", active: false },
      { id: "finish", label: "Finish", exit: "Complete", active: false },
    ]);
  });
});
