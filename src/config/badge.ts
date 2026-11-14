import type { BadgeModel } from "./types";

export function renderBadge(el: HTMLElement, b: BadgeModel): void {
  el.textContent = b.text;
  el.setAttribute("data-config-gen", String(b.gen));
  el.setAttribute("data-cloud-off", b.cloudOff ? "true" : "false");
  el.setAttribute("data-live", b.live);
}
