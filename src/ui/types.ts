import type { CapsuleStatus, Attention, InferenceSource, PrivacyTier } from "../schema";
import type { FrameCaps, TemplateSpec, FieldAllowlist, CapsuleRenderer } from "../render/types";
import type { LensId } from "../lens";

export type DeviceStatusView =
  | { state: "not_initialised" } | { state: "downloading"; progress: number }
  | { state: "ready" } | { state: "needs_gesture" } | { state: "failed"; detail: string };
export type Availability = "available" | "downloadable" | "downloading" | "unavailable";
export type HostView = { kind: "booting" } | { kind: "ready" } | { kind: "blocked"; reason: string };

export type WallMode = "booting" | "blocked" | "offline" | "kill_switch" | "no_model"
  | "needs_gesture" | "downloading" | "cloud_fallback" | "on_device";

export interface WallInputs {
  host: HostView; device: DeviceStatusView; availability: Availability;
  online: boolean; killSwitchCloud: boolean;
  lastRun?: { source: InferenceSource; fallback: boolean };
}
export interface WallView {
  mode: WallMode;
  progressPct: number | null;
  showEnableCta: boolean;
  privateAvailable: boolean;
}

/** AMEND_C B33: lens_id added (oracle decision, see ORACLE.md). */
export interface CapsuleCardView {
  projectId: string; lens_id: string; status: CapsuleStatus; attention: Attention; tier: PrivacyTier;
  source?: InferenceSource; stale: boolean;
}
export interface PlanStep { text: string; state: "todo" | "doing" | "done" }

export interface DevicePort { activate(trusted: boolean): Promise<void> }
export interface MotionPort { reduced(): boolean; onChange(cb: (r: boolean) => void): () => void }
export interface ThemePort { dark(): boolean; onChange(cb: (d: boolean) => void): () => void }
export interface Clock { nowMs(): number; setTimer(ms: number, fn: () => void): () => void }
export interface CardLocator { nodeOf(projectId: string): HTMLElement | null }

export type Politeness = "polite" | "assertive";
export interface Announcer {
  say(key: string, text: string, p: Politeness): void;
  flushedCount(): number;
}
export interface KeyboardNav {
  setOrder(ids: readonly string[], columns: number): void;
  handleKey(key: string): void;
  focused(): string | null;
}
export interface UiOptions {
  root: HTMLElement; renderer: CapsuleRenderer; locator: CardLocator;
  device: DevicePort; motion: MotionPort; theme: ThemePort; clock: Clock;
  onOpen(projectId: string): void;
  /** AMEND_C B35: opens U31; U20 applies nothing itself. */
  onOpenTemplateEditor(): void;
  /** A3-U20: injectable trust predicate; default is (ev) => ev.isTrusted. */
  isTrusted?: (ev: Event) => boolean;
}
export type LensFilter = LensId | "all";
export interface WallUiState { filter: LensFilter; focus: string | null; templateEditorEnabled: boolean }
export interface WallUi {
  update(i: WallInputs): WallView;
  setCapsules(cards: readonly CapsuleCardView[]): void;
  /** AMEND_C B33. Hides cards by class; never remounts. */
  setFilter(f: LensFilter): void;
  /** AMEND_C B34. Writes into the 5 pooled step rows; unused rows hidden by class. */
  setPlan(projectId: string, steps: readonly PlanStep[]): void;
  /** AMEND_C B35 (hidden when T17 fires). */
  setTemplateEditorEnabled(enabled: boolean): void;
  /** U11 §4: static error panel for template_invalid / allowlist_invalid. */
  reportRenderError(code: "template_invalid" | "allowlist_invalid"): void;
  state(): WallUiState;
  dispose(): void;
}

export type { FrameCaps, TemplateSpec, FieldAllowlist, CapsuleRenderer };
