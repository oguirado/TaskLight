export type SourceKind = "device" | "cloud" | "rules";
export interface SourceVM { kind: SourceKind; ms: number }
export type StepStateVM = "done" | "active" | "blocked" | "pending";
export interface StepDetailVM { outcome: string; evidence: readonly string[]; source: SourceVM }
export interface StepVM { label: string; state: StepStateVM; at?: string; at_ms?: number; day?: string; took?: string; note?: string; detail?: StepDetailVM }
export type TaskStatusVM = "blocked" | "waiting" | "running" | "idle" | "done" | "failed";
export type AttentionVM = "now" | "high" | "low" | "none";
export type AccentVM = "rose" | "iris" | "sky" | "slate" | "lagoon" | "saffron";
export interface TaskVM { id: string; workspace: string; project: string; accent: AccentVM; title: string; summary: string;
  status: TaskStatusVM; attention: AttentionVM; updated: string; source: SourceVM; next: string; archived?: boolean; steps: readonly StepVM[] }
export interface WorkspaceVM { id: string; name: string; lens: "dev" | "study"; accent: AccentVM }
export interface AgendaItemVM { when: string; task: string; what: string }
export interface AgendaGroupVM { group: string; items: readonly AgendaItemVM[] }
export interface ArchivedVM { id: string; workspace: string; project: string; accent: AccentVM; title: string; archived: string; took: string; steps: number; outcome: string; source: SourceVM }
export type ViewId = "wall" | "agenda" | "diary" | "archive";
export interface WallVM { now: string; model: { state: "ready" | "downloading" | "unavailable"; label: string }; network: "online" | "offline";
  workspaces: readonly WorkspaceVM[]; workspace: string; view: ViewId; archiveScope: "workspace" | "all";
  tasks: readonly TaskVM[]; agenda: readonly AgendaGroupVM[]; archive: readonly ArchivedVM[] }
export interface WallHandlers { onView?(v: ViewId): void; onWorkspace?(id: string): void; onArchiveScope?(s: "workspace" | "all"): void;
  onRestore?(id: string): void; onNewWorkspace?(): void; onThemeToggle?(): void;
  /** U42: the user opened a task (card click or its Chat button); id = TaskVM.id. */
  onOpenTask?(id: string): void }
export interface WallHandle { update(vm: WallVM): void; destroy(): void }
