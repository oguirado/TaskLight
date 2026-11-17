import { expect } from "vitest";

const LIVE = '[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]';
export const normalized = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();

/** Observe live text mutations, not populated-region insertion. This is a DOM
 * prerequisite for announcement, not a simulated screen-reader transcript. */
export function watchLiveUpdates(doc: Document) {
  const established = new Set<Element>(doc.querySelectorAll(LIVE));
  const messages: string[] = [];
  let overflow = false;
  let batches = 0;
  const observer = new MutationObserver(records => {
    // Runner safety bound, not a product performance requirement.
    if (++batches > 1_000) { overflow = true; observer.disconnect(); return; }
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const region = target?.closest(LIVE);
      if (region && established.has(region) && region.isConnected
        && !region.closest('[hidden], [aria-hidden="true"], [data-open="false"]')) {
        const value = normalized(region);
        if (value) messages.push(value);
      }
      // Process in record order: an empty region mounted and then populated is
      // valid; text assigned while detached, before insertion, is not a change.
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || !node.isConnected) continue;
        if (node.matches(LIVE)) established.add(node);
        for (const child of node.querySelectorAll(LIVE)) established.add(child);
      }
    }
  });
  observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
  return {
    messages,
    clear(): void { messages.length = 0; },
    healthy(): void { expect(overflow, "Live-region observation must settle within the runner safety bound").toBe(false); },
    stop(): void { observer.disconnect(); },
  };
}
export function requireAnnouncement(messages: readonly string[], text: string): void {
  expect(messages.some(message => message.includes(text.replace(/\s+/g, " ").trim())),
    `A connected live region must change to announce: ${text}`).toBe(true);
}
