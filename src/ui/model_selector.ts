// U51 Models sheet and source chips (SPEC_U51). Pure view: DOM via createElement/textContent only.
import type { ProviderDescriptor, ProviderId, TaskGroup, ModelSelection } from "../providers/types";
import { DEFAULT_PROVIDER, FIREBASE_IDS } from "../providers/types";
import type { DeviceStatus } from "../ai/types";
import type { InferenceSource, PrivacyTier } from "../schema";
import type { Announcer } from "./types";
import type { SourceKind } from "../views/types";

export type ModelGroupId = "firebase" | "local" | "network";
export type AssignScope = "all" | TaskGroup;

export interface ModelSheetSnapshot {
  providers: readonly ProviderDescriptor[];
  modelIds?: Readonly<Record<ProviderId, string>>;
  selection: ModelSelection;
  device: DeviceStatus;
  hostPresent: boolean;
}
export type ModelSheetIntent =
  | { t: "select"; scope: AssignScope; id: ProviderId }
  | { t: "reset" }
  | { t: "refresh" };
export interface ModelSheetOptions {
  doc: Document; mount: HTMLElement; announcer: Announcer;
  onIntent(i: ModelSheetIntent): void;
}
export interface ModelSheet {
  render(s: ModelSheetSnapshot): void;
  open(trigger: HTMLElement | null): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export const MODEL_SHEET_COPY: Readonly<Record<string, string>> = Object.freeze({
  title: "Models",
  scopeLabel: "Apply choice to",
  scopeAll: "Use for everything",
  scopeCapsule: "Capsule tasks",
  scopeDigest: "Digest",
  scopeRouting: "Routing",
  scopeDrift: "Drift review",
  groupFirebase: "Firebase AI Logic",
  groupLocal: "Your local models",
  groupNetwork: "Your network providers",
  networkNote: "Not used for private projects or screenshots",
  rowHybrid: "Hybrid — recommended",
  rowDefaultTag: "Default",
  rowOnDevice: "On-device only",
  rowCloud: "Cloud only",
  deviceReady: "On-device model ready",
  deviceDownloading: "Downloading on-device model: ",
  deviceNotInitialised: "On-device model not set up",
  deviceNeedsGesture: "On-device model needs a click to start",
  deviceFailed: "On-device model unavailable",
  healthAvailable: "Ready",
  healthNeedsSetup: "Needs setup. See docs/MODELS.md",
  healthOffline: "Offline. Using Firebase hybrid.",
  blockedPolicy: "Not allowed for this project's privacy level",
  blockedRemoteConfig: "Turned off by app configuration",
  blockedUnknownId: "Not found. Using Firebase hybrid.",
  reset: "Reset to Firebase hybrid",
  refresh: "Check again",
  close: "Close",
  announceOpen: "Models sheet open",
  announceReset: "Using Firebase hybrid",
  chipDevice: "On device",
  chipCloud: "Cloud",
  chipLocal: "Local model",
  chipRemote: "Network model",
});


const C = MODEL_SHEET_COPY as Readonly<Record<string, string>>;
const copy = (k: string): string => C[k] ?? "";

const SCOPES: readonly (readonly [AssignScope, string])[] = [
  ["all", "scopeAll"], ["capsule", "scopeCapsule"], ["digest", "scopeDigest"], ["routing", "scopeRouting"], ["drift", "scopeDrift"],
];
const FIREBASE_ROW: Readonly<Record<string, string>> = {
  "firebase-hybrid": "rowHybrid", "firebase-ondevice": "rowOnDevice", "firebase-cloud": "rowCloud",
};
const GROUP_HEADING: Readonly<Record<ModelGroupId, string>> = {
  firebase: "groupFirebase", local: "groupLocal", network: "groupNetwork",
};

export function groupOf(kind: ProviderDescriptor["kind"]): ModelGroupId {
  if (kind === "local-openai-compatible") return "local";
  if (kind === "remote-openai-compatible") return "network";
  return "firebase";
}

export function effectiveId(sel: ModelSelection, scope: AssignScope): ProviderId {
  if (scope !== "all") {
    const g = sel.groups?.[scope];
    if (g !== undefined) return g;
  }
  return sel.all ?? DEFAULT_PROVIDER;
}

export function chipLabel(src: InferenceSource | undefined, tier: PrivacyTier): string {
  const priv = tier === "private";
  switch (src) {
    case "ON_DEVICE": return copy("chipDevice");
    case "IN_CLOUD": return priv ? "" : copy("chipCloud");
    case "LOCAL_SERVER": return copy("chipLocal");
    case "REMOTE_PROVIDER": return priv ? "" : copy("chipRemote");
    default: return "";
  }
}

export function viewSourceKind(src: InferenceSource): SourceKind {
  switch (src) {
    case "ON_DEVICE": return "device";
    case "IN_CLOUD": return "cloud";
    case "LOCAL_SERVER": return "local";
    case "REMOTE_PROVIDER": return "remote";
    default: return "rules";
  }
}

/** Visible state copy for one descriptor (section 3). Never exposes kind/id/enum strings. */
function healthCopy(d: Pick<ProviderDescriptor, "health" | "blockedReason">): string {
  switch (d.health) {
    case "available": return copy("healthAvailable");
    case "needs_setup": return copy("healthNeedsSetup");
    case "offline": return copy("healthOffline");
    case "blocked":
      if (d.blockedReason === "remote_config") return copy("blockedRemoteConfig");
      if (d.blockedReason === "unknown_id") return copy("blockedUnknownId");
      return copy("blockedPolicy");
    default: return "";
  }
}
const isDisabled = (d: Pick<ProviderDescriptor, "health">): boolean => d.health === "needs_setup" || d.health === "blocked";

function deviceCopy(dev: DeviceStatus): string {
  switch (dev.state) {
    case "ready": return copy("deviceReady");
    case "downloading": {
      const p = typeof dev.progress === "number" && Number.isFinite(dev.progress) ? dev.progress : 0;
      const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
      return `${copy("deviceDownloading")}${pct}%`;
    }
    case "not_initialised": return copy("deviceNotInitialised");
    case "needs_gesture": return copy("deviceNeedsGesture");
    default: return copy("deviceFailed");
  }
}

interface RowModel { id: ProviderId; group: ModelGroupId; name: string; text: string; health: ProviderDescriptor["health"]; state: string; disabled: boolean; isDefault: boolean }

function rowsOf(s: ModelSheetSnapshot): RowModel[] {
  const out: RowModel[] = [];
  for (const id of FIREBASE_IDS) {
    const d = s.providers.find((p) => p.id === id);
    const h = d ?? { health: "available" as const };
    const name = copy(FIREBASE_ROW[id] ?? "");
    out.push({ id, group: "firebase", name, text: name, health: h.health, state: healthCopy(h), disabled: isDisabled(h), isDefault: id === DEFAULT_PROVIDER });
  }
  if (!s.hostPresent) return out;
  for (const g of ["local", "network"] as const) {
    for (const d of s.providers) {
      if (groupOf(d.kind) !== g || (FIREBASE_IDS as readonly string[]).includes(d.id)) continue;
      const label = typeof d.label === "string" ? d.label : "";
      const model = s.modelIds?.[d.id];
      const text = typeof model === "string" && model !== "" ? `${label} · ${model}` : label;
      out.push({ id: d.id, group: g, name: label, text, health: d.health, state: healthCopy(d), disabled: isDisabled(d), isDefault: false });
    }
  }
  return out;
}

let sheetSeq = 0;

export function createModelSheet(o: ModelSheetOptions): ModelSheet {
  const doc = o.doc;
  const uid = `model-sheet-${++sheetSeq}`;
  let disposed = false;
  let opened = false;
  let trigger: HTMLElement | null = null;
  let last: ModelSheetSnapshot | null = null;
  let lastState = new Map<ProviderId, string>();
  let pending: { t: "select"; scope: AssignScope; id: ProviderId } | { t: "reset" } | null = null;
  const radioIds = new WeakMap<HTMLInputElement, ProviderId>();

  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag);
    if (cls !== undefined) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const root = mk("div", "model-sheet");
  root.id = "model-sheet";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "model-sheet-title");
  root.setAttribute("data-open", "false");

  const head = mk("div", "model-sheet-head");
  const title = mk("h2", "model-sheet-title", copy("title"));
  title.id = "model-sheet-title";
  head.appendChild(title);
  root.appendChild(head);

  const scopeWrap = mk("div", "model-sheet-scope");
  const scopeLabel = mk("label", "model-sheet-scope-label", copy("scopeLabel"));
  const scope = mk("select", "model-sheet-scope-select");
  scope.id = `${uid}-scope`;
  scopeLabel.htmlFor = scope.id;
  for (const [v, k] of SCOPES) {
    const opt = mk("option", undefined, copy(k));
    opt.value = v;
    scope.appendChild(opt);
  }
  scope.value = "all";
  scopeWrap.append(scopeLabel, scope);
  root.appendChild(scopeWrap);

  const groups = mk("div", "model-sheet-groups");
  root.appendChild(groups);

  const foot = mk("div", "model-sheet-foot");
  const btn = (cls: string, text: string): HTMLButtonElement => { const b = mk("button", cls, text); b.type = "button"; return b; };
  const resetBtn = btn("model-sheet-reset", copy("reset"));
  const refreshBtn = btn("model-sheet-refresh", copy("refresh"));
  const closeBtn = btn("model-sheet-close", copy("close"));
  foot.append(resetBtn, refreshBtn, closeBtn);
  root.appendChild(foot);
  o.mount.appendChild(root);

  const currentScope = (): AssignScope => {
    const v = scope.value;
    return (SCOPES.find(([s]) => s === v)?.[0]) ?? "all";
  };
  const scopeText = (s: AssignScope): string => copy(SCOPES.find(([x]) => x === s)?.[1] ?? "scopeAll");
  // Injected callbacks are contained: a sync throw or an async rejection never escapes the sheet.
  const contain = (f: () => unknown): void => {
    try {
      const r = f();
      if (r !== null && (typeof r === "object" || typeof r === "function") && typeof (r as { then?: unknown }).then === "function") {
        (r as PromiseLike<unknown>).then(undefined, () => { /* contained */ });
      }
    } catch { /* contained */ }
  };
  const emit = (i: ModelSheetIntent): void => { if (!disposed) contain(() => o.onIntent(i)); };
  const say = (k: string, t: string): void => { if (!disposed) contain(() => o.announcer.say(k, t, "polite")); };
  // Structural check (not the global constructor): `doc` may be another same-origin document.
  const isInput = (x: unknown): x is HTMLInputElement =>
    x !== null && typeof x === "object" && (x as Node).nodeType === 1 && (x as Element).tagName === "INPUT";
  const allRadios = (): HTMLInputElement[] => [...groups.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

  function syncChecked(): void {
    if (last === null) return;
    const want = effectiveId(last.selection, currentScope());
    for (const r of allRadios()) r.checked = radioIds.get(r) === want;
  }

  function build(s: ModelSheetSnapshot, rows: RowModel[]): void {
    const focusedId = (() => {
      const a = doc.activeElement;
      return isInput(a) && groups.contains(a) ? radioIds.get(a) : undefined;
    })();
    groups.replaceChildren();
    let n = 0;
    for (const g of ["firebase", "local", "network"] as const) {
      const gRows = rows.filter((r) => r.group === g);
      if (g !== "firebase" && gRows.length === 0) continue;
      const sec = mk("section", "model-group");
      sec.setAttribute("data-group", g);
      const h = mk("h3", "model-group-title", copy(GROUP_HEADING[g]));
      h.id = `${uid}-g-${g}`;
      sec.setAttribute("aria-labelledby", h.id);
      sec.appendChild(h);
      if (g === "firebase") sec.appendChild(mk("p", "model-group-note model-device-line", deviceCopy(s.device)));
      if (g === "network") sec.appendChild(mk("p", "model-group-note", copy("networkNote")));
      const list = mk("div", "model-rows");
      list.setAttribute("role", "radiogroup");
      list.setAttribute("aria-labelledby", h.id);
      for (const r of gRows) {
        const row = mk("div", "model-row");
        row.setAttribute("data-health", r.health);
        const lab = mk("label", "model-row-main");
        const input = mk("input", "model-row-radio");
        input.type = "radio";
        input.name = "model-choice";
        input.id = `${uid}-r-${++n}`;
        input.disabled = r.disabled;
        radioIds.set(input, r.id);
        const stateId = `${input.id}-state`;
        input.setAttribute("aria-describedby", stateId);
        const dot = mk("span", "status-dot");
        dot.setAttribute("aria-hidden", "true");
        lab.append(input, dot, mk("span", "model-row-name", r.text));
        if (r.isDefault) lab.appendChild(mk("span", "model-row-tag", copy("rowDefaultTag")));
        const st = mk("span", "model-row-state", r.state);
        st.id = stateId;
        row.append(lab, st);
        list.appendChild(row);
      }
      sec.appendChild(list);
      groups.appendChild(sec);
    }
    syncChecked();
    if (focusedId !== undefined && opened) {
      const again = allRadios().find((x) => radioIds.get(x) === focusedId && !x.disabled);
      (again ?? scope).focus();
    }
  }

  function announceChanges(s: ModelSheetSnapshot, rows: RowModel[], first: boolean): void {
    const p = pending;
    pending = null;
    if (!first && p !== null) {
      if (p.t === "reset") {
        const g = s.selection.groups ?? {};
        const clean = effectiveId(s.selection, "all") === DEFAULT_PROVIDER
          && Object.values(g).every((v) => v === undefined || v === DEFAULT_PROVIDER);
        if (clean) say("models.select", copy("announceReset"));
      } else if (effectiveId(s.selection, p.scope) === p.id) {
        const r = rows.find((x) => x.id === p.id);
        if (r !== undefined) say("models.select", `${scopeText(p.scope)}: ${r.name}`);
      }
    }
    const next = new Map<ProviderId, string>();
    for (const r of rows) {
      next.set(r.id, r.state);
      const before = lastState.get(r.id);
      if (!first && before !== undefined && before !== r.state) say(`models.health.${r.id}`, `${r.name}: ${r.state}`);
    }
    lastState = next;
  }

  function liveTrigger(): HTMLElement | null {
    if (trigger === null) return null;
    if (trigger.isConnected) return trigger;
    const alt = doc.querySelector<HTMLElement>('[aria-controls="model-sheet"]');
    if (alt !== null) trigger = alt;
    return trigger;
  }

  function focusables(): HTMLElement[] {
    const list: HTMLElement[] = [scope];
    for (const r of allRadios()) if (!r.disabled) list.push(r);
    list.push(resetBtn, refreshBtn, closeBtn);
    return list;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (disposed || !opened) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      api.close();
      return;
    }
    if (e.key !== "Tab") return;
    const f = focusables();
    const first = f[0];
    const lastEl = f[f.length - 1];
    if (first === undefined || lastEl === undefined) return;
    const a = doc.activeElement;
    const inside = a !== null && root.contains(a);
    if (e.shiftKey) {
      if (!inside || a === first) { e.preventDefault(); lastEl.focus(); }
    } else if (!inside || a === lastEl) {
      e.preventDefault(); first.focus();
    }
  }

  function onChange(e: Event): void {
    if (disposed) return;
    const t = e.target;
    if (t === scope) { syncChecked(); return; }
    if (!isInput(t) || t.type !== "radio" || t.disabled || !t.checked) return;
    const id = radioIds.get(t);
    if (id === undefined) return;
    const sc = currentScope();
    pending = { t: "select", scope: sc, id };
    emit({ t: "select", scope: sc, id });
  }

  const onReset = (): void => { if (disposed) return; pending = { t: "reset" }; emit({ t: "reset" }); };
  const onRefresh = (): void => { emit({ t: "refresh" }); };
  const onClose = (): void => { api.close(); };

  root.addEventListener("keydown", onKeydown);
  root.addEventListener("change", onChange);
  resetBtn.addEventListener("click", onReset);
  refreshBtn.addEventListener("click", onRefresh);
  closeBtn.addEventListener("click", onClose);

  const api: ModelSheet = {
    render(s: ModelSheetSnapshot): void {
      if (disposed) return;
      const first = last === null;
      const rows = rowsOf(s);
      last = s;
      build(s, rows);
      announceChanges(s, rows, first);
    },
    open(t: HTMLElement | null): void {
      if (disposed || opened) return;
      opened = true;
      trigger = t;
      root.setAttribute("data-open", "true");
      trigger?.setAttribute("aria-expanded", "true");
      scope.focus();
      say("models.open", copy("announceOpen"));
      emit({ t: "refresh" });
    },
    close(): void {
      if (disposed || !opened) return;
      opened = false;
      root.setAttribute("data-open", "false");
      const tr = liveTrigger();
      if (tr !== null) {
        tr.setAttribute("aria-expanded", "false");
        tr.focus();
      }
      trigger = null;
    },
    isOpen(): boolean { return !disposed && opened; },
    dispose(): void {
      if (disposed) return;
      if (opened) liveTrigger()?.setAttribute("aria-expanded", "false");
      disposed = true;
      opened = false;
      root.removeEventListener("keydown", onKeydown);
      root.removeEventListener("change", onChange);
      resetBtn.removeEventListener("click", onReset);
      refreshBtn.removeEventListener("click", onRefresh);
      closeBtn.removeEventListener("click", onClose);
      root.remove();
      trigger = null;
      last = null;
    },
  };
  return api;
}
