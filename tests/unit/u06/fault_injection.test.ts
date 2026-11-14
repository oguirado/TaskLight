// Repair r7 (fault injection), U06. Systematic matrix instead of one-off regressions.
//
// Method: every injected port method (factory.create, factory.modeConst, factory.sourceConst[.X],
// handle.generateContent, handle.initializeDeviceModel, the schema validator, the caller's onProgress
// callback) is wrapped in a counting Proxy. Each scenario (std lifecycle, parity) is first run CLEAN to
// enumerate every call site (port.method, nth call, scenario step). One row is generated per
// (scenario, call site, fault kind); the fault fires exactly once at that site. Kinds: sync throw,
// hostile thrown object, property-access (getter) throw, rejected promise, never-settling promise,
// malformed result shapes, throwing getters on the result / response, throwing text(), bad source.
//
// Invariants checked for every row (collected as a violation list so a failure names each broken one):
//   W1 no unhandledRejection
//   W2 run() never rejects and always resolves to a well-formed TaskResult with the spec's code (B17, B18,
//      B-classification: ONLY_ON_DEVICE -> ON_DEVICE_UNAVAILABLE, ONLY_IN_CLOUD -> CLOUD_UNAVAILABLE, else
//      SDK_ERROR; malformed response / text() / validator throw -> SDK_ERROR; bad source -> BAD_SOURCE)
//   W3 initDevice() never rejects; deviceStatus() never throws; a public sync call may only propagate the
//      injected error itself, never an internal TypeError
//   W4 status reflects the failure per spec: explicit init failure -> failed (B12); auto re-init failure ->
//      needs_gesture (B12); failed lazy private init -> failed, not stuck in downloading
//   W5 no permanent stall: after the fault is cleared initDevice() -> ready and standard, screenshot and
//      private requests succeed again; a failed applyConfig did not bump configGen
//   W6 the hybrid's own progress callback never throws into the SDK
//   W7 runParity: handle-level faults resolve with the case counted as reject (B20); setup-level faults
//      (factory / init) may reject but only with the injected error
import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHybrid } from '../../../src/ai/hybrid';
import { runParity } from '../../../src/ai/parity';
import type { Hybrid, ModelFactory, ParityCase } from '../../../src/ai/types';
import { makeFake, OK_ORIGIN, PNG, req, type Fake } from './harness';
import { validateTaskOutput } from './schemaMock';

vi.mock('../../../src/schema', () => import('./schemaMock'));
const ORIG_VALIDATE = validateTaskOutput.getMockImplementation()!;

// ---------------------------------------------------------------- unhandled rejection capture
const unhandled: unknown[] = [];
let saved: Array<(...a: unknown[]) => void> = [];
const onUnhandled = (e: unknown): void => { unhandled.push(e); };
beforeEach(() => {
  unhandled.length = 0;
  saved = process.listeners('unhandledRejection') as Array<(...a: unknown[]) => void>;
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  for (const l of saved) process.on('unhandledRejection', l as never);
  validateTaskOutput.mockImplementation(ORIG_VALIDATE);
  validateTaskOutput.mockClear();
});
const macrotask = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));
async function quiesce(): Promise<void> { for (let i = 0; i < 3; i++) { await macrotask(); await Promise.resolve(); } }

// ---------------------------------------------------------------- fault model
interface Fault { key: string; nth: number; kind: string }
interface Site { key: string; nth: number; step: string }
const BASIC = ['throw', 'throw_hostile', 'getter'];
const GEN_KINDS = [...BASIC, 'reject', 'reject_hostile', 'never', 'result_undefined', 'result_null', 'resp_undefined', 'resp_getter',
  'text_throws', 'text_hostile', 'text_getter', 'src_getter', 'src_bad'];
const INIT_KINDS = [...BASIC, 'reject', 'reject_hostile', 'never', 'ret_undefined', 'ret_bad_then'];
const KINDS: Record<string, string[]> = {
  'factory.create': BASIC,
  'factory.modeConst': BASIC,
  'factory.sourceConst': ['getter'],
  'factory.sourceConst.ON_DEVICE': ['getter'],
  'factory.sourceConst.IN_CLOUD': ['getter'],
  'handle.generateContent': GEN_KINDS,
  'handle.initializeDeviceModel': INIT_KINDS,
  'validate': ['throw', 'throw_hostile', 'v_undefined', 'v_ok_getter', 'v_errors_getter'],
  'caller.onProgress': ['throw', 'throw_hostile'],
};

const hostileObj = (): object => ({
  get message(): string { throw new Error('hostile message getter'); },
  get stack(): string { throw new Error('hostile stack getter'); },
  toString(): string { throw new Error('hostile toString'); },
});

