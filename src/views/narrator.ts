import type { createNarratorController } from "../app/narrator";
import type { ProviderErrorCode } from "../providers/types";

type NarratorSnapshot = ReturnType<ReturnType<typeof createNarratorController>["snapshot"]>;

const REASONS: Readonly<Record<ProviderErrorCode, string>> = {
  NEEDS_SETUP: "Device setup is needed. Enable the on-device model, then refresh.",
  OFFLINE: "Inference is offline. Check the connection or on-device availability, then refresh.",
  TIMEOUT: "Inference timed out. Refresh to try again.",
  SCHEMA_REJECT: "The model response could not be grounded in the current swarm. Refresh to try again.",
  BODY_TOO_LARGE: "The current context exceeds the narration limit. Use the swarm cards for details.",
  BLOCKED: "Inference is blocked by the current room policy or provider selection. Check the room settings.",
  FIREBASE_FAILED: "Firebase inference is unavailable. Check model availability, then refresh.",
  ABORTED: "The inference request was cancelled. Refresh to try again.",
  NACK: "The provider could not complete the request. Check model availability, then refresh.",
};

// Scope deduplication to the mounting host, without retaining removed views.
const lastNarration = new WeakMap<HTMLElement, string>();

export function renderNarrator(
  doc: Document, snapshot: NarratorSnapshot, onRefresh: () => void,
): HTMLElement {
  const root = doc.createElement("section");
  root.className = "narrator";
  root.setAttribute("aria-label", "Swarm narration");
  root.setAttribute("aria-busy", String(snapshot.kind === "generating"));

  const header = doc.createElement("div");
  header.className = "narrator-header";
  const title = doc.createElement("h3");
  title.className = "narrator-title";
  title.textContent = "Swarm narration";
  const refresh = doc.createElement("button");
  refresh.className = "narrator-refresh";
  refresh.type = "button";
  refresh.textContent = "Refresh narration";
  refresh.addEventListener("click", () => { onRefresh(); });
  header.append(title, refresh);

  const status = doc.createElement("p");
  status.className = "narrator-source";
  if (snapshot.kind === "generated" && snapshot.source !== null) {
    status.textContent = snapshot.source === "ON_DEVICE"
      ? "ON_DEVICE · Gemini Nano" : "IN_CLOUD · gemini-4-hydrogen · fallback";
    status.dataset["source"] = snapshot.source;
  } else {
    status.textContent = snapshot.kind === "generating" ? "Rules summary · Generating narration…" : "Rules summary";
  }
  const text = doc.createElement("p");
  text.className = "narrator-text";
  const content = doc.createTextNode(snapshot.text);
  const live = doc.createElement("span");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  // Render readable text synchronously, then move it into the connected live
  // region. A populated region inserted while detached may never be announced.
  text.append(content, live);
  const announcementKey = JSON.stringify([snapshot.text, snapshot.kind, snapshot.source, snapshot.reason]);
  queueMicrotask(() => {
    const host = root.parentElement;
    if (!root.isConnected || host === null || lastNarration.get(host) === announcementKey) return;
    lastNarration.set(host, announcementKey);
    live.append(content);
  });
  root.append(header, status, text);
  if (snapshot.reason !== undefined) {
    const reason = doc.createElement("p");
    reason.className = "narrator-reason";
    reason.textContent = REASONS[snapshot.reason];
    root.append(reason);
  }
  return root;
}
