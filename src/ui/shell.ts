import type {
  CapsuleCardView, LensFilter, PlanStep, UiOptions, WallInputs, WallMode,
  WallUi, WallUiState, WallView,
} from "./types";
import { UI_LIMITS } from "./limits";
import { BANNER_TEXT, resolveWallMode } from "./state";
import { createAnnouncer } from "./announcer";
import { createKeyboardNav } from "./keyboard";
import { createOnboarding } from "./onboarding";
import { getLens } from "../lens";

function el<K extends "div" | "span" | "p" | "button">(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

const BADGE_BY_MODE: Readonly<Record<WallMode, string>> = {
  booting: "Starting",
  blocked: "Blocked",
  offline: "Offline",
  kill_switch: "Cloud disabled",
  no_model: "Cloud only",
  needs_gesture: "Cloud",
  downloading: "Downloading",
  cloud_fallback: "Cloud fallback",
  on_device: "On device",
};

export function createWallUi(o: UiOptions): WallUi {
  const root = o.root;
  let container = root.querySelector<HTMLElement>("[data-wall-container]");
  if (container === null) {
    container = el("div");
    container.setAttribute("data-wall-container", "");
    root.appendChild(container);
  }
  container.setAttribute("role", "list");
  container.setAttribute("tabindex", "-1");

  const onboardingRegion = el("div");
  onboardingRegion.setAttribute("data-region", "onboarding");
  const lensRegion = el("div");
  lensRegion.setAttribute("data-region", "lens-switcher");
  const toolsRegion = el("div");
  toolsRegion.setAttribute("data-region", "tools");
  const wallRegion = el("div");
  wallRegion.setAttribute("data-region", "wall");

  root.insertBefore(wallRegion, container);
  root.insertBefore(toolsRegion, wallRegion);
  root.insertBefore(lensRegion, toolsRegion);
  root.insertBefore(onboardingRegion, lensRegion);
  wallRegion.appendChild(container);

  const banner = el("div");
  banner.setAttribute("data-role", "wall-banner");
  const badge = el("div");
  badge.setAttribute("data-role", "wall-badge");
  const focusBanner = el("div");
  focusBanner.setAttribute("data-role", "focus-banner");
  focusBanner.setAttribute("hidden", "");
  const legend = el("div");
  legend.setAttribute("data-role", "status-legend");
  const live = el("div");
  const alertPanel = el("div");
  alertPanel.setAttribute("role", "alert");
  alertPanel.setAttribute("data-role", "template-error");
  alertPanel.setAttribute("hidden", "");
  alertPanel.textContent = "";

  wallRegion.insertBefore(alertPanel, container);
  wallRegion.insertBefore(legend, container);
  wallRegion.insertBefore(focusBanner, container);
  wallRegion.insertBefore(badge, container);
  wallRegion.insertBefore(banner, container);
  wallRegion.insertBefore(live, container);

  const lensButtons = new Map<string, HTMLButtonElement>();
  for (const lens of ["all", "dev", "study"] as const) {
    const b = el("button");
    b.setAttribute("type", "button");
    b.setAttribute("data-lens", lens);
    b.setAttribute("aria-pressed", lens === "all" ? "true" : "false");
    if (lens === "all") b.textContent = "All";
    else b.textContent = getLens(lens)?.label ?? lens;
    b.addEventListener("click", () => setFilter(lens));
    lensRegion.appendChild(b);
    lensButtons.set(lens, b);
  }

  const templateBtn = el("button");
  templateBtn.setAttribute("type", "button");
  templateBtn.setAttribute("data-action", "open-template-editor");
  templateBtn.textContent = "Template editor";
  templateBtn.addEventListener("click", () => o.onOpenTemplateEditor());
  toolsRegion.appendChild(templateBtn);

  const onboarding =
    o.isTrusted === undefined
      ? createOnboarding(onboardingRegion, o.device)
      : createOnboarding(onboardingRegion, o.device, { isTrusted: o.isTrusted });
  const announcer = createAnnouncer(live, o.clock);
  const nav = createKeyboardNav(o.locator, o.onOpen);

  function applyMotion(): void {
    if (o.motion.reduced()) root.classList.add("ui-reduced-motion");
    else root.classList.remove("ui-reduced-motion");
  }
  function applyTheme(): void {
    root.setAttribute("data-theme", o.theme.dark() ? "dark" : "light");
  }
  applyMotion();
  applyTheme();
  const offMotion = o.motion.onChange(applyMotion);
  const offTheme = o.theme.onChange(applyTheme);

  let disposed = false;
  let filter: LensFilter = "all";
  let templateEditorEnabled = true;
  let cards = new Map<string, CapsuleCardView>();
  const revs = new Map<string, number>();
  const prevCard = new Map<string, { status: string; attention: string }>();
  let lastView: WallView | null = null;
  let lastProgress: number | null = null;
  let lastBannerText: string | null = null;
  const legendPool = new Map<string, HTMLElement>();
  for (const lensId of ["dev", "study"] as const) {
    const lens = getLens(lensId);
    if (lens === undefined) continue;
    for (const s of lens.statuses) {
      if (!legendPool.has(s)) {
        const item = el("span");
        item.setAttribute("data-status", s);
        item.textContent = s;
        legendPool.set(s, item);
      }
    }
  }

  function visibleIds(): string[] {
    const out: string[] = [];
    for (const c of cards.values()) {
      if (filter === "all" || c.lens_id === filter) out.push(c.projectId);
    }
    return out;
  }

  function refreshLegend(): void {
    const statuses: readonly string[] =
      filter === "all" ? [...legendPool.keys()] : (getLens(filter)?.statuses ?? []);
    while (legend.firstChild !== null) legend.removeChild(legend.firstChild);
    for (const s of statuses) {
      const item = legendPool.get(s);
      if (item !== undefined) legend.appendChild(item);
    }
  }

  function badgeFor(c: CapsuleCardView): string {
    if (c.tier === "private") {
      if ((lastView?.privateAvailable ?? false) === false) return "Private: unavailable";
      if (c.source === "IN_CLOUD") return "";
      if (c.source === "ON_DEVICE") return "On device";
      return "";
    }
    if (c.source === "IN_CLOUD") return "Cloud";
    if (c.source === "ON_DEVICE") return "On device";
    return "";
  }

  function refreshBadges(): void {
    if (disposed) return;
    for (const c of cards.values()) {
      const node = o.locator.nodeOf(c.projectId);
      if (node === null) continue;
      const badgeSlot = node.querySelector<HTMLElement>('[data-slot="badge"]');
      if (badgeSlot !== null) badgeSlot.textContent = badgeFor(c);
    }
  }

  function applyVisibility(): void {
    if (disposed) return;
    const visible = new Set(visibleIds());
    for (const c of cards.values()) {
      const node = o.locator.nodeOf(c.projectId);
      if (node === null) continue;
      node.setAttribute("role", "listitem");
      if (visible.has(c.projectId)) node.classList.remove("is-hidden");
      else {
        node.classList.add("is-hidden");
        node.setAttribute("tabindex", "-1");
      }
    }
    const nowCards: string[] = [];
    for (const c of cards.values()) {
      if (visible.has(c.projectId) && c.attention === "now") nowCards.push(c.projectId);
    }
    if (nowCards.length === 0) {
      focusBanner.setAttribute("hidden", "");
      focusBanner.textContent = "";
    } else {
      focusBanner.removeAttribute("hidden");
      focusBanner.textContent = nowCards.join(", ");
    }
    nav.setOrder([...visible], UI_LIMITS.GRID_COLUMNS_MAX);
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (disposed) return;
    if (ev.key === "Escape") {
      container?.focus();
      return;
    }
    nav.handleKey(ev.key);
  }

  container?.addEventListener("keydown", onKeydown);

  function setFilter(f: LensFilter): void {
    if (disposed) return;
    filter = f;
    for (const [lens, btn] of lensButtons) {
      btn.setAttribute("aria-pressed", lens === f ? "true" : "false");
    }
    refreshLegend();
    applyVisibility();
  }

  function update(inputs: WallInputs): WallView {
    if (disposed) {
      return lastView ?? {
        mode: "on_device" as const, progressPct: null, showEnableCta: false, privateAvailable: false,
      };
    }
    const view = resolveWallMode(inputs);
    lastView = view;
    let bannerText = BANNER_TEXT[view.mode];
    if (inputs.host.kind === "blocked") bannerText = `${bannerText}: ${inputs.host.reason}`;
    banner.setAttribute("data-mode", view.mode);
    banner.textContent = bannerText;
    badge.setAttribute("data-mode", view.mode);
    badge.textContent = BADGE_BY_MODE[view.mode];
    onboarding.render(view, inputs.device.state === "failed");
    refreshBadges();
    if (bannerText !== lastBannerText) {
      lastBannerText = bannerText;
      const assertiveMode = view.mode === "kill_switch" || view.mode === "offline" || view.mode === "blocked";
      announcer.say("wall", bannerText, assertiveMode ? "assertive" : "polite");
    }
    if (view.progressPct !== null) {
      const from = lastProgress ?? 0;
      for (const boundary of [25, 50, 75, 100]) {
        if (from < boundary && view.progressPct >= boundary) {
          announcer.say("progress", `Download ${boundary}%`, "polite");
        }
      }
      lastProgress = view.progressPct;
    } else {
      lastProgress = null;
    }
    return view;
  }

  function setCapsules(next: readonly CapsuleCardView[]): void {
    if (disposed) return;
    const prevFocused = nav.focused();
    const known = next.filter((c) => getLens(c.lens_id) !== undefined);
    const keep = new Set(known.map((c) => c.projectId));

    for (const id of [...cards.keys()]) {
      if (!keep.has(id)) {
        o.renderer.unmount(id);
        revs.delete(id);
        prevCard.delete(id);
      }
    }

    const nextCards = new Map<string, CapsuleCardView>();
    for (const c of known) {
      let node = o.locator.nodeOf(c.projectId);
      if (node === null) {
        const mountResult = o.renderer.mount(c.projectId);
        if (!mountResult.ok) continue;
        node = o.locator.nodeOf(c.projectId);
      }
      nextCards.set(c.projectId, c);
      const rev = (revs.get(c.projectId) ?? 0) + 1;
      revs.set(c.projectId, rev);
      o.renderer.enqueue({ projectId: c.projectId, rev, field: "status", value: c.status });
      o.renderer.enqueue({ projectId: c.projectId, rev, field: "attention", value: c.attention });
      o.renderer.enqueue({ projectId: c.projectId, rev, field: "stale", value: c.stale });
      if (c.source !== undefined) {
        o.renderer.enqueue({ projectId: c.projectId, rev, field: "inference_source", value: c.source });
      }
      if (node !== null) {
        const badgeSlot = node.querySelector<HTMLElement>('[data-slot="badge"]');
        if (badgeSlot !== null) badgeSlot.textContent = badgeFor(c);
        const staleSlot = node.querySelector<HTMLElement>('[data-slot="stale_badge"]');
        if (staleSlot !== null) staleSlot.textContent = c.stale ? "Stale" : "";
      }
      const prev = prevCard.get(c.projectId);
      if (prev !== undefined && (prev.status !== c.status || prev.attention !== c.attention)) {
        const pol = c.attention === "now" || c.status === "blocked" ? "assertive" : "polite";
        announcer.say(c.projectId, `${c.projectId}: ${c.status} ${c.attention}`, pol);
      }
      prevCard.set(c.projectId, { status: c.status, attention: c.attention });
    }
    cards = nextCards;
    applyVisibility();
    if (prevFocused !== null && nav.focused() === null) container?.focus();
  }

  function setPlan(projectId: string, steps: readonly PlanStep[]): void {
    if (disposed) return;
    const node = o.locator.nodeOf(projectId);
    if (node === null) return;
    const capped = steps.slice(0, 5);
    for (let i = 1; i <= 5; i += 1) {
      const row = node.querySelector<HTMLElement>(`[data-slot="step_${i}"]`);
      if (row === null) continue;
      const step = capped[i - 1];
      if (step !== undefined) {
        row.textContent = step.text;
        row.setAttribute("data-state", step.state);
        row.setAttribute("aria-label", `${step.text} (${step.state})`);
        row.classList.remove("is-hidden");
      } else {
        row.textContent = "";
        row.removeAttribute("data-state");
        row.removeAttribute("aria-label");
        row.classList.add("is-hidden");
      }
    }
  }

  function setTemplateEditorEnabled(enabled: boolean): void {
    if (disposed) return;
    templateEditorEnabled = enabled;
    if (enabled) templateBtn.removeAttribute("hidden");
    else templateBtn.setAttribute("hidden", "");
  }

  function reportRenderError(code: "template_invalid" | "allowlist_invalid"): void {
    if (disposed) return;
    alertPanel.removeAttribute("hidden");
    alertPanel.textContent = code;
  }

  function state(): WallUiState {
    return { filter, focus: nav.focused(), templateEditorEnabled };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    container?.removeEventListener("keydown", onKeydown);
    onboarding.dispose();
    announcer.dispose();
    offMotion();
    offTheme();
  }

  refreshLegend();
  return { update, setCapsules, setFilter, setPlan, setTemplateEditorEnabled, reportRenderError, state, dispose };
}
