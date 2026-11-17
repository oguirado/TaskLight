import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncNotice } from "../../../src/views/sync_notice";
import type { SyncFault, SyncNotice } from "../../../src/views/sync_notice";

let parent: HTMLElement;
let notice: SyncNotice;
beforeEach(() => {
  parent = document.createElement("main"); parent.className = "app";
  document.body.append(parent); notice = createSyncNotice(parent);
});
afterEach(() => { document.body.replaceChildren(); document.documentElement.removeAttribute("data-theme"); });

function uncertaintyProblems(element: HTMLElement | null, room: string): string[] {
  if (!element || !parent.contains(element)) return ["fault disappeared before recovery"];
  const problems: string[] = [];
  if (element.getAttribute("role") !== "status") problems.push("status role missing");
  if (element.getAttribute("aria-live") !== "polite") problems.push("polite live region missing");
  if (!element.textContent?.startsWith("Progress may be outdated — ") || !element.textContent.includes(room)) problems.push("uncertainty/room missing");
  if (element.querySelector("button, a, input, select, textarea, [role=button], [tabindex], img, script, iframe, [onerror], [onclick]")) {
    problems.push("executable markup or fabricated action");
  }
  return problems;
}

describe("A4 / M6 existing SyncNotice public contract", () => {
  it("A4 displays the exact valid Lamport interval and status/live-region attributes", () => {
    const faults: readonly SyncFault[] = [{ room: "demo", fromLamport: 7, toLamport: 9 }];
    notice.update(faults);
    expect(notice.element()?.textContent).toBe("Progress may be outdated — demo: excluded Lamport 7 to 9.");
    expect(uncertaintyProblems(notice.element(), "demo")).toEqual([]);
  });
  it("A4 repeating the same signature creates no duplicate, replacement or live-region mutation", () => {
    notice.update([{ room: "demo", fromLamport: 7, toLamport: 9 }]);
    const node = notice.element()!;
    const observer = new MutationObserver(() => undefined); observer.observe(parent, { childList: true, subtree: true, characterData: true });
    notice.update([{ room: "demo", fromLamport: 7, toLamport: 9 }]);
    expect(notice.element()).toBe(node); expect(parent.children).toHaveLength(1);
    expect(observer.takeRecords()).toEqual([]); observer.disconnect();
  });
  it("A4 unknown range says replay required; only update([]) detaches and a new gap can reattach", () => {
    notice.update([{ room: "demo" }]);
    expect(notice.element()?.textContent).toBe("Progress may be outdated — demo: replay required.");
    notice.update([]); expect(notice.element()).toBeNull(); expect(parent.childNodes).toHaveLength(0);
    notice.update([{ room: "demo" }]); expect(uncertaintyProblems(notice.element(), "demo")).toEqual([]);
  });
  it("M6 sorts room/range text and deduplicates equivalent reordered input without mutating callers", () => {
    const a = Object.freeze({ room: "alpha", fromLamport: 2, toLamport: 4 });
    const z = Object.freeze({ room: "zeta" }); const input = Object.freeze([z, a]);
    notice.update(input);
    const node = notice.element()!;
    expect(node.textContent).toBe("Progress may be outdated — alpha: excluded Lamport 2 to 4; zeta: replay required.");
    const observer = new MutationObserver(() => undefined); observer.observe(node, { childList: true, characterData: true, subtree: true });
    notice.update([a, z]); expect(observer.takeRecords()).toEqual([]); observer.disconnect();
    expect(input).toEqual([z, a]); expect(notice.element()).toBe(node);
  });
  it("M6 has the stable .sync-notice styling hook", () => {
    notice.update([{ room: "demo" }]); expect(notice.element()?.classList.contains("sync-notice")).toBe(true);
  });
  it("M6 owns .sync-notice styling in the existing view stylesheet", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../../styles/views.css"), "utf8");
    const style = document.createElement("style"); style.textContent = css; document.head.append(style);
    const matches = (rules: CSSRuleList): boolean => [...rules].some(rule => {
      if (rule instanceof CSSStyleRule) return /\.sync-notice\b/.test(rule.selectorText) && rule.style.length > 0;
      return "cssRules" in rule && matches((rule as CSSMediaRule).cssRules);
    });
    try { expect(matches(style.sheet!.cssRules)).toBe(true); } finally { style.remove(); }
  });
  it("M6 theme changes do not clear or replace component uncertainty", () => {
    notice.update([{ room: "demo" }]); const node = notice.element();
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      expect(notice.element()).toBe(node); expect(uncertaintyProblems(node, "demo")).toEqual([]);
    }
    // Real route persistence is an integration precondition; this is component ownership only.
    parent.dataset.view = "diary"; expect(notice.element()).toBe(node);
    notice.update([]); expect(notice.element()).toBeNull();
  });
});