class Chaos {
  step = 'setup';
  counts = new Map<string, number>();
  log: Site[] = [];
  fault: Fault | null = null;
  fired = false;
  firedStep = '';
  err: unknown = new Error('INJECTED');
  readonly hostile = hostileObj();
  isInjected(e: unknown): boolean { return e === this.err || e === this.hostile; }
  tick(key: string): Site {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const s: Site = { key, nth: n, step: this.step };
    this.log.push(s);
    return s;
  }
  hit(s: Site): Fault | null {
    const f = this.fault;
    if (f !== null && !this.fired && f.key === s.key && f.nth === s.nth) { this.fired = true; this.firedStep = s.step; return f; }
    return null;
  }
  /** Applies a fault to a call. `real` performs the genuine call. */
  invoke(f: Fault | null, real: () => unknown): unknown {
    if (f === null) return real();
    const err = this.err;
    const settledReal = (): Promise<{ response: Record<string, unknown> }> => Promise.resolve(real() as Promise<{ response: Record<string, unknown> }>);
    switch (f.kind) {
      case 'throw': throw err;
      case 'throw_hostile': throw this.hostile;
      case 'getter': return real();
      case 'reject': return Promise.reject(err);
      case 'reject_hostile': return Promise.reject(this.hostile);
      case 'never': return new Promise<never>(() => undefined);
      case 'ret_undefined': return undefined;
      case 'ret_bad_then': return { get then(): never { throw err; } };
      case 'result_undefined': return Promise.resolve(undefined);
      case 'result_null': return Promise.resolve(null);
      case 'resp_undefined': return Promise.resolve({ response: undefined });
      case 'resp_getter': return Promise.resolve({ get response(): never { throw err; } });
      case 'text_throws': return settledReal().then((r) => ({ response: { ...r.response, text: (): never => { throw err; } } }));
      case 'text_hostile': { const h = this.hostile; return settledReal().then((r) => ({ response: { ...r.response, text: (): never => { throw h; } } })); }
      case 'text_getter': return settledReal().then((r) => ({ response: { inferenceSource: r.response['inferenceSource'], get text(): never { throw err; } } }));
      case 'src_getter': return settledReal().then((r) => ({ response: { text: r.response['text'], get inferenceSource(): never { throw err; } } }));
      case 'src_bad': return settledReal().then((r) => ({ response: { text: r.response['text'], inferenceSource: 'bogus' } }));
      case 'v_undefined': return undefined;
      case 'v_ok_getter': return { get ok(): never { throw err; } };
      case 'v_errors_getter': return { ok: false, get errors(): never { throw err; } };
    }
    return real();
  }
}

// ---------------------------------------------------------------- instrumented factory / handles / validator
function wrapHandle<H extends object>(real: H, c: Chaos): H {
  return new Proxy(real, {
    get(t, prop): unknown {
      const v: unknown = Reflect.get(t, prop, t);
      if (prop !== 'generateContent' && prop !== 'initializeDeviceModel') return v;
      const key = `handle.${prop}`;
      const site = c.tick(key);
      const f = c.hit(site);
      if (f !== null && f.kind === 'getter') throw c.err;
      return (...args: unknown[]): unknown => c.invoke(f, () => (v as (...a: unknown[]) => unknown).apply(t, args));
    },
  });
}
function wrapFactory(fake: Fake, c: Chaos): ModelFactory {
  return new Proxy(fake as unknown as ModelFactory, {
    get(t, prop): unknown {
      const v: unknown = Reflect.get(t, prop, t);
      if (prop === 'sourceConst') {
        const outer = c.tick('factory.sourceConst');
        const f = c.hit(outer);
        if (f !== null) throw c.err;
        return new Proxy(v as object, {
          get(st, p): unknown {
            if (p === 'ON_DEVICE' || p === 'IN_CLOUD') {
              const inner = c.tick(`factory.sourceConst.${p}`);
              if (c.hit(inner) !== null) throw c.err;
            }
            return Reflect.get(st, p, st);
          },
        });
      }
      if (prop !== 'create' && prop !== 'modeConst') return v;
      const key = `factory.${prop}`;
      const site = c.tick(key);
      const f = c.hit(site);
      if (f !== null && f.kind === 'getter') throw c.err;
      return (...args: unknown[]): unknown => {
        const out = c.invoke(f, () => (v as (...a: unknown[]) => unknown).apply(t, args));
        return prop === 'create' && f === null ? wrapHandle(out as object, c) : out;
      };
    },
  });
}
function instrumentValidator(c: Chaos): void {
  validateTaskOutput.mockImplementation(((task: string, raw: string, ctx?: unknown): unknown => {
    const site = c.tick('validate');
    const f = c.hit(site);
    return c.invoke(f, () => ORIG_VALIDATE(task, raw, ctx));
  }) as never);
}

// ---------------------------------------------------------------- scenario plumbing
type Outcome = { k: 'ok'; v: unknown } | { k: 'rej'; e: unknown } | { k: 'pending' };
interface U {
  c: Chaos; fake: Fake; factory: ModelFactory; h?: Hybrid | undefined;
  out: Map<string, Outcome>; thrown: unknown[]; cbThrown: unknown[]; cb: (p: number) => void;
}
interface Sc { id: string; flow: (x: U) => Promise<void> }

