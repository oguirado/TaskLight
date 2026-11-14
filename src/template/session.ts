import type { CompiledTemplate, LensId, TplResult, UserTemplate } from './types';
import { compileTemplate } from './compile';
import { defaultTemplate } from './defaults';
import { validateProposal, applyOps } from './ops';
import { validateTemplate, isPlainObject } from './validate';
import { templateHash } from './hash';

export interface TemplateStore { load(lens: LensId): Promise<unknown>; save(lens: LensId, ring: unknown): Promise<void> }
export interface Preview { baseHash: string; next: UserTemplate; compiled: CompiledTemplate }
export type SessionReject = 'STALE_PROPOSAL' | 'STORE_FAILED' | 'NOTHING_TO_UNDO' | 'NO_CHANGE';
export type SessionResult = { ok: true; templateHash: string } | { ok: false; code: SessionReject };
export interface TemplateSession {
  load(): Promise<{ restored: boolean }>;
  current(): CompiledTemplate;
  propose(p: unknown): TplResult<Preview>;
  accept(pv: Preview): Promise<SessionResult>;
  undo(): Promise<SessionResult>;
  history(): readonly string[];
}

function parseRing(raw: unknown, lens: LensId): { current: UserTemplate; history: UserTemplate[] } | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) return null;
  if (!('current' in raw) || !('history' in raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2) return null;
  const curRaw = (raw as Record<string, unknown>).current;
  const histRaw = (raw as Record<string, unknown>).history;
  const vcur = validateTemplate(curRaw);
  if (!vcur.ok) return null;
  if (vcur.value.lens_id !== lens) return null;
  if (!Array.isArray(histRaw)) return null;
  const hist: UserTemplate[] = [];
  for (const h of histRaw) {
    // B16: invalid history entries are dropped individually, never repaired,
    // and never discard the rest of the ring.
    const vh = validateTemplate(h);
    if (vh.ok && vh.value.lens_id === lens) hist.push(vh.value);
  }
  return { current: vcur.value, history: hist.slice(-10) };
}

export function createTemplateSession(lens: LensId, store: TemplateStore): TemplateSession {
  let curTemplate: UserTemplate = defaultTemplate(lens);
  let curCompiled: CompiledTemplate | null = null;
  const ensureCompiled = (): CompiledTemplate => {
    if (!curCompiled) {
      const c = compileTemplate(curTemplate);
      if (!c.ok) throw new Error('default invalid');
      curCompiled = c.value;
    }
    return curCompiled;
  };
  try { ensureCompiled(); } catch { /* */ }
  let historyTemplates: UserTemplate[] = [];

  // Serialize load/accept/undo across persistence (B14/B15): overlapping
  // mutations queue in call order, so stale checks and history updates never
  // race a save still in flight.
  const STORE_TIMEOUT_MS = 1000;
  const callWithTimeout = <T>(fn: () => Promise<T>): Promise<T> => {
    let p: Promise<T>;
    try {
      p = fn();
    } catch (e) {
      return Promise.reject<T>(e instanceof Error ? e : new Error('port threw'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('store timeout')), STORE_TIMEOUT_MS);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  };

  let chain: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const loadInner = async (): Promise<{ restored: boolean }> => {
    let raw: unknown;
    try { raw = await callWithTimeout(() => store.load(lens)); } catch { raw = undefined; }
    const parsed = parseRing(raw, lens);
    if (!parsed) {
      curTemplate = defaultTemplate(lens);
      const c = compileTemplate(curTemplate);
      if (!c.ok) throw new Error('default invalid');
      curCompiled = c.value;
      historyTemplates = [];
      return { restored: false };
    }
    curTemplate = structuredClone(parsed.current);
    historyTemplates = structuredClone(parsed.history);
    const c = compileTemplate(curTemplate);
    if (!c.ok) {
      curTemplate = defaultTemplate(lens);
      const c2 = compileTemplate(curTemplate);
      if (!c2.ok) throw new Error('default invalid');
      curCompiled = c2.value;
      historyTemplates = [];
      return { restored: false };
    }
    curCompiled = c.value;
    return { restored: true };
  };

  const acceptInner = async (pv: Preview): Promise<SessionResult> => {
    const cur = ensureCompiled();
    if (pv.baseHash !== cur.templateHash) return { ok: false, code: 'STALE_PROPOSAL' };
    // B13/B14: never trust the caller-mutable preview. Revalidate and
    // recompile its content; anything invalid fails closed with state
    // unchanged, and what is stored always matches what is installed.
    const vnext = validateTemplate(pv.next);
    if (!vnext.ok) return { ok: false, code: 'STORE_FAILED' };
    if (vnext.value.lens_id !== lens) return { ok: false, code: 'STORE_FAILED' };
    const comp = compileTemplate(vnext.value);
    if (!comp.ok) return { ok: false, code: 'STORE_FAILED' };
    if (comp.value.templateHash === cur.templateHash) return { ok: false, code: 'NO_CHANGE' };
    const newHistory = [...historyTemplates, structuredClone(curTemplate)].slice(-10);
    const ring = { current: structuredClone(vnext.value), history: structuredClone(newHistory) };
    try { await callWithTimeout(() => store.save(lens, ring)); } catch { return { ok: false, code: 'STORE_FAILED' }; }
    curTemplate = structuredClone(vnext.value);
    curCompiled = comp.value;
    historyTemplates = newHistory;
    return { ok: true, templateHash: comp.value.templateHash };
  };

  const undoInner = async (): Promise<SessionResult> => {
    if (historyTemplates.length === 0) return { ok: false, code: 'NOTHING_TO_UNDO' };
    const prev = historyTemplates[historyTemplates.length - 1]!;
    const newHistory = historyTemplates.slice(0, -1);
    const prevClone = structuredClone(prev);
    const comp = compileTemplate(prevClone);
    if (!comp.ok) return { ok: false, code: 'STORE_FAILED' };
    const ring = { current: structuredClone(prevClone), history: structuredClone(newHistory) };
    try { await callWithTimeout(() => store.save(lens, ring)); } catch { return { ok: false, code: 'STORE_FAILED' }; }
    curTemplate = prevClone;
    curCompiled = comp.value;
    historyTemplates = newHistory;
    return { ok: true, templateHash: comp.value.templateHash };
  };

  return {
    load(): Promise<{ restored: boolean }> {
      return enqueue(loadInner);
    },
    current(): CompiledTemplate { return ensureCompiled(); },
    propose(p: unknown): TplResult<Preview> {
      const cur = ensureCompiled();
      const vprop = validateProposal(p);
      if (!vprop.ok) return vprop as TplResult<Preview>;
      const vapply = applyOps(curTemplate, vprop.value);
      if (!vapply.ok) return vapply as TplResult<Preview>;
      const comp = compileTemplate(vapply.value);
      if (!comp.ok) return comp as TplResult<Preview>;
      return { ok: true, value: { baseHash: cur.templateHash, next: vapply.value, compiled: comp.value } };
    },
    accept(pv: Preview): Promise<SessionResult> {
      return enqueue(() => acceptInner(pv));
    },
    undo(): Promise<SessionResult> {
      return enqueue(undoInner);
    },
    history(): readonly string[] {
      return historyTemplates.map((t) => templateHash(t));
    },
  };
}
