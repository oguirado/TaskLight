/** Shared U153 oracle fixture. Normalized sample trees are not live browser receipts. */
export interface AccessibilityNode {
  readonly role: string;
  readonly name: string;
  readonly children?: readonly AccessibilityNode[];
}
export type ReceiptLane = "raw-cdp" | "pruned-cdp" | "at-spi";
export interface AccessibilityReceipt {
  readonly lane: ReceiptLane;
  readonly tree: readonly AccessibilityNode[] | null;
}
export type ReceiptVerdict =
  | { readonly status: "failed_precondition"; readonly reason: string }
  | { readonly status: "fail"; readonly lane: ReceiptLane; readonly missing: readonly string[] }
  | { readonly status: "pass"; readonly lane: ReceiptLane };

/** Emit an article, then stop descending. Preserve input order and input objects. */
export function pruneOpaqueArticles(tree: readonly AccessibilityNode[]): AccessibilityNode[] {
  return tree.map(node => ({
    ...node,
    ...(node.children === undefined ? {} : {
      children: node.role.toLowerCase() === "article" ? [] : pruneOpaqueArticles(node.children),
    }),
  }));
}

/** DOM surrogate for the same pruning boundary, not a DOM-to-accessibility adapter. */
export function elementsAfterOpaqueArticlePruning(root: Element): readonly Element[] {
  const result: Element[] = [];
  const visit = (element: Element): void => {
    result.push(element);
    const role = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase()
      ?? (element.tagName.toLowerCase() === "article" ? "article" : "");
    if (role === "article") return;
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
}

function flatten(tree: readonly AccessibilityNode[]): AccessibilityNode[] {
  return tree.flatMap(node => [node, ...flatten(node.children ?? [])]);
}
const normalizedRole = (role: string): string => role.toLowerCase().replace(/[\s_-]/g, "");
const documentRoles = new Set(["rootwebarea", "webarea", "document", "documentweb", "documentframe"]);
const shellRoles = new Set(["application", "browser", "frame", "window", "generic", ...documentRoles]);

/**
 * Test-local receipt gate: availability is checked before assertions, separately per lane.
 * A browser/application shell alone does not establish renderer accessibility.
 */
export function gateAccessibilityReceipt(
  receipt: AccessibilityReceipt | null | undefined,
  requiredNames: readonly string[],
): ReceiptVerdict {
  if (receipt == null || receipt.tree == null || receipt.tree.length === 0) {
    return { status: "failed_precondition", reason: "Accessibility tree is absent or empty" };
  }
  const nodes = flatten(receipt.tree);
  const contentAvailable = nodes.some(node => documentRoles.has(normalizedRole(node.role))
    && flatten(node.children ?? []).some(child => !shellRoles.has(normalizedRole(child.role))));
  if (!contentAvailable) {
    return { status: "failed_precondition", reason: "Document accessibility content is unavailable" };
  }
  if (requiredNames.length === 0 || requiredNames.some(name => name.trim().length === 0)) {
    return { status: "failed_precondition", reason: "No nonempty acceptance targets were supplied" };
  }
  const names = new Set(nodes.map(node => node.name));
  const missing = requiredNames.filter(name => !names.has(name));
  return missing.length > 0
    ? { status: "fail", lane: receipt.lane, missing }
    : { status: "pass", lane: receipt.lane };
}

export const PRUNING_FIXTURE: readonly AccessibilityNode[] = [{
  role: "RootWebArea", name: "TaskLight", children: [{
    role: "article", name: "Task T01", children: [
      { role: "button", name: "T01.M01 · Inspect task" },
      { role: "button", name: "View task T01" },
    ],
  }, {
    role: "region", name: "Agent executor-a", children: [
      { role: "button", name: "Agent details · executor-a" },
    ],
  }],
}];
