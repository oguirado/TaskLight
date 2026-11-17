/** A bounded fixture for opaque-article pruning by an accessibility-tree automation client.
 * DOM-derived records test the structural contract; they are not a browser AX receipt.
 */
export function opaqueArticlePrune(root: HTMLElement): readonly HTMLElement[] {
  const emitted: HTMLElement[] = [];
  function visit(node: HTMLElement): void {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return;
    emitted.push(node);
    const roles = (node.getAttribute("role") ?? "").split(/\s+/);
    // Emit the article itself, but never traverse its descendants.
    if (node.localName === "article" || roles.includes("article")) return;
    for (const child of node.children) visit(child as HTMLElement);
  }
  visit(root);
  return emitted;
}
