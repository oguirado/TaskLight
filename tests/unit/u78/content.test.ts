import { describe, expect, it } from "vitest";
import { memory, memoryText, mounted, q, setup, vm } from "./helpers";

setup();
function memoryWall(view: "memory" | "diary") {
  return mounted({ ...vm(), view, memory, diary: [{ kind: "memory", day: "Today", at: "09:00", title: "Decisions", author: "builder", outcome: memoryText }] }).host;
}
describe("A6 / M6 full-width memory text", () => {
  it.each(["memory", "diary"] as const)("%s preserves newlines and wraps long words", view => {
    const host = memoryWall(view);
    const node = [...host.querySelectorAll<HTMLElement>("main *")].find(n => n.childElementCount === 0 && n.textContent === memoryText);
    expect(node, "memory text appears verbatim including line breaks").toBeDefined();
    const style = getComputedStyle(node!);
    expect(style.whiteSpace).toMatch(/pre-wrap|pre-line|break-spaces/);
    expect(`${style.overflowWrap} ${style.wordBreak}`).toMatch(/anywhere|break-word|break-all/);
  });
  it.each(["memory", "diary"] as const)("%s has no reading-width cap on text or its panel", view => {
    const host = memoryWall(view);
    let node = [...host.querySelectorAll<HTMLElement>("main *")].find(n => n.childElementCount === 0 && n.textContent === memoryText);
    expect(node).toBeDefined();
    // The app-wide content maximum is allowed; the text and reading panels are not narrowed further.
    while (node && node.parentElement?.tagName !== "MAIN") {
      const style = getComputedStyle(node);
      expect(style.maxWidth, `${node.className} must use available content width`).not.toMatch(/reading-max|^\d+(px|rem|em|ch)$/);
      node = node.parentElement ?? undefined;
    }
  });
});
describe("A7 / M7 human labels", () => {
  it("memory metadata labels revision, author and time together", () => {
    const host = memoryWall("memory");
    expect(q(host, ".memory-panel").textContent).toMatch(/rev 12, by builder, 09:00/);
  });
  it("hostile memory metadata remains literal text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const host = mounted({ ...vm(), view: "memory", memory: { sections: [{ ...memory.sections[0]!, by: hostile, text: hostile }] } }).host;
    expect(q(host, ".memory-panel").textContent).toContain(hostile);
    expect(host.querySelector("img, script, [onerror]")).toBeNull();
  });
  it.each([1, 3])("Archive labels unknown duration and %s task count", count => {
    const host = mounted({ ...vm(), view: "archive", archive: [{ id: "old", planId: "old", workspace: "oracle", project: "Plan", accent: "sky", title: "Finished", archived: "Yesterday", took: "unavailable", steps: 9, taskCount: count, outcome: "Done", source: { kind: "rules", ms: 0 } }] }).host;
    const archive = q(host, ".archived"); expect(archive.textContent).toContain("Duration unknown");
    expect(archive.textContent).not.toContain("unavailable");
    expect(archive.textContent).toMatch(new RegExp(`\\b${count} task${count === 1 ? "" : "s"}\\b`));
  });
  it("legacy Archive count labels the actual steps field", () => {
    const host = mounted({ ...vm(), view: "archive", archive: [{ id: "old", workspace: "oracle", project: "Old", accent: "sky", title: "Done", archived: "Yesterday", took: "2 min", steps: 3, outcome: "Verified", source: { kind: "rules", ms: 0 } }] }).host;
    expect(q(host, ".archived").textContent).toMatch(/3 steps/);
  });
});
