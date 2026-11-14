export type ProjectId = string;
export type PatchField = 'status' | 'attention' | 'headline' | 'summary'
  | 'next_action' | 'inference_source' | 'stale' | 'updated_at';
export type WriteKind = 'text' | 'class' | 'attr';
export type AllowedAttr = 'data-status' | 'data-attention' | 'data-source' | 'data-stale' | 'aria-label';

export interface CapsulePatch {
  readonly projectId: ProjectId;
  readonly rev: number;
  readonly field: PatchField;
  readonly value: string | boolean;
}
export interface FieldRule {
  readonly kind: WriteKind;
  readonly slot: string;
  readonly maxChars?: number;
  readonly classMap?: Readonly<Record<string, string>>;
  readonly attr?: AllowedAttr;
}
export type FieldAllowlist = Readonly<Record<PatchField, FieldRule>>;

export interface TemplateNode {
  readonly tag: 'div' | 'span' | 'p' | 'h3' | 'time';
  readonly slot?: string;
  readonly staticClass?: readonly string[];
  readonly children?: readonly TemplateNode[];
}
export interface TemplateSpec { readonly templateHash: string; readonly root: TemplateNode }

export interface FrameCaps {
  maxPatchesThisFrame(): number;
  frameJsBudgetMs(): number;
  effectsEnabled(): boolean;
  beginFrame(): void;
  endFrame(applied: number, deferred: number): void;
}
export interface Clock { nowUs(): number }
export interface FrameScheduler { request(cb: () => void): void }

export type RejectReason = 'unknown_project' | 'field_not_allowed' | 'value_not_allowed'
  | 'too_long' | 'stale_rev' | 'bad_rev';
export type EnqueueResult = { ok: true } | { ok: false; reason: RejectReason };
export interface RenderCounters {
  writes: number; deferred: number; poolExhausted: number;
  rejects: Readonly<Record<RejectReason, number>>;
}
export interface CapsuleRenderer {
  mount(id: ProjectId): { ok: true } | { ok: false; reason: 'pool_exhausted' | 'duplicate' };
  unmount(id: ProjectId): void;
  enqueue(p: CapsulePatch): EnqueueResult;
  pendingCount(): number;
  counters(): Readonly<RenderCounters>;
}
export interface RendererOptions {
  container: HTMLElement; template: TemplateSpec; allowlist: FieldAllowlist;
  poolCapacity: number; caps: FrameCaps; scheduler: FrameScheduler; clock: Clock;
}
export class RenderError extends Error {
  readonly code: 'template_invalid' | 'allowlist_invalid';
  constructor(code: 'template_invalid' | 'allowlist_invalid', message?: string) {
    super(message ?? code);
    this.name = 'RenderError';
    this.code = code;
  }
}
