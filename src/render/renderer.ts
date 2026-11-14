import { RenderError } from './types';
import type {
  CapsulePatch,
  CapsuleRenderer,
  EnqueueResult,
  FieldAllowlist,
  PatchField,
  RenderCounters,
  RendererOptions,
  TemplateNode,
  TemplateSpec,
} from './types';

const ALLOWED_TAGS = new Set<string>(['div', 'span', 'p', 'h3', 'time']);
const FIELDS: readonly PatchField[] = [
  'status', 'attention', 'headline', 'summary', 'next_action', 'inference_source', 'stale', 'updated_at',
];
const ALLOWED_ATTRS = new Set<string>(['data-status', 'data-attention', 'data-source', 'data-stale', 'aria-label']);
const ALLOWED_KINDS = new Set<string>(['text', 'class', 'attr']);
const ALLOWED_FIELDS = new Set<string>(FIELDS);

interface Mounted {
  node: HTMLElement;
  slots: Map<string, HTMLElement>;
  lastAppliedRev: number;
  classTokens: Map<PatchField, string>;
}

function isValidToken(t: string): boolean {
  return t !== '' && !/\s/.test(t);
}

function collectSlots(node: TemplateNode, slots: Set<string>, tagsOk: { ok: boolean }): void {
  if (!ALLOWED_TAGS.has(node.tag)) tagsOk.ok = false;
  if (node.staticClass !== undefined) {
    for (const t of node.staticClass) {
      if (!isValidToken(t)) tagsOk.ok = false;
    }
  }
  if (node.slot !== undefined) {
    if (slots.has(node.slot)) tagsOk.ok = false;
    slots.add(node.slot);
  }
  if (node.children !== undefined) {
    for (const c of node.children) collectSlots(c, slots, tagsOk);
  }
}

function buildNode(t: TemplateNode, slotsOut: Map<string, HTMLElement>): HTMLElement {
  const el = document.createElement(t.tag);
  if (t.staticClass !== undefined) {
    for (const c of t.staticClass) el.classList.add(c);
  }
  if (t.slot !== undefined) {
    el.setAttribute('data-slot', t.slot);
    slotsOut.set(t.slot, el);
  }
  if (t.children !== undefined) {
    for (const c of t.children) el.appendChild(buildNode(c, slotsOut));
  }
  return el;
}