function build(fault: Fault | null, err?: { v: unknown }): U {
  const c = new Chaos(); c.fault = fault; if (err !== undefined) c.err = err.v;
  const fake = makeFake();
  instrumentValidator(c);
  const x: U = { c, fake, factory: wrapFactory(fake, c), out: new Map(), thrown: [], cbThrown: [], cb: () => undefined };
  x.cb = (p: number): void => {
    const site = c.tick('caller.onProgress');
    const f = c.hit(site);
    c.invoke(f, () => undefined);
  };
  return x;
}
function pub<T>(x: U, f: () => T): T | undefined {
  try { return f(); } catch (e) { x.thrown.push(e); return undefined; }
}
/** Resolve, reject or "still pending after a macrotask" (never-settling promise). */
async function settle(p: Promise<unknown>): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Outcome>((r) => { timer = setTimeout(() => r({ k: 'pending' }), 15); });
  const done = p.then((v): Outcome => ({ k: 'ok', v }), (e): Outcome => ({ k: 'rej', e }));
  const r = await Promise.race([done, pending]);
  if (timer !== undefined) clearTimeout(timer);
  return r;
}
const mkHybrid = (x: U): Hybrid => createHybrid({ factory: x.factory, origin: OK_ORIGIN, appCheckReady: true, config: { mode_next_action: 'ONLY_IN_CLOUD' } });

const RUNS_A: Array<[string, () => unknown]> = [
  ['run_status', () => req('status')],
  ['run_summary', () => req('summary')],
  ['run_cloud', () => req('next_action')],
  ['run_digest', () => req('digest')],
  ['run_shot', () => req('screenshot', { image: PNG })],
  ['run_priv', () => req('summary', { tier: 'private' })],
  ['run_priv_again', () => req('summary', { tier: 'private' })],
  ['run_priv_status', () => req('status', { tier: 'private' })],
];
const RUNS_B: Array<[string, () => unknown]> = [
  ['run_status2', () => req('status')],
  ['run_priv2', () => req('summary', { tier: 'private' })],
];
const MODE_OF: Record<string, 'PREFER' | 'ONLY_ON_DEVICE' | 'ONLY_IN_CLOUD'> = {
  run_status: 'PREFER', run_summary: 'PREFER', run_cloud: 'ONLY_IN_CLOUD', run_digest: 'PREFER', run_shot: 'ONLY_ON_DEVICE',
  run_priv: 'ONLY_ON_DEVICE', run_priv_again: 'ONLY_ON_DEVICE', run_priv_status: 'ONLY_ON_DEVICE', run_status2: 'PREFER', run_priv2: 'ONLY_ON_DEVICE',
};

async function stdFlow(x: U): Promise<void> {
  const { c } = x;
  c.step = 'construct';
  x.h = pub(x, () => mkHybrid(x));
  if (x.h === undefined) return;
  const h = x.h;
  c.step = 'init';
  x.out.set('init', await settle(h.initDevice(x.cb)));
  x.out.set('init_status', { k: 'ok', v: pub(x, () => h.deviceStatus()) });
  for (const [step, mk] of RUNS_A) {
    c.step = step;
    x.out.set(step, await settle(h.run(mk() as never)));
    if (step === 'run_priv' || step === 'run_priv_status') x.out.set(`status_after_${step}`, { k: 'ok', v: pub(x, () => h.deviceStatus()) });
  }
  c.step = 'cfg';
  x.out.set('cfg_apply', { k: 'ok', v: pub(x, () => h.applyConfig({ max_output_tokens: 120 })) });
  await settle(Promise.resolve());
  await macrotask();
  x.out.set('cfg_status', { k: 'ok', v: pub(x, () => h.deviceStatus()) });
  for (const [step, mk] of RUNS_B) { c.step = step; x.out.set(step, await settle(h.run(mk() as never))); }
}
const PARITY_CASES = (): ParityCase[] => [
  { task: 'status', prompt: 'a' }, { task: 'summary', prompt: 'b' }, { task: 'digest', prompt: 'c' },
  { task: 'screenshot', prompt: 'd', image: { ...PNG } },
];
async function parityFlow(x: U): Promise<void> {
  x.c.step = 'parity';
  x.out.set('parity', await settle(runParity(PARITY_CASES(), x.factory)));
}
const SCENARIOS: Sc[] = [{ id: 'std', flow: stdFlow }, { id: 'parity', flow: parityFlow }];

// ---------------------------------------------------------------- expectations and invariants
const isRes = (v: unknown): v is { ok: boolean; code?: string; meta?: unknown } =>
  typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean' && typeof (v as { meta?: unknown }).meta === 'object';
const stateOf = (o: Outcome | undefined): string => (o && o.k === 'ok' && typeof o.v === 'object' && o.v !== null ? String((o.v as { state?: unknown }).state) : o ? o.k : 'missing');

