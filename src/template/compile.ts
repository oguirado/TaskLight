import type { CompiledTemplate, TplResult, UserTemplate, UserSlot } from './types';
import type { FieldRule, TemplateNode } from '../render/types';
import { validateTemplate } from './validate';
import { templateHash, canonicalTemplateJson, resolveLens } from './hash';
import { TPL_LIMITS } from './limits';

function deepFreeze<T>(o: T, seen = new Set<unknown>()): T {
  if (o === null || typeof o !== 'object') return o;
  if (seen.has(o)) return o;
  seen.add(o);
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v, seen);
  Object.freeze(o);
  return o;
}

function tagForComponent(comp: string): 'div'|'span'|'p'|'h3'|'time' {
  switch (comp) {
    case 'chip': return 'span';
    case 'headline': return 'h3';
    case 'text': return 'p';
    case 'next': return 'p';
    case 'steps': return 'div';
    case 'progress': return 'div';
    case 'badge': return 'span';
    case 'time': return 'time';
    default: return 'div';
  }
}

const STATUS_MAP: Record<string,string> = {
  running: 't-accent-blue',
  idle: 't-accent-slate',
  drafting: 't-accent-teal',
  done: 't-accent-green',
  attention: 't-accent-amber',
  error: 't-accent-rose',
};
const ATTENTION_MAP: Record<string,string> = {
  running: 't-accent-blue',
  idle: 't-accent-slate',
  urgent: 't-accent-amber',
};
const SOURCE_MAP: Record<string,string> = {
  on_device: 't-density-compact',
  in_cloud: 't-density-roomy',
  local: 't-density-normal',
};
const STALE_MAP: Record<string,string> = {
  fresh: 't-radius-soft',
  stale: 't-radius-none',
};

export function stepRowSlots(slotId: string): string[] {
  return Array.from({ length: 5 }, (_, i) => `${slotId}:${i}`);
}

function fieldRuleFor(slot: UserSlot): FieldRule {
  const { field, id: slotId } = slot;
  if (field === 'headline') return { kind: 'text', slot: slotId, maxChars: 120 } as FieldRule;
  if (field === 'summary') return { kind: 'text', slot: slotId, maxChars: 600 } as FieldRule;
  if (field === 'next_action') return { kind: 'text', slot: slotId, maxChars: 160 } as FieldRule;
  if (field === 'steps') {
    // Pooled rows (B10): the rule targets the first row (a leaf) and
    // references every row slot, max 80 chars per row.
    const rows = stepRowSlots(slotId);
    const classMap: Record<string, string> = {};
    for (const r of rows) classMap[r] = 't-scale-sm';
    return { kind: 'text', slot: rows[0]!, maxChars: 80, classMap } as FieldRule;
  }
  if (field === 'status') return { kind: 'class', slot: slotId, classMap: { ...STATUS_MAP } } as FieldRule;
  if (field === 'attention') return { kind: 'class', slot: slotId, classMap: { ...ATTENTION_MAP } } as FieldRule;
  if (field === 'inference_source') return { kind: 'class', slot: slotId, classMap: { ...SOURCE_MAP } } as FieldRule;
  if (field === 'stale') return { kind: 'class', slot: slotId, classMap: { ...STALE_MAP } } as FieldRule;
  if (field === 'progress') return { kind: 'attr', slot: slotId, attr: 'aria-label' } as FieldRule;
  if (field === 'updated_at') return { kind: 'text', slot: slotId, maxChars: 64 } as FieldRule;
  return { kind: 'text', slot: slotId } as FieldRule;
}

export function compileTemplate(t: UserTemplate): TplResult<CompiledTemplate> {
  const v = validateTemplate(t);
  if (!v.ok) return { ok: false, errors: v.errors };
  const validated = v.value;

  // B11: a strict lens without a usable template_hash cannot be hashed;
  // refuse instead of silently falling back (fail closed).
  const lens = resolveLens(validated.lens_id);
  if (lens.strict && lens.templateHash === null) {
    return { ok: false, errors: [{ code: 'BAD_LENS', path: 'lens_id' }] };
  }

  const h = templateHash(validated);

  const tokenClasses = [
    `t-accent-${validated.tokens.accent}`,
    `t-density-${validated.tokens.density}`,
    `t-radius-${validated.tokens.radius}`,
    `t-scale-${validated.tokens.scale}`,
  ];
  const gridClass = `g-cols-${validated.grid.cols}`;
  const rootClasses = [...tokenClasses, gridClass];

  const children: TemplateNode[] = validated.slots.map((s: UserSlot) => {
    const innerTag = tagForComponent(s.component);
    let inner: TemplateNode;
    if (s.component === 'steps') {
      const stepChildren: TemplateNode[] = stepRowSlots(s.id).map((rowSlot) => ({
        tag: 'span',
        slot: rowSlot,
      }));
      inner = { tag: innerTag, children: stepChildren };
    } else {
      inner = { tag: innerTag };
    }
    const wrapper: TemplateNode = {
      tag: 'div',
      slot: s.id,
      staticClass: [`g-r${s.row}-c${s.col}`],
      children: [inner],
    };
    return wrapper;
  });

  const root: TemplateNode = {
    tag: 'div',
    staticClass: rootClasses,
    children,
  };
  // Ensure nodes count > slots (root + 2 per slot already)
  const spec = { templateHash: h, root } as unknown as CompiledTemplate['spec'];

  const allowlist: Record<string, FieldRule> = {};
  for (const s of validated.slots) {
    allowlist[s.field] = fieldRuleFor(s);
  }

  const labels: Record<string, string> = {};
  for (const s of validated.slots) labels[s.id] = s.label;

  const compiled: CompiledTemplate = {
    templateHash: h,
    spec,
    allowlist,
    labels,
  } as unknown as CompiledTemplate;

  deepFreeze(compiled);
  return { ok: true, value: compiled };
}

export function templatePromptJson(t: UserTemplate): TplResult<string> {
  const v = validateTemplate(t);
  if (!v.ok) return { ok: false, errors: v.errors };
  const s = canonicalTemplateJson(v.value);
  if (s.length > TPL_LIMITS.PROMPT_JSON_MAX) return { ok: false, errors: [{ code: 'PROMPT_TOO_LARGE', path: '' }] };
  return { ok: true, value: s };
}