export function createRenderer(o: RendererOptions): CapsuleRenderer {
  // B2 validation
  const slots = new Set<string>();
  const tagsOk = { ok: true };
  collectSlots(o.template.root, slots, tagsOk);
  if (!tagsOk.ok) throw new RenderError('template_invalid', 'template_invalid');
  const allowlist = o.allowlist;
  // B2: reject unknown keys in allowlist
  for (const k of Object.keys(allowlist)) {
    if (!ALLOWED_FIELDS.has(k)) throw new RenderError('allowlist_invalid', 'allowlist_invalid');
  }
  for (const f of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(allowlist, f)) {
      const rule = allowlist[f] as { kind: string; slot: string; attr?: string };
      if (!rule || typeof rule.slot !== 'string' || !slots.has(rule.slot)) {
        throw new RenderError('allowlist_invalid', 'allowlist_invalid');
      }
      if (!ALLOWED_KINDS.has(rule.kind)) throw new RenderError('allowlist_invalid', 'allowlist_invalid');
      if (rule.kind === 'attr' && !ALLOWED_ATTRS.has(rule.attr as string)) {
        throw new RenderError('allowlist_invalid', 'allowlist_invalid');
      }
      const cm = (rule as { classMap?: Readonly<Record<string, string>> }).classMap;
      if (cm !== undefined) {
        for (const tok of Object.values(cm)) {
          if (typeof tok !== 'string' || !isValidToken(tok)) {
            throw new RenderError('allowlist_invalid', 'allowlist_invalid');
          }
        }
      }
    }
  }

  const capacity = o.poolCapacity ?? 16;
  const pool: Array<{ node: HTMLElement; slots: Map<string, HTMLElement> }> = [];
  for (let i = 0; i < capacity; i++) {
    const m = new Map<string, HTMLElement>();
    const node = buildNode(o.template.root, m);
    pool.push({ node, slots: m });
  }

  const mounted = new Map<string, Mounted>();
  // coalesced queue: key projectId\0field -> patch, insertion order = FIFO of first enqueue
  const pending = new Map<string, CapsulePatch>();
  let frameRequested = false;

  const counters: RenderCounters = {
    writes: 0,
    deferred: 0,
    poolExhausted: 0,
    rejects: {
      unknown_project: 0,
      field_not_allowed: 0,
      value_not_allowed: 0,
      too_long: 0,
      stale_rev: 0,
      bad_rev: 0,
    },
  };

  function reject(reason: keyof RenderCounters['rejects']): EnqueueResult {
    (counters.rejects as Record<string, number>)[reason] = ((counters.rejects as Record<string, number>)[reason] ?? 0) + 1;
    return { ok: false, reason };
  }

  function resetMountedSlots(m: Mounted): void {
    for (const f of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(allowlist, f)) continue;
      const rule = allowlist[f] as { kind: string; classMap?: Readonly<Record<string, string>>; attr?: string; slot: string };
      const el = m.slots.get(rule.slot);
      if (el === undefined) continue;
      if (rule.kind === 'text') {
        el.textContent = '';
      } else if (rule.kind === 'class' && rule.classMap !== undefined) {
        for (const tok of Object.values(rule.classMap)) el.classList.remove(tok);
      } else if (rule.kind === 'attr' && rule.attr !== undefined) {
        el.removeAttribute(rule.attr);
      }
    }
    // stale badge attr lives on the stale rule's slot
    if (Object.prototype.hasOwnProperty.call(allowlist, 'stale')) {
      const rule = allowlist.stale as { slot: string };
      const el = m.slots.get(rule.slot);
      if (el !== undefined) el.removeAttribute('data-stale');
    }
    m.classTokens.clear();
  }

  function applyPatch(p: CapsulePatch): void {
    const m = mounted.get(p.projectId);
    if (m === undefined) return;
    const rule = allowlist[p.field] as { kind: string; slot: string; classMap?: Readonly<Record<string, string>>; attr?: string };
    const el = m.slots.get(rule.slot);
    if (el === undefined) return;
    if (rule.kind === 'text') {
      el.textContent = String(p.value);
    } else if (rule.kind === 'class') {
      const prev = m.classTokens.get(p.field);
      if (prev !== undefined) el.classList.remove(prev);
      const key = String(p.value);
      const token = rule.classMap !== undefined ? rule.classMap[key] : undefined;
      if (token !== undefined) {
        el.classList.add(token);
        m.classTokens.set(p.field, token);
      } else {
        m.classTokens.delete(p.field);
      }
      if (p.field === 'stale') {
        if (p.value === true) {
          el.setAttribute('data-stale', 'true');
        } else {
          el.removeAttribute('data-stale');
        }
      }
    } else if (rule.kind === 'attr') {
      if (rule.attr !== undefined && ALLOWED_ATTRS.has(rule.attr)) el.setAttribute(rule.attr, String(p.value));
    }
    m.lastAppliedRev = Math.max(m.lastAppliedRev, p.rev);
  }

  function tick(): void {
    frameRequested = false;
    o.caps.beginFrame();
    const tickStart = o.clock.nowUs();
    const budgetUs = o.caps.frameJsBudgetMs() * 1000;
    const limit = o.caps.maxPatchesThisFrame();
    const effectiveLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    // B10: when effects are disabled, remove transition classes from mounted capsules
    const effects = o.caps.effectsEnabled();
    if (!effects) {
      for (const m of mounted.values()) {
        m.node.classList.remove('transition');
        for (const el of m.slots.values()) el.classList.remove('transition');
      }
    }
    let applied = 0;
    while (pending.size > 0 && applied < effectiveLimit) {
      const firstKey = pending.keys().next().value as string;
      const patch = pending.get(firstKey) as CapsulePatch;
      pending.delete(firstKey);
      applyPatch(patch);
      applied++;
      counters.writes++;
      if (pending.size === 0) break;
      if (applied >= effectiveLimit) break;
      const elapsed = o.clock.nowUs() - tickStart;
      if (elapsed >= budgetUs) break;
    }
    const deferred = pending.size;
    counters.deferred += deferred;
    o.caps.endFrame(applied, deferred);
    if (deferred > 0) {
      frameRequested = true;
      o.scheduler.request(tick);
    }
  }

  return {
    mount(id) {
      if (mounted.has(id)) return { ok: false, reason: 'duplicate' };
      const item = pool.pop();
      if (item === undefined) {
        counters.poolExhausted++;
        return { ok: false, reason: 'pool_exhausted' };
      }
      o.container.appendChild(item.node);
      mounted.set(id, { node: item.node, slots: item.slots, lastAppliedRev: -1, classTokens: new Map() });
      return { ok: true };
    },
    unmount(id) {
      const m = mounted.get(id);
      if (m === undefined) return;
      // drop pending for this capsule
      for (const [k, v] of Array.from(pending.entries())) {
        if (v.projectId === id) pending.delete(k);
      }
      resetMountedSlots(m);
      m.node.remove();
      mounted.delete(id);
      pool.push({ node: m.node, slots: m.slots });
    },
    enqueue(p: CapsulePatch): EnqueueResult {
      // 1 field in allowlist
      if (!Object.prototype.hasOwnProperty.call(allowlist, p.field as string)) {
        return reject('field_not_allowed');
      }
      // 2 project mounted
      const m = mounted.get(p.projectId);
      if (m === undefined) return reject('unknown_project');
      // 3 rev valid
      if (!Number.isInteger(p.rev) || p.rev < 0) return reject('bad_rev');
      // 4 stale rev (against applied)
      if (p.rev < m.lastAppliedRev) return reject('stale_rev');
      const rule = allowlist[p.field] as { kind: string; maxChars?: number; classMap?: Readonly<Record<string, string>> };
      // 5 too_long (text only, string only)
      if (rule.kind === 'text' && rule.maxChars !== undefined && typeof p.value === 'string' && p.value.length > rule.maxChars) {
        return reject('too_long');
      }
      // 6 value allowed
      if (rule.kind === 'text') {
        if (typeof p.value !== 'string') return reject('value_not_allowed');
      } else if (rule.kind === 'class') {
        if (p.field === 'stale') {
          if (typeof p.value !== 'boolean') return reject('value_not_allowed');
          if (p.value === true) {
            if (rule.classMap === undefined || !Object.prototype.hasOwnProperty.call(rule.classMap, 'true')) {
              return reject('value_not_allowed');
            }
          }
          // false is the clearing value: allowed with or without a classMap['false'] token
        } else if (typeof p.value === 'string') {
          if (rule.classMap === undefined || !Object.prototype.hasOwnProperty.call(rule.classMap, p.value)) {
            return reject('value_not_allowed');
          }
        } else if (typeof p.value === 'boolean') {
          const key = String(p.value);
          if (rule.classMap === undefined || !Object.prototype.hasOwnProperty.call(rule.classMap, key)) {
            return reject('value_not_allowed');
          }
        } else {
          return reject('value_not_allowed');
        }
      } else if (rule.kind === 'attr') {
        if (typeof p.value !== 'string') return reject('value_not_allowed');
      } else {
        return reject('value_not_allowed');
      }

      const key = p.projectId + '\u0000' + (p.field as string);
      const prev = pending.get(key);
      if (prev !== undefined && p.rev < prev.rev) return reject('stale_rev');
      pending.set(key, p);
      if (!frameRequested) {
        frameRequested = true;
        o.scheduler.request(tick);
      }
      return { ok: true };
    },
    pendingCount(): number {
      return pending.size;
    },
    counters(): Readonly<RenderCounters> {
      return {
        writes: counters.writes,
        deferred: counters.deferred,
        poolExhausted: counters.poolExhausted,
        rejects: { ...counters.rejects },
      };
    },
  };
}