function wantRun(x: U, step: string, v: string[], allowed: string[]): void {
  const o = x.out.get(step);
  if (o === undefined) { v.push(`W2 no outcome recorded for ${step}`); return; }
  if (allowed.includes('pending')) { if (o.k === 'pending') return; }
  if (o.k !== 'ok' || !isRes(o.v) || o.v.ok) { v.push(`W2 ${step}: expected ${allowed.join('|')} but got ${o.k === 'ok' ? JSON.stringify((o.v as { ok?: boolean; code?: string }).ok === true ? 'ok:true' : (o.v as { code?: string }).code) : o.k}`); return; }
  if (!allowed.includes(String(o.v.code))) v.push(`W2 ${step}: code ${String(o.v.code)} not in ${allowed.join('|')}`);
}
function genCode(kind: string, step: string): string[] {
  if (kind === 'never') return ['pending'];
  if (kind === 'src_bad') return ['BAD_SOURCE'];
  if (['result_undefined', 'result_null', 'resp_undefined', 'resp_getter', 'text_throws', 'text_hostile', 'text_getter', 'src_getter'].includes(kind)) return ['SDK_ERROR'];
  const mode = MODE_OF[step] ?? 'PREFER';
  return [mode === 'ONLY_ON_DEVICE' ? 'ON_DEVICE_UNAVAILABLE' : mode === 'ONLY_IN_CLOUD' ? 'CLOUD_UNAVAILABLE' : 'SDK_ERROR'];
}

function verify(x: U, fault: Fault | null, sc: Sc, v: string[]): void {
  if (sc.id === 'std') {
    for (const [step, o] of x.out) {
      if (!step.startsWith('run_')) continue;
      if (o.k === 'rej') v.push(`W2 run() rejected at ${step}`);
      else if (o.k === 'ok' && !isRes(o.v)) v.push(`W2 run() at ${step} resolved to a malformed result`);
    }
    const init = x.out.get('init');
    if (init?.k === 'rej') v.push('W3 initDevice() rejected');
    if (x.cbThrown.length > 0) v.push('W6 progress callback threw into the SDK');
  }
  if (fault === null) return;
  const step = x.c.firedStep;
  const key = fault.key; const kind = fault.kind;
  if (sc.id === 'parity') { verifyParity(x, fault, v); return; }
  switch (key) {
    case 'handle.generateContent': wantRun(x, step, v, genCode(kind, step)); break;
    case 'validate': wantRun(x, step, v, ['SDK_ERROR']); break;
    case 'factory.sourceConst': case 'factory.sourceConst.ON_DEVICE': case 'factory.sourceConst.IN_CLOUD': wantRun(x, step, v, ['SDK_ERROR']); break;
    case 'caller.onProgress': if (stateOf(x.out.get('init')) !== 'ready') v.push(`W4 caller onProgress ${kind} must not fail init; state=${stateOf(x.out.get('init'))}`); break;
    case 'factory.create': case 'factory.modeConst':
      if (step === 'construct') { if (x.thrown.length === 0) v.push('W3 createHybrid swallowed a failing factory without a handle'); }
      else if (step === 'run_priv' || step === 'run_priv_status') wantRun(x, step, v, ['SDK_ERROR', 'DEVICE_NOT_INITIALISED']);
      else if (step === 'cfg') {
        const applied = x.out.get('cfg_apply');
        if (x.thrown.length > 0 && stateOf(x.out.get('cfg_status')) !== 'ready') v.push(`W4 failed applyConfig changed status to ${stateOf(x.out.get('cfg_status'))}`);
        void applied;
      }
      break;
    case 'handle.initializeDeviceModel':
      if (step === 'init') {
        const want = kind === 'never' ? 'pending' : 'failed';
        const got = x.out.get('init');
        if (want === 'pending') { if (got?.k !== 'pending') v.push(`W4 never-settling init expected pending, got ${got?.k}`); }
        else if (stateOf(got) !== 'failed') v.push(`W4 explicit initDevice must resolve failed (B12) but got ${stateOf(got)}`);
        if (want === 'failed' && stateOf(x.out.get('init_status')) !== 'failed') v.push(`W4 deviceStatus after failed init is ${stateOf(x.out.get('init_status'))}`);
        if (want === 'failed' && got?.k === 'ok' && stateOf(got) === 'failed' && typeof (got.v as { detail?: unknown }).detail !== 'string') v.push('W4 failed status has no string detail');
      } else if (step === 'run_priv' || step === 'run_priv_status') {
        wantRun(x, step, v, ['DEVICE_NOT_INITIALISED']);
        const st = stateOf(x.out.get(`status_after_${step}`));
        const wantSt = kind === 'never' ? 'downloading' : 'failed';
        if (st !== wantSt) v.push(`W4 status after ${kind} lazy private init is ${st}, expected ${wantSt}`);
      } else if (step === 'cfg') {
        const st = stateOf(x.out.get('cfg_status'));
        const ok = kind === 'never' ? ['downloading'] : kind === 'ret_undefined' ? ['ready', 'needs_gesture'] : ['needs_gesture'];
        if (!ok.includes(st)) v.push(`W4 status after auto re-init ${kind} is ${st}, expected ${ok.join('|')}`);
      }
      break;
  }
}

