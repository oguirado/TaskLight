import type { DevicePort, WallView } from "./types";

export interface Onboarding {
  render(v: WallView, failed: boolean): void;
  dispose(): void;
}

/** Builds the onboarding panel inside `panel`; CTA click -> device.activate(true) once trusted, deduplicated. */
export function createOnboarding(
  panel: HTMLElement,
  device: DevicePort,
  opts?: { isTrusted?: (ev: Event) => boolean },
): Onboarding {
  const isTrusted = opts?.isTrusted ?? ((ev: Event) => ev.isTrusted);
  let activated = false;
  let dismissed = false;
  let disposed = false;

  const wrap = document.createElement("div");
  wrap.setAttribute("data-role", "onboarding-panel");

  const copy = document.createElement("p");
  copy.textContent =
    "Run the on-device model: needs more than 4 GB VRAM or 16 GB RAM + 4 cores and 22 GB free. " +
    "The download may take minutes. PREFER_* tasks continue via cloud meanwhile.";

  const retry = document.createElement("p");
  retry.textContent = "The download failed. Try again when ready.";
  retry.setAttribute("hidden", "");

  const cta = document.createElement("button");
  cta.setAttribute("type", "button");
  cta.setAttribute("data-role", "enable-cta");
  cta.textContent = "Enable on-device model";

  const cont = document.createElement("button");
  cont.setAttribute("type", "button");
  cont.setAttribute("data-action", "continue-cloud");
  cont.textContent = "Continue with cloud";

  const bar = document.createElement("div");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", "0");
  bar.setAttribute("aria-label", "Model download progress");
  const barLabel = document.createElement("span");
  barLabel.textContent = "0%";
  bar.appendChild(barLabel);

  wrap.appendChild(copy);
  wrap.appendChild(retry);
  wrap.appendChild(cta);
  wrap.appendChild(cont);
  wrap.appendChild(bar);
  panel.appendChild(wrap);

  function onCta(ev: MouseEvent): void {
    if (disposed || dismissed) return;
    if (!isTrusted(ev)) return;
    if (activated) return;
    activated = true;
    try {
      Promise.resolve(device.activate(true)).catch(() => undefined);
    } catch {
      // Activation failure is consumed; deduplication is preserved.
    }
  }

  function onCont(): void {
    if (disposed) return;
    dismissed = true;
    wrap.setAttribute("hidden", "");
  }

  cta.addEventListener("click", onCta);
  cont.addEventListener("click", onCont);

  function render(v: WallView, failed: boolean): void {
    if (disposed) return;
    if (failed) retry.removeAttribute("hidden");
    else retry.setAttribute("hidden", "");
    if (dismissed) {
      cta.setAttribute("hidden", "");
      bar.setAttribute("hidden", "");
      return;
    }
    if (v.showEnableCta) cta.removeAttribute("hidden");
    else cta.setAttribute("hidden", "");
    if (v.progressPct !== null) {
      bar.removeAttribute("hidden");
      bar.setAttribute("aria-valuenow", String(v.progressPct));
      barLabel.textContent = `${v.progressPct}%`;
    } else {
      bar.setAttribute("hidden", "");
    }
  }

  function dispose(): void {
    disposed = true;
    cta.removeEventListener("click", onCta);
    cont.removeEventListener("click", onCont);
  }

  return { render, dispose };
}
