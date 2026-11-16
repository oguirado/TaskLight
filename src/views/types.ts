export type SourceKind = "device" | "cloud" | "local" | "remote" | "rules";
export interface SourceVM { kind: SourceKind; ms: number }
export type StepStateVM = "done" | "active" | "blocked" | "pending";
export interface StepDetailVM { outcome: string; evidence: readonly string[]; source: SourceVM }
export interface StepVM { label: string; state: StepStateVM; at?: string; at_ms?: number; day?: string; took?: string; note?: string; detail?: StepDetailVM; microId?: string; accept?: string }
export type TaskStatusVM = "blocked" | "waiting" | "running" | "idle" | "done" | "failed";
export type AttentionVM = "now" | "high" | "low" | "none";
export type AccentVM = "rose" | "iris" | "sky" | "slate" | "lagoon" | "saffron";
export interface TaskVM { id: string; workspace: string; project: string; accent: AccentVM; title: string; summary: string;
  status: TaskStatusVM; attention: AttentionVM; updated: string; source: SourceVM; next: string; archived?: boolean; steps: readonly StepVM[];
  taskId?: string; phaseId?: string; phaseLabel?: string; taskType?: string; assignee?: string; estimate?: string; waitsFor?: readonly string[]; blockedReason?: string; nanoVerdict?: PlanVerdictVM }
export interface WorkspaceVM { id: string; name: string; lens: "dev" | "study"; accent: AccentVM }
export interface AgendaItemVM { when: string; task: string; what: string; agent?: string; taskId?: string; microId?: string; reason?: string }
export interface AgendaGroupVM { group: string; items: readonly AgendaItemVM[] }
export interface ArchivedVM { id: string; workspace: string; project: string; accent: AccentVM; title: string; archived: string; took: string; steps: number; outcome: string; source: SourceVM; taskCount?: number; planId?: string }
export type ViewId = "wall" | "agenda" | "diary" | "archive" | "memory";
export type NanoVerdictKind = "on_track" | "drift" | "needs_user";
export interface PlanVerdictVM { verdict: NanoVerdictKind; reason: string; source: SourceVM }
export interface PlanPhaseVM { id: string; label: string; exit?: string; active: boolean }
export interface PlanAgentDotVM { agent: string; accent?: AccentVM; active: boolean }
export interface PlanVM { id: string; title: string; templateId: string; templateHash: string; phaseId: string;
  phases: readonly PlanPhaseVM[]; doneCount: number; totalCount: number; progressPct: number;
  agents: readonly PlanAgentDotVM[]; brief?: string; conformanceFindings?: readonly string[]; closed?: boolean }
export interface DiaryEntryVM { kind: "microtask" | "memory"; day: string; at: string; title: string;
  outcome?: string; took?: string; evidence?: readonly string[]; author?: string }
export interface MemorySectionVM { id: string; label: string; text: string; required: boolean; empty: boolean;
  rev: number; by?: string; changedAt?: string; maxChars: number }
export interface MemoryVM { planId?: string; sections: readonly MemorySectionVM[] }
export interface WallVM { now: string; model: { state: "ready" | "downloading" | "unavailable"; label: string }; network: "online" | "offline";
  theme?: "light" | "dark";
  workspaces: readonly WorkspaceVM[]; workspace: string; view: ViewId; archiveScope: "workspace" | "all";
  tasks: readonly TaskVM[]; agenda: readonly AgendaGroupVM[]; archive: readonly ArchivedVM[];
  plan?: PlanVM; diary?: readonly DiaryEntryVM[]; memory?: MemoryVM }
export interface WallHandlers { onView?(v: ViewId): void; onWorkspace?(id: string): void; onArchiveScope?(s: "workspace" | "all"): void;
  onRestore?(id: string): void; onNewWorkspace?(): void; onThemeToggle?(): void;
  /** U42: the user opened a task (card click or its Chat button); id = TaskVM.id. */
  onOpenTask?(id: string): void;
  /** U51: opens the Models sheet; the model status line becomes a button when supplied. */
  onOpenModels?(trigger: HTMLElement): void;
  onSelectPhase?(phaseId: string): void; onToggleMicroDetail?(taskId: string, microIndex: number): void }
export interface WallHandle { update(vm: WallVM): void; destroy(): void }