function verifyParity(x: U, fault: Fault, v: string[]): void {
  const o = x.out.get('parity');
  const setup = fault.key.startsWith('factory.') || fault.key === 'handle.initializeDeviceModel';
  if (o === undefined) { v.push('W7 no parity outcome'); return; }
  if (fault.kind === 'never') { if (o.k !== 'pending') v.push(`W7 never-settling ${fault.key} should leave parity pending`); return; }
  if (o.k === 'rej') {
    if (!setup) v.push('W7 handle-level fault made runParity reject instead of counting a reject (B20)');
    else if (!x.c.isInjected(o.e)) v.push(`W7 runParity rejected with a non-injected error: ${o.e instanceof Error ? o.e.name + ':' + o.e.message : String(o.e)}`);
    return;
  }
  if (o.k === 'ok' && Array.isArray(o.v)) {
    const rows = o.v as Array<{ rejects: number }>;
    if (rows.length !== 7) v.push(`W7 expected 7 parity rows, got ${rows.length}`);
    if (!setup && fault.key !== 'caller.onProgress' && !rows.some((r) => r.rejects > 0)) v.push('W7 faulted case was not counted as a reject');
  } else v.push('W7 runParity resolved to a non-array');
}

async function probe(x: U, sc: Sc, v: string[]): Promise<void> {
  x.c.step = 'probe';
  if (sc.id === 'parity') {
    const f2 = makeFake();
    const rows = await settle(runParity(PARITY_CASES(), f2));
    if (rows.k !== 'ok' || !Array.isArray(rows.v) || (rows.v as unknown[]).length !== 7) v.push('W5 runParity did not recover after the fault');
    else if ((rows.v as Array<{ rejects: number }>).some((r) => r.rejects > 0)) v.push('W5 runParity rows rejected after the fault was cleared');
    return;
  }
  if (x.h === undefined) {
    x.h = pub(x, () => mkHybrid(x));
    if (x.h === undefined) { v.push('W5 createHybrid still fails after the fault was cleared'); return; }
  }
  const h = x.h;
  const init = await settle(h.initDevice());
  if (stateOf(init) !== 'ready') v.push(`W5 initDevice after the fault: ${stateOf(init)} (permanent stall)`);
  if (pub(x, () => h.deviceStatus())?.state !== 'ready') v.push('W5 deviceStatus is not ready after a successful initDevice');
  for (const [name, r] of [['standard', req('summary')], ['screenshot', req('screenshot', { image: PNG })], ['private', req('summary', { tier: 'private' })], ['cloud-only', req('next_action')]] as const) {
    const res = await settle(h.run(r as never));
    if (res.k !== 'ok' || !isRes(res.v) || !res.v.ok) v.push(`W5 ${name} request failed after the fault was cleared: ${res.k === 'ok' ? String((res.v as { code?: string }).code) : res.k}`);
  }
  const cfgFailed = x.out.has('cfg_apply') && x.out.get('cfg_apply')!.k === 'ok' && (x.out.get('cfg_apply') as { v: unknown }).v === undefined;
  const g = pub(x, () => h.applyConfig({}))?.configGen;
  if (x.out.has('cfg_apply') && g !== undefined) {
    const want = cfgFailed ? 1 : 2;
    if (g !== want) v.push(`W5 configGen is ${g}, expected ${want} (a failed applyConfig must not bump it)`);
  }
  await settle(Promise.resolve());
}

