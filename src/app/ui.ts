import type { HostState } from "./types";

/** Collects the replay fixture + stale badge so B16 content survives a state re-render. */
function collectReplayNodes(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("#replay-fixture, .stale-badge")];
}

/**
 * Renders state into root. blocked/degraded: element with role="alert" whose text contains the reason code.
 * B16: replay/stale content is preserved (existing nodes re-attached, or a fixture rendered) instead of blanking.
 */
export function renderHostState(root: HTMLElement, s: HostState): void {
  const preserved = collectReplayNodes(root);
  root.replaceChildren();
  if (s.kind === "blocked" || s.kind === "degraded") {
    const el = document.createElement("div");
    el.setAttribute("role", "alert");
    el.textContent = s.kind === "blocked" ? `Blocked: ${s.reason}` : `Degraded: ${s.reason} (local mode)`;
    root.appendChild(el);
    for (const node of preserved) root.appendChild(node);
    if (root.querySelector("#replay-fixture") === null || root.querySelector(".stale-badge") === null) {
      const fixture = document.createElement("section");
      fixture.id = "replay-fixture";
      fixture.textContent = "Replay fixture: replay of the last session (stale content shown while cloud is unavailable)";
      root.appendChild(fixture);
      const stale = document.createElement("span");
      stale.className = "stale-badge";
      stale.textContent = "stale";
      root.appendChild(stale);
    }
    return;
  }
  for (const node of preserved) root.appendChild(node);
  if (s.kind === "booting") {
    const el = document.createElement("div");
    el.textContent = "Booting…";
    root.appendChild(el);
    return;
  }
  const el = document.createElement("div");
  el.textContent = `Ready ${s.uid} ${s.appCheck} ${s.deviceModel}`;
  root.appendChild(el);
}
