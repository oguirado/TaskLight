import { describe, expect, it } from "vitest";
import {
  PRUNING_FIXTURE, elementsAfterOpaqueArticlePruning, gateAccessibilityReceipt, pruneOpaqueArticles,
} from "./pruning_fixture";
import type { AccessibilityNode, ReceiptLane } from "./pruning_fixture";

const lanes = ["raw-cdp", "pruned-cdp", "at-spi"] as const;
const target = ["T01.M01 · Inspect task"];

describe("U153 A3/A7/A8 shared receipt oracle calibration", () => {
  it.each(lanes)("A7 %s: an empty tree fails the precondition, including an empty expectation list", lane => {
    for (const expected of [target, []]) {
      expect(gateAccessibilityReceipt({ lane, tree: [] }, expected).status).toBe("failed_precondition");
    }
  });
  it.each(lanes)("A7 %s: an absent tree is not a successful empty audit", lane => {
    expect(gateAccessibilityReceipt({ lane, tree: null }, target).status).toBe("failed_precondition");
  });
  it("A7 absent receipt and browser-only exposure stop before content assertions", () => {
    expect(gateAccessibilityReceipt(undefined, target).status).toBe("failed_precondition");
    expect(gateAccessibilityReceipt(null, target).status).toBe("failed_precondition");
    for (const tree of [
      [{ role: "application", name: "Browser" }],
      [{ role: "application", name: "Browser", children: [{ role: "RootWebArea", name: "TaskLight" }] }],
    ]) {
      expect(gateAccessibilityReceipt({ lane: "at-spi", tree }, target).status).toBe("failed_precondition");
    }
  });
  it("A7 an available tree with no acceptance targets cannot pass vacuously", () => {
    for (const expected of [[], [" "]]) {
      expect(gateAccessibilityReceipt({ lane: "raw-cdp", tree: PRUNING_FIXTURE }, expected).status)
        .toBe("failed_precondition");
    }
  });
  it.each(lanes)("A3 %s: actual document content and a present target pass independently", lane => {
    expect(gateAccessibilityReceipt({ lane, tree: PRUNING_FIXTURE }, target)).toEqual({ status: "pass", lane });
  });
  it("A3 raw CDP success cannot substitute for pruned CDP or AT-SPI receipts", () => {
    const receipts = [
      { lane: "raw-cdp", tree: PRUNING_FIXTURE },
      { lane: "pruned-cdp", tree: pruneOpaqueArticles(PRUNING_FIXTURE) },
      { lane: "at-spi", tree: [] },
    ] satisfies readonly { lane: ReceiptLane; tree: readonly AccessibilityNode[] }[];
    expect(receipts.map(receipt => gateAccessibilityReceipt(receipt, target).status))
      .toEqual(["pass", "fail", "failed_precondition"]);
  });
  it("A8 pruning emits the article, drops its descendants and preserves non-article controls", () => {
    const before = JSON.stringify(PRUNING_FIXTURE);
    const pruned = pruneOpaqueArticles(PRUNING_FIXTURE);
    expect(pruned[0]?.children?.[0]).toEqual({ role: "article", name: "Task T01", children: [] });
    expect(gateAccessibilityReceipt({ lane: "pruned-cdp", tree: pruned }, target))
      .toEqual({ status: "fail", lane: "pruned-cdp", missing: target });
    expect(gateAccessibilityReceipt({ lane: "pruned-cdp", tree: pruned }, ["Agent details · executor-a"]).status)
      .toBe("pass");
    expect(JSON.stringify(PRUNING_FIXTURE)).toBe(before);
  });
  it.each(["article", "explicit-article", "region"])("A8 DOM surrogate respects the %s boundary", kind => {
    const root = document.createElement("main");
    const card = document.createElement(kind === "article" ? "article" : "section");
    card.setAttribute("role", kind === "region" ? "region" : "article");
    const button = document.createElement("button"); button.textContent = target[0]!;
    card.append(button); root.append(card);
    const emitted = elementsAfterOpaqueArticlePruning(root);
    expect(emitted).toContain(card);
    expect(emitted.includes(button)).toBe(kind === "region");
  });
});