async function runU(sc: Sc, fault: Fault | null, err?: { v: unknown }): Promise<string[]> {
  const x = build(fault, err);
  const v: string[] = [];
  await sc.flow(x);
  if (fault !== null && !x.c.fired) v.push('matrix drift: fault never fired');
  verify(x, fault, sc, v);
  if (fault !== null && x.thrown.some((e) => !x.c.isInjected(e))) {
    v.push('W3 a public call threw a non-injected error: ' + x.thrown.filter((e) => !x.c.isInjected(e)).map((e) => (e instanceof Error ? `${e.name}:${e.message}` : String(e))).join(' | '));
  }
  await probe(x, sc, v);
  await quiesce();
  if (unhandled.length > 0) v.push(`W1 ${unhandled.length} unhandled rejection(s): ${unhandled.map((u) => (u instanceof Error ? u.message : typeof u)).join(' | ')}`);
  dump[`${sc.id}|${fault ? `${fault.key}#${fault.nth}|${fault.kind}|@${x.c.firedStep}` : 'clean'}`] = v;
  return v;
}
const dump: Record<string, string[]> = {};
afterAll(() => { if (process.env['FI_DUMP']) writeFileSync(process.env['FI_DUMP'], JSON.stringify(dump, null, 1)); });
const show = (v: string[]): string => v.join(' ;; ');

// ---------------------------------------------------------------- matrix generation (clean enumeration)
function sample(sites: Site[]): Site[] {
  const groups = new Map<string, Site[]>();
  for (const s of sites) { const k = `${s.key}|${s.step}`; const g = groups.get(k); if (g) g.push(s); else groups.set(k, [s]); }
  const out: Site[] = [];
  for (const g of groups.values()) {
    const idx = new Set<number>([0, 1, Math.floor(g.length / 2), g.length - 1]);
    for (const i of [...idx].sort((a, b) => a - b)) if (g[i]) out.push(g[i]!);
  }
  return out;
}
async function measure(sc: Sc): Promise<Site[]> {
  const x = build(null);
  await sc.flow(x);
  return x.c.log.filter((s) => KINDS[s.key] !== undefined);
}
interface Row { name: string; sc: Sc; fault: Fault }
const rows: Row[] = [];
const sitesBy = new Map<string, Site[]>();
for (const sc of SCENARIOS) {
  const all = await measure(sc);
  sitesBy.set(sc.id, all);
  for (const s of sample(all)) for (const kind of KINDS[s.key]!) rows.push({ name: `${sc.id} | ${s.key}#${s.nth} @${s.step} | ${kind}`, sc, fault: { key: s.key, nth: s.nth, kind } });
}

describe('FI-0 baseline: scenarios are clean without faults (matrix control)', () => {
  it.each(SCENARIOS.map((sc) => ({ id: sc.id, sc })))('$id', async ({ sc }) => { expect(show(await runU(sc, null))).toBe(''); });
});
describe('FI-1 fault matrix: scenario x port call site x fault kind', () => {
  it.each(rows)('$name', async ({ sc, fault }) => { expect(show(await runU(sc, fault))).toBe(''); });
});

// ---------------------------------------------------------------- thrown values of every shape (error objects)
const WEIRD: Array<{ name: string; make: () => unknown }> = [
  { name: 'object whose message getter throws', make: () => ({ get message(): string { throw new Error('message getter failed'); } }) },
  { name: 'Object.create(null)', make: () => Object.create(null) as unknown },
  { name: 'Proxy throwing on every trap', make: () => new Proxy({}, { get(): never { throw new Error('trap'); }, has(): never { throw new Error('trap'); }, getPrototypeOf(): never { throw new Error('trap'); } }) },
  { name: 'Error whose message property getter throws', make: () => { const e = new Error('x'); Object.defineProperty(e, 'message', { get(): never { throw new Error('m'); } }); return e; } },
  { name: 'message is a non-string, toString throws', make: () => ({ message: 42, toString(): never { throw new Error('ts'); } }) },
  { name: 'null', make: () => null },
  { name: 'symbol', make: () => Symbol('s') },
  { name: 'bigint', make: () => 10n },
];
describe('FI-2 error objects: thrown/rejected values of every shape at generateContent, text() and initializeDeviceModel', () => {
  const wrows: Array<{ name: string; sc: Sc; fault: Fault; mk: () => unknown }> = [];
  for (const sc of SCENARIOS) {
    for (const s of sample(sitesBy.get(sc.id)!.filter((q) => q.key === 'handle.generateContent' || q.key === 'handle.initializeDeviceModel'))) {
      const kinds = s.key === 'handle.generateContent' ? ['throw', 'reject', 'text_throws'] : ['throw', 'reject'];
      for (const kind of kinds) for (const w of WEIRD) wrows.push({ name: `${sc.id} | ${s.key}#${s.nth} @${s.step} | ${kind} | ${w.name}`, sc, fault: { key: s.key, nth: s.nth, kind }, mk: w.make });
    }
  }
  it.each(wrows)('$name', async ({ sc, fault, mk }) => {
    expect(show(await runU(sc, fault, { v: mk() }))).toBe('');
  });
});

// ---------------------------------------------------------------- review-concrete BLOCKING inputs
describe('FI-3 REVIEW BLOCKING: rejection reasons whose formatting throws (errMessage)', () => {
  const reasons: Array<{ name: string; make: () => unknown }> = [
    { name: 'reason with throwing message getter', make: () => ({ get message(): string { throw new Error('message getter failed'); } }) },
    { name: 'Object.create(null) (String(e) throws)', make: () => Object.create(null) as unknown },
  ];
  it.each(reasons)('explicit initDevice: $name resolves failed, no stuck downloading, later device-only request works after re-init', async ({ make }) => {
    const fake = makeFake();
    fake.initFail = () => false;
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    for (const hd of fake.handles) hd.initializeDeviceModel = () => Promise.reject(make());
    const st = await h.initDevice();
    expect(st.state).toBe('failed');
    expect(h.deviceStatus().state).toBe('failed');
    const res = await h.run(req('screenshot', { image: PNG }) as never);
    expect(res.ok).toBe(false);
    await quiesce();
    expect(unhandled).toEqual([]);
    for (const hd of fake.handles) hd.initializeDeviceModel = () => Promise.resolve();
    expect((await h.initDevice()).state).toBe('ready');
    expect((await h.run(req('screenshot', { image: PNG }) as never)).ok).toBe(true);
  });
  it.each(reasons)('lazy private init: $name leaves status failed, removes the failed handle, no unhandled rejection', async ({ make }) => {
    const fake = makeFake();
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    await h.initDevice();
    const realCreate = fake.create.bind(fake);
    fake.create = (p) => { const hd = realCreate(p); hd.initializeDeviceModel = () => Promise.reject(make()); return hd; };
    const res = await h.run(req('summary', { tier: 'private' }) as never);
    await quiesce();
    expect(unhandled).toEqual([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('DEVICE_NOT_INITIALISED');
    expect(h.deviceStatus().state).toBe('failed');
    fake.create = realCreate;
    expect((await h.initDevice()).state).toBe('ready');
    expect((await h.run(req('summary', { tier: 'private' }) as never)).ok).toBe(true);
  });
  it.each(reasons)('lazy private init throws synchronously with $name: not stuck in downloading', async ({ make }) => {
    const fake = makeFake();
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    await h.initDevice();
    const realCreate = fake.create.bind(fake);
    fake.create = (p) => { const hd = realCreate(p); hd.initializeDeviceModel = () => { throw make(); }; return hd; };
    const res = await h.run(req('summary', { tier: 'private' }) as never);
    expect(res.ok).toBe(false);
    expect(h.deviceStatus().state).not.toBe('downloading');
    await quiesce();
    expect(unhandled).toEqual([]);
  });
  it.each(reasons)('run(): generateContent rejecting with $name still resolves a classified failure', async ({ make }) => {
    const fake = makeFake();
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    await h.initDevice();
    for (const hd of fake.handles) hd.generateContent = () => Promise.reject(make());
    const a = await h.run(req('screenshot', { image: PNG }) as never);
    const b = await h.run(req('summary') as never);
    expect(a.ok === false && a.code).toBe('ON_DEVICE_UNAVAILABLE');
    expect(b.ok === false && b.code).toBe('SDK_ERROR');
    expect(a.meta.called).toBe(true);
  });
});

// ---------------------------------------------------------------- caller-supplied request accessors (nth read)
describe('FI-4 request accessors: the Nth read of every request field throws; run() resolves SDK_ERROR', () => {
  type Mk = (hit: (field: string) => void) => unknown;
  const stdReq: Mk = (hit) => {
    const ctx = new Proxy({ knownProjectIds: new Set<string>(['p1']) }, { get(t, p, r): unknown { if (typeof p === 'string') hit(`ctx.${p}`); return Reflect.get(t, p, r); } });
    return new Proxy({ task: 'summary', projectId: 'p1', tier: 'standard', prompt: 'x', ctx }, {
      get(t, p, r): unknown { if (typeof p === 'string') hit(p); return Reflect.get(t, p, r); },
    });
  };
  const shotReq: Mk = (hit) => {
    const image = new Proxy({ ...PNG }, { get(t, p, r): unknown { if (typeof p === 'string') hit(`image.${p}`); return Reflect.get(t, p, r); } });
    return new Proxy({ task: 'screenshot', projectId: 'p1', tier: 'standard', prompt: 'x', image }, {
      get(t, p, r): unknown { if (typeof p === 'string') hit(p); return Reflect.get(t, p, r); },
    });
  };
  const kinds: Array<[string, Mk]> = [['summary+ctx', stdReq], ['screenshot+image', shotReq]];
  const table: Array<{ name: string; mk: Mk; field: string; nth: number }> = [];
  // Rows use read#1..3 of every field; a field read fewer times on the path is skipped inside the test.
  for (const [label, mk] of kinds) {
    const fields = label.startsWith('summary') ? ['task', 'projectId', 'tier', 'prompt', 'image', 'ctx', 'ctx.knownProjectIds'] : ['task', 'projectId', 'tier', 'prompt', 'image', 'ctx', 'image.mimeType', 'image.data'];
    for (const field of fields) for (const nth of [1, 2, 3]) table.push({ name: `${label} | ${field} read#${nth}`, mk, field, nth });
  }
  it.each(table)('$name', async ({ mk, field, nth }) => {
    const fake = makeFake();
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    await h.initDevice();
    let n = 0; let fired = false;
    const poisoned = mk((f) => { if (f === field && ++n === nth) { fired = true; throw new Error('accessor ' + f); } });
    const res = await settle(h.run(poisoned as never));
    await quiesce();
    expect(unhandled).toEqual([]);
    expect(res.k).toBe('ok');
    if (!fired) return;                          // field read fewer than nth times on this path: nothing to assert
    if (res.k === 'ok') {
      const r = res.v as { ok: boolean; code?: string };
      expect(r.ok).toBe(false);
      expect(r.code).toBe('SDK_ERROR');
    }
    // later valid work still runs
    expect((await h.run(req('summary') as never)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- caller-supplied config / deps accessors
describe('FI-5 deps and config accessors', () => {
  const AI_KEYS = ['mode_status', 'mode_summary', 'mode_next_action', 'mode_screenshot', 'mode_digest', 'max_output_tokens', 'ondevice_max_input_tokens', 'prompt_version', 'model_name', 'kill_switch_cloud'];
  const depsRows = ['origin', 'appCheckReady', 'config', 'factory'].map((f) => ({ f }));
  it.each(depsRows)('createHybrid(deps): deps.$f getter throws -> only the injected error, factory not touched (B1), clean retry works', async ({ f }) => {
    const fake = makeFake();
    const err = new Error('deps getter');
    const base: Record<string, unknown> = { factory: fake, origin: OK_ORIGIN, appCheckReady: true, config: {} };
    const deps = new Proxy(base, { get(t, p, r): unknown { if (p === f) throw err; return Reflect.get(t, p, r); } });
    let threw: unknown;
    try { createHybrid(deps as never); } catch (e) { threw = e; }
    expect(threw).toBe(err);
    if (f !== 'factory') expect(fake.createdParams.length + fake.modeConstCalls).toBe(0);
    await quiesce();
    expect(unhandled).toEqual([]);
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    expect((await h.run(req('summary') as never)).ok).toBe(true);
  });
  it.each(AI_KEYS.map((k) => ({ k })))('createHybrid(config): config.$k getter throws -> injected error only, no unhandled, clean retry works', async ({ k }) => {
    const fake = makeFake();
    const err = new Error('config getter');
    const config = { get [k](): never { throw err; } };
    let threw: unknown;
    try { createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true, config: config as never }); } catch (e) { threw = e; }
    expect(threw === undefined || threw === err).toBe(true);
    await quiesce();
    expect(unhandled).toEqual([]);
    const h = createHybrid({ factory: makeFake(), origin: OK_ORIGIN, appCheckReady: true });
    expect((await h.run(req('summary') as never)).ok).toBe(true);
  });
  it.each(AI_KEYS.map((k) => ({ k })))('applyConfig(patch): patch.$k getter throws -> injected error only, state and configGen unchanged, later work runs', async ({ k }) => {
    const fake = makeFake();
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true });
    await h.initDevice();
    const err = new Error('patch getter');
    const patch = { get [k](): never { throw err; } };
    let threw: unknown;
    try { h.applyConfig(patch as never); } catch (e) { threw = e; }
    expect(threw === undefined || threw === err).toBe(true);
    expect(h.deviceStatus().state).toBe('ready');
    await quiesce();
    expect(unhandled).toEqual([]);
    expect(h.applyConfig({}).configGen).toBe(threw === undefined ? 2 : 1);
    await quiesce();
    expect((await h.run(req('summary') as never)).ok).toBe(true);
  });
  it('applyConfig(patch) where patch is a Proxy whose ownKeys throws: injected error only, state unchanged', async () => {
    const h = createHybrid({ factory: makeFake(), origin: OK_ORIGIN, appCheckReady: true });
    await h.initDevice();
    const err = new Error('ownKeys');
    let threw: unknown;
    try { h.applyConfig(new Proxy({}, { ownKeys(): never { throw err; } }) as never); } catch (e) { threw = e; }
    expect(threw === undefined || threw === err).toBe(true);
    expect(h.deviceStatus().state).toBe('ready');
    expect(h.applyConfig({}).configGen).toBe(threw === undefined ? 2 : 1);
  });
});

// ---------------------------------------------------------------- parity: caller-supplied case accessors
describe('FI-6 runParity case accessors: a throwing field is that case\'s reject (B20, like run B18), never a whole-run abort', () => {
  const field: Array<{ name: string; mk: (e: Error) => ParityCase }> = [
    { name: 'prompt getter', mk: (e) => ({ task: 'summary', get prompt(): string { throw e; } }) as never },
    { name: 'image getter', mk: (e) => ({ task: 'summary', prompt: 'p', get image(): never { throw e; } }) as never },
    { name: 'image.data getter', mk: (e) => ({ task: 'summary', prompt: 'p', image: { mimeType: 'image/png', get data(): never { throw e; } } }) as never },
    { name: 'image.mimeType getter', mk: (e) => ({ task: 'summary', prompt: 'p', image: { get mimeType(): never { throw e; }, data: 'AAAA' } }) as never },
    { name: 'ctx getter', mk: (e) => ({ task: 'summary', prompt: 'p', get ctx(): never { throw e; } }) as never },
    { name: 'ctx.knownProjectIds getter', mk: (e) => ({ task: 'summary', prompt: 'p', ctx: { get knownProjectIds(): never { throw e; } } }) as never },
    { name: 'knownProjectIds iterator throws', mk: (e) => ({ task: 'summary', prompt: 'p', ctx: { knownProjectIds: new Proxy(new Set<string>(['a']), { get(t, p, r): unknown { if (p === Symbol.iterator || p === 'values') throw e; const v: unknown = Reflect.get(t, p, t); return typeof v === 'function' ? (v as () => unknown).bind(t) : v; } }) } }) as never },
  ];
  it.each(field)('$name', async ({ mk }) => {
    const fake = makeFake();
    const err = new Error('case accessor');
    const cases: ParityCase[] = [{ task: 'status', prompt: 'a' }, mk(err), { task: 'digest', prompt: 'c' }];
    const res = await settle(runParity(cases, fake));
    await quiesce();
    expect(unhandled).toEqual([]);
    expect(res.k).toBe('ok');
    if (res.k !== 'ok') return;
    const rows = res.v as Array<{ task: string; source: string; n: number; rejects: number }>;
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.rejects).toBe(r.task === 'summary' ? 1 : 0);
  });
  it('control: the same cases without a faulty accessor resolve with zero rejects', async () => {
    const res = await runParity([{ task: 'status', prompt: 'a' }, { task: 'summary', prompt: 'b' }, { task: 'digest', prompt: 'c' }], makeFake());
    expect(res.length).toBe(6);
    for (const r of res) expect(r.rejects).toBe(0);
  });
});

describe('FI-7 matrix census', () => {
  it('reports size', () => {
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.fault.key, (per.get(r.fault.key) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.log('FI matrix rows', rows.length, JSON.stringify(Object.fromEntries(per)));
    expect(rows.length).toBeGreaterThan(0);
  });
});