describe("A5 / M6 hostile text and invalid ranges", () => {
  it("A5 renders the entire markup-like room literally, without images, handlers or recovery controls", () => {
    const room = "<img src=x onerror=alert(1)>"; notice.update([{ room }]);
    expect(notice.element()?.textContent).toBe(`Progress may be outdated — ${room}: replay required.`);
    expect(uncertaintyProblems(notice.element(), room)).toEqual([]);
    expect(parent.querySelector("img, [onerror]")).toBeNull();
  });
  it("A5 retains an unbroken 120-character room verbatim", () => {
    const room = "r".repeat(120); notice.update([{ room }]);
    expect(notice.element()?.textContent).toBe(`Progress may be outdated — ${room}: replay required.`);
    expect(uncertaintyProblems(notice.element(), room)).toEqual([]);
  });
  it.each([
    ["reversed", 9, 7], ["negative start", -1, 9], ["negative end", 7, -1],
    ["fractional start", 7.5, 9], ["fractional end", 7, 9.5],
    ["NaN start", NaN, 9], ["NaN end", 7, NaN], ["infinite end", 7, Infinity],
    ["unsafe integer", 7, Number.MAX_SAFE_INTEGER + 1],
  ] as const)("A5/B5 %s preserves uncertainty without asserting an invalid excluded interval", (_label, fromLamport, toLamport) => {
    notice.update([{ room: "demo", fromLamport, toLamport }]);
    expect(uncertaintyProblems(notice.element(), "demo")).toEqual([]);
    // No new validation API or exact fallback wording is mandated. A false interval is forbidden.
    expect(notice.element()?.textContent).not.toContain(`excluded Lamport ${String(fromLamport)} to ${String(toLamport)}`);
  });
  it.each([{ room: "demo", fromLamport: 7 }, { room: "demo", toLamport: 9 }])(
    "A5 incomplete interval uses existing replay uncertainty: %j", fault => {
      notice.update([fault]); expect(notice.element()?.textContent).toBe("Progress may be outdated — demo: replay required.");
    });
  it("A6 negative M6 detects fabricated recovery and disappearance before update([])", () => {
    notice.update([{ room: "demo" }]); const node = notice.element()!;
    expect(uncertaintyProblems(node, "demo")).toEqual([]);
    const dismiss = document.createElement("button"); dismiss.textContent = "Dismiss"; node.append(dismiss);
    expect(uncertaintyProblems(node, "demo")).toContain("executable markup or fabricated action");
    dismiss.remove(); node.remove();
    expect(uncertaintyProblems(node, "demo")).toContain("fault disappeared before recovery");
  });
  it("A6 negative M6 detects an innerHTML substitution with the same hostile oracle", () => {
    const room = "<img src=x onerror=alert(1)>"; notice.update([{ room }]); const node = notice.element()!;
    expect(uncertaintyProblems(node, room)).toEqual([]);
    node.innerHTML = `Progress may be outdated — ${room}: replay required.`;
    expect(uncertaintyProblems(node, room)).toContain("executable markup or fabricated action");
  });
});
