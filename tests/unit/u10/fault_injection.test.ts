// Repair r7 (fault injection), U10. Systematic matrix instead of one-off regressions.
//
// Method: every injected port method (infer.run, validator.validate, store.read,
// store.currentIncarnation, store.compareAndPublish, clock.now, clock.setTimer, ledger.inc) is wrapped
// in a counting Proxy. Each scenario is first run CLEAN to enumerate every call site (port.method,
// nth call, scenario step). Then one row is generated per (scenario, call site, fault kind); the fault
// fires exactly once at that site. Kinds: sync throw, hostile thrown object, property-access (getter)
// throw, rejected promise, never-settling promise, bad return shapes, throwing getter on the returned
// object, throwing / non-function cancel handle.
//
// Invariants checked for every row (collected as a violation list so a failure names every broken one):
//   V1 no unhandledRejection
//   V2 no exception escapes a clock-timer callback
//   V3 a public call may only propagate the injected error itself (never an internal TypeError)
//   V4 no lane/slot leaked after all work drained (snapshot().inFlight all 0)
//   V5 no work stranded without a wake-up: other project's job started and pending drained with only time
//      passing (no further public call), for faults not in the clock itself
//   V6 retry intent kept for the faulted project (same-revision observe re-admits and publishes)
//   V7 a fresh project and a newer revision of the faulted project still dispatch and publish (probe)
import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconciler } from '../../../src/reconcile/index';
import type { DeviceState, ObservedEvent, ReconcileConfig, Reconciler, ValidatorPort } from '../../../src/reconcile/types';
import { CFG, FakeClock, FakeInfer, FakeLedger, FakeStore, ev, flush, makeHarness, okValidator } from './harness';

// ---------------------------------------------------------------- unhandled rejection capture
const unhandled: unknown[] = [];
let savedListeners: Array<(...a: unknown[]) => void> = [];
const onUnhandled = (e: unknown): void => { unhandled.push(e); };
beforeEach(() => {
  unhandled.length = 0;
  savedListeners = process.listeners('unhandledRejection') as Array<(...a: unknown[]) => void>;
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  for (const l of savedListeners) process.on('unhandledRejection', l as never);
  vi.unstubAllGlobals();
});
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) { await new Promise<void>((r) => setTimeout(r, 0)); await flush(); }
}

// ---------------------------------------------------------------- fault model
type Kind =
  | 'throw' | 'throw_hostile' | 'getter'
  | 'reject' | 'reject_hostile' | 'never' | 'ret_undefined' | 'ret_bad_then' | 'res_undefined' | 'res_raw_getter'
  | 'v_undefined' | 'v_ok_getter' | 'v_patch_getter'
  | 'read_hostile'
  | 'cancel_throws' | 'cancel_nonfn';
interface Fault { key: string; nth: number; kind: Kind }
interface Site { key: string; nth: number; step: string; arg?: string }

const BASIC: Kind[] = ['throw', 'throw_hostile', 'getter'];
const KINDS: Record<string, Kind[]> = {
  'infer.run': [...BASIC, 'reject', 'reject_hostile', 'never', 'ret_undefined', 'ret_bad_then', 'res_undefined', 'res_raw_getter'],
  'validator.validate': [...BASIC, 'v_undefined', 'v_ok_getter', 'v_patch_getter'],
  'store.read': [...BASIC, 'read_hostile'],
  'store.currentIncarnation': BASIC,
  'store.compareAndPublish': BASIC,
  'clock.now': BASIC,
  'clock.setTimer': [...BASIC, 'cancel_throws', 'cancel_nonfn'],
  'ledger.inc': BASIC,
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
  started = new Set<string>();
  readonly err = new Error('INJECTED');
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
  invoke(key: string, site: Site, f: Fault | null, real: () => unknown, args: unknown[]): unknown {
    if (key === 'infer.run') this.started.add(String((args[0] as { key?: { projectId?: unknown } } | undefined)?.key?.projectId));
    if (key === 'ledger.inc' || key === 'validator.validate') site.arg = String(args[0]);
    if (f === null) return real();
    const err = this.err;
    switch (f.kind) {
      case 'throw': throw err;
      case 'throw_hostile': throw this.hostile;
      case 'getter': return real();
      case 'reject': return Promise.reject(err);
      case 'reject_hostile': return Promise.reject(this.hostile);
      case 'never': return new Promise<never>(() => undefined);
      case 'ret_undefined': return undefined;
      case 'ret_bad_then': return { get then(): never { throw err; } };
      case 'res_undefined': return Promise.resolve(undefined);
      case 'res_raw_getter': return Promise.resolve({ get raw(): never { throw err; }, inferenceSource: 'ON_DEVICE' });
      case 'v_undefined': return undefined;
      case 'v_ok_getter': return { get ok(): never { throw err; } };
      case 'v_patch_getter': return { ok: true, get patch(): never { throw err; } };
      case 'read_hostile': return new Proxy({}, { get(): never { throw err; } });
      case 'cancel_throws': { const cancel = real() as () => void; return (): void => { cancel(); throw err; }; }
      case 'cancel_nonfn': real(); return undefined;
    }
  }
}

function wrap<T extends object>(name: string, real: T, c: Chaos): T {
  return new Proxy(real, {
    get(t, prop): unknown {
      const v: unknown = Reflect.get(t, prop, t);
      if (typeof prop !== 'string' || typeof v !== 'function') return v;
      const key = `${name}.${prop}`;
      const site = c.tick(key);
      const f = c.hit(site);
      if (f !== null && f.kind === 'getter') throw c.err;
      return (...args: unknown[]): unknown => c.invoke(key, site, f, () => (v as (...a: unknown[]) => unknown).apply(t, args), args);
    },
  });
}

// ---------------------------------------------------------------- scenario plumbing
interface Sc {
  id: string;
  cfg?: Partial<ReconcileConfig>;
  after?: Partial<ReconcileConfig>;          // config re-applied before the probe (undefined: leave as is)
  device?: DeviceState; deviceLater?: DeviceState;
  source?: 'ON_DEVICE' | 'IN_CLOUD';
  validator?: 'ok' | 'reject_first';
  cas?: boolean;
  flow: (x: X, sc: Sc) => Promise<void>;
  retrySteps: string[];                      // faults here must leave retry intent for P1@rev1
  p2Self: string[];                          // steps in which P2's own infer start happens
  checkStall: boolean;                       // assert V5 for this scenario
  noP1Probe?: boolean;                       // P1 unregistered by the scenario
  terminal?: boolean;                        // dispose scenario: own checks
}
interface X {
  r: Reconciler; clock: FakeClock; infer: FakeInfer; store: FakeStore; ledger: FakeLedger; c: Chaos;
  escapes: unknown[]; thrown: unknown[]; done: Set<object>; cfgObj: ReconcileConfig;
}

function firstRejects(): ValidatorPort {
  let n = 0;
  return { validate: (t, raw) => (n++ === 0 ? { ok: false, reason: 'bad' } : okValidator.validate(t, raw)) };
}
const PROJECTS = ['P1', 'P2', 'PX'];

function build(sc: Sc, fault: Fault | null, cfgWrap?: (c: ReconcileConfig) => ReconcileConfig): X {
  const c = new Chaos(); c.fault = fault;
  const clock = new FakeClock(), infer = new FakeInfer(), store = new FakeStore(), ledger = new FakeLedger();
  const validator = sc.validator === 'reject_first' ? firstRejects() : okValidator;
  const cfgObj: ReconcileConfig = { ...CFG, ...sc.cfg };
  const r = createReconciler({
    infer: wrap('infer', infer, c), validator: wrap('validator', validator, c), store: wrap('store', store, c),
    clock: wrap('clock', clock, c), ledger: wrap('ledger', ledger, c),
  }, cfgWrap ? cfgWrap(cfgObj) : cfgObj);
  for (const p of PROJECTS) { r.registerProject(p); store.inc.set(p, 'A'); }
  return { r, clock, infer, store, ledger, c, escapes: [], thrown: [], done: new Set(), cfgObj };
}

function pub<T>(x: X, f: () => T): T | undefined {
  try { return f(); } catch (e) { x.thrown.push(e); return undefined; }
}
/** Advance fake time; an exception escaping a timer callback is recorded (V2) and time keeps moving. */
async function adv(x: X, ms: number): Promise<void> {
  const target = x.clock.t + ms;
  for (let i = 0; i < 60; i++) {
    try { await x.clock.advance(Math.max(0, target - x.clock.t)); return; } catch (e) { x.escapes.push(e); }
  }
}
function resolveAll(x: X, source: 'ON_DEVICE' | 'IN_CLOUD' = 'ON_DEVICE', includeAborted = false): void {
  for (const call of x.infer.calls) {
    if (x.done.has(call)) continue;
    if (!includeAborted && call.signal.aborted) continue;
    x.done.add(call);
    call.resolve({ inferenceSource: source });
  }
}
async function drain(x: X, source: 'ON_DEVICE' | 'IN_CLOUD' = 'ON_DEVICE', rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) { await adv(x, 30000); resolveAll(x, source); await flush(); }
}
const snap = (x: X): ReturnType<Reconciler['snapshot']> => pub(x, () => x.r.snapshot()) ?? { pending: [], inFlight: { on_device: 0, cloud: 0 }, bound: 0 };
const inFlightTotal = (x: X): number => { const s = snap(x).inFlight; return s.on_device + s.cloud; };
const srcRev = (x: X, p: string): number | undefined => x.store.caps.get(p)?.source_observed_rev;

// ---------------------------------------------------------------- flows
const baseFlow = async (x: X, sc: Sc): Promise<void> => {
  const { c, r, store } = x;
  const src = sc.source ?? 'ON_DEVICE';
  c.step = 'device'; if (sc.device) pub(x, () => r.setDeviceState(sc.device!));
  c.step = 'observe1'; pub(x, () => r.observe(ev('P1', 1)));
  c.step = 'observe2'; pub(x, () => r.observe(ev('P2', 1)));
  if (sc.deviceLater) {
    c.step = 'blocked'; await adv(x, 0);
    c.step = 'device2'; pub(x, () => r.setDeviceState(sc.deviceLater!));
  }
  c.step = 'start1'; await adv(x, 0);
  c.step = 'resolve1';
  if (sc.cas) store.beforeCas = () => store.seed('P1', { rev: 1 });
  resolveAll(x, src); await flush();
  c.step = 'start2'; await adv(x, 0);
  c.step = 'resolve2'; resolveAll(x, src); await flush();
  c.step = 'tail'; await adv(x, 20000); resolveAll(x, src); await flush();
};
const refusalDispatchFlow = async (x: X): Promise<void> => {
  const { c, r } = x;
  c.step = 'observe1'; pub(x, () => r.observe(ev('P1', 1)));
  c.step = 'observe2'; pub(x, () => r.observe(ev('P2', 1, { task: 'summary' })));
  c.step = 'cfg'; pub(x, () => r.updateConfig({ ...CFG, kill_switch_cloud: true, mode_status: 'ONLY_IN_CLOUD' }));
  c.step = 'dispatch'; await adv(x, 0);
  c.step = 'resolve2'; resolveAll(x); await flush();
  c.step = 'tail'; await adv(x, 20000); resolveAll(x); await flush();
};
const refusalObserveFlow = async (x: X): Promise<void> => {
  const { c, r } = x;
  c.step = 'observe1'; pub(x, () => r.observe(ev('P1', 1)));
  c.step = 'observe2'; pub(x, () => r.observe(ev('P2', 1, { task: 'summary' })));
  c.step = 'start2'; await adv(x, 0);
  c.step = 'resolve2'; resolveAll(x); await flush();
  c.step = 'tail'; await adv(x, 20000); resolveAll(x); await flush();
};
const timeoutFlow = async (x: X): Promise<void> => {
  const { c, r } = x;
  c.step = 'observe1'; pub(x, () => r.observe(ev('P1', 1)));
  c.step = 'observe2'; pub(x, () => r.observe(ev('P2', 1)));
  c.step = 'start1'; await adv(x, 0);
  c.step = 'timeout'; await adv(x, CFG.inference_timeout_ms);
  c.step = 'resolve2'; resolveAll(x); await flush();
  c.step = 'tail'; await adv(x, 20000); resolveAll(x); await flush();
};
const unregisterOtherFlow = async (x: X): Promise<void> => {
  const { c, r } = x;
  c.step = 'observe1'; pub(x, () => r.observe(ev('P1', 1)));
  c.step = 'start1'; await adv(x, 0);
  c.step = 'observe2'; pub(x, () => r.observe(ev('P2', 1)));
  c.step = 'blocked'; await adv(x, 0);
  c.step = 'unregister'; pub(x, () => r.unregisterProject('P1'));
  c.step = 'after'; await adv(x, 0);
};
const disposeFlow = async (x: X): Promise<void> => {
  const { c, r } = x;
  c.step = 'observe1'; pub(x, () => r.observe(ev('P1', 1)));
  c.step = 'observe2'; pub(x, () => r.observe(ev('P2', 1)));
  c.step = 'start1'; await adv(x, 0);
  c.step = 'dispose'; pub(x, () => r.dispose());
};

const CYCLE_RETRY = ['start1', 'resolve1'];
const CYCLE_P2SELF = ['observe2', 'start2', 'resolve2', 'tail'];
const SCENARIOS: Sc[] = [
  { id: 'cycle', flow: baseFlow, retrySteps: CYCLE_RETRY, p2Self: CYCLE_P2SELF, checkStall: true },
  { id: 'cas_conflict', cas: true, flow: baseFlow, retrySteps: CYCLE_RETRY, p2Self: CYCLE_P2SELF, checkStall: true },
  { id: 'cloud_fallback', cfg: { cloud_concurrency: 1 }, after: { cloud_concurrency: 1 }, device: 'unavailable', source: 'IN_CLOUD',
    flow: baseFlow, retrySteps: CYCLE_RETRY, p2Self: CYCLE_P2SELF, checkStall: true },
  { id: 'cloud_only', cfg: { mode_status: 'ONLY_IN_CLOUD', cloud_concurrency: 1 }, after: { mode_status: 'ONLY_IN_CLOUD', cloud_concurrency: 1 },
    source: 'IN_CLOUD', flow: baseFlow, retrySteps: CYCLE_RETRY, p2Self: CYCLE_P2SELF, checkStall: true },
  { id: 'schema_reject', validator: 'reject_first', flow: baseFlow, retrySteps: CYCLE_RETRY, p2Self: CYCLE_P2SELF, checkStall: true },
  { id: 'device_gate', cfg: { mode_status: 'ONLY_ON_DEVICE' }, after: { mode_status: 'ONLY_ON_DEVICE' }, device: 'unavailable', deviceLater: 'available',
    flow: baseFlow, retrySteps: CYCLE_RETRY, p2Self: [...CYCLE_P2SELF, 'blocked'], checkStall: true },
  { id: 'refusal_dispatch', after: {}, flow: refusalDispatchFlow, retrySteps: [], p2Self: ['observe2', 'dispatch', 'resolve2', 'tail'], checkStall: true },
  { id: 'refusal_observe', cfg: { kill_switch_cloud: true, mode_status: 'ONLY_IN_CLOUD' }, after: {}, flow: refusalObserveFlow, retrySteps: [],
    p2Self: ['observe2', 'start2', 'resolve2', 'tail'], checkStall: true },
  { id: 'timeout', flow: timeoutFlow, retrySteps: ['start1', 'timeout'], p2Self: ['observe2', 'timeout', 'resolve2', 'tail'], checkStall: true },
  // checkStall off: the unregister-another-project stall is asserted by the dedicated REVIEW tests below.
  { id: 'unregister_other', flow: unregisterOtherFlow, retrySteps: [], p2Self: ['observe2', 'blocked', 'after'], checkStall: false, noP1Probe: true },
  { id: 'dispose', flow: disposeFlow, retrySteps: [], p2Self: [], checkStall: false, terminal: true },
];

// ---------------------------------------------------------------- the invariant runner
const LIVE_PORTS = new Set(['ledger', 'validator', 'store']);
function stallExpected(sc: Sc, f: Fault | null, firedStep: string): boolean {
  if (!sc.checkStall) return false;
  if (f === null) return true;
  const port = f.key.split('.')[0]!;
  return LIVE_PORTS.has(port) || (port === 'infer' && !sc.p2Self.includes(firedStep));
}

/** drain, then check V4..V7. `live` toggles the P2 stall assertion, `retry` the V6 assertion. */
async function finish(x: X, sc: Sc, v: string[], opts: { live: boolean; retry: boolean; probeP1: boolean }): Promise<void> {
  const src = sc.source ?? 'ON_DEVICE';
  x.c.step = 'drain';
  await drain(x, src);
  if (opts.live) {
    if (!x.c.started.has('P2')) v.push('V5 other project P2 never started (stall without wake-up)');
    if (snap(x).pending.length > 0) v.push('V5 pending work stranded after time passed: ' + snap(x).pending.map((j) => `${j.key.projectId}/${j.task}`).join(','));
  }
  if (inFlightTotal(x) !== 0) v.push('V4 lane/slot leaked: inFlight=' + JSON.stringify(snap(x).inFlight));
  if (opts.retry && srcRev(x, 'P1') !== 1) {
    pub(x, () => x.r.observe(ev('P1', 1)));
    await drain(x, src);
    if (srcRev(x, 'P1') !== 1) v.push('V6 retry intent lost: same-revision observe did not re-admit and publish P1@1');
  }
  // probe (V7): config restored, a fresh project and a newer revision of the faulted project
  if (sc.after !== undefined) pub(x, () => x.r.updateConfig({ ...CFG, ...sc.after }));
  x.c.step = 'probe';
  pub(x, () => x.r.observe(ev('PX', 1)));
  if (opts.probeP1) pub(x, () => x.r.observe(ev('P1', 5)));
  await drain(x, src);
  if (srcRev(x, 'PX') !== 1) v.push('V7 probe: fresh project PX was not published (permanent stall)');
  if (opts.probeP1 && srcRev(x, 'P1') !== 5) v.push('V7 probe: newer revision of P1 was not published');
  if (inFlightTotal(x) !== 0) v.push('V4 lane/slot leaked after probe: inFlight=' + JSON.stringify(snap(x).inFlight));
}
async function collect(x: X, v: string[]): Promise<void> {
  await settle();
  if (unhandled.length > 0) v.push(`V1 ${unhandled.length} unhandled rejection(s): ${unhandled.map((u) => (u instanceof Error ? u.message : typeof u)).join(' | ')}`);
  if (x.escapes.length > 0) v.push(`V2 ${x.escapes.length} exception(s) escaped a timer callback: ${x.escapes.map((e) => (e instanceof Error ? `${e.name}:${e.message}` : 'object')).join(' | ')}`);
  const foreign = x.thrown.filter((e) => !x.c.isInjected(e));
  if (foreign.length > 0) v.push(`V3 public call threw a non-injected error: ${foreign.map((e) => (e instanceof Error ? `${e.name}:${e.message}` : String(e))).join(' | ')}`);
}

// Optional triage aid: FI_DUMP=/path.json writes {rowName: violations[]} (not used by the suite itself).
const dump: Record<string, string[]> = {};
afterAll(() => { if (process.env['FI_DUMP']) writeFileSync(process.env['FI_DUMP'], JSON.stringify(dump, null, 1)); });
const show = (v: string[]): string => v.join(' ;; ');

async function runScenario(sc: Sc, fault: Fault | null): Promise<string[]> {
  const x = build(sc, fault);
  const v: string[] = [];
  await sc.flow(x, sc);
  if (fault !== null && !x.c.fired) v.push('matrix drift: fault never fired');
  if (sc.terminal) {
    await terminalChecks(x, sc, fault, v);
  } else {
    await finish(x, sc, v, {
      live: stallExpected(sc, fault, x.c.firedStep),
      retry: fault !== null && sc.retrySteps.includes(x.c.firedStep),
      probeP1: sc.noP1Probe !== true,
    });
  }
  await collect(x, v);
  dump[`${sc.id}|${fault ? `${fault.key}#${fault.nth}|${fault.kind}|@${x.c.firedStep}` : 'clean'}`] = v;
  return v;
}

async function terminalChecks(x: X, sc: Sc, fault: Fault | null, v: string[]): Promise<void> {
  // B17: after dispose nothing runs, publishes or counts, whatever failed during dispose itself.
  const cas0 = x.store.casCalls.length;
  const ledger0 = JSON.stringify(x.ledger.counts);
  x.c.step = 'late';
  const refused = pub(x, () => x.r.observe(ev('P2', 9)));
  if (refused === undefined || refused.kind !== 'REFUSE' || (refused as { reason?: string }).reason !== 'disposed') v.push('B17 observe after dispose did not REFUSE disposed');
  for (const call of x.infer.calls) if (!call.signal.aborted) v.push('B17 in-flight job not aborted by dispose');
  for (const call of x.infer.calls) call.resolve();
  await flush();
  await adv(x, 200000);
  if (x.store.casCalls.length !== cas0) v.push('B17 publication after dispose');
  if (JSON.stringify(x.ledger.counts) !== ledger0) v.push('B17 ledger effect after dispose');
  const timers = (x.clock as unknown as { timers: unknown[] }).timers.length;
  if (timers !== 0 && !(fault !== null && fault.kind === 'cancel_nonfn')) v.push(`B17 ${timers} timer(s) left armed after dispose`);
  void sc;
}

// ---------------------------------------------------------------- matrix generation (clean enumeration)
function sample(sites: Site[]): Site[] {
  const groups = new Map<string, Site[]>();
  for (const s of sites) { const k = `${s.key}|${s.step}|${s.arg ?? ''}`; const g = groups.get(k); if (g) g.push(s); else groups.set(k, [s]); }
  const out: Site[] = [];
  for (const g of groups.values()) {
    const idx = new Set<number>([0, 1, Math.floor(g.length / 2), g.length - 1]);
    for (const i of [...idx].sort((a, b) => a - b)) if (g[i]) out.push(g[i]!);
  }
  return out;
}
async function measure(sc: Sc): Promise<Site[]> {
  const x = build(sc, null);
  await sc.flow(x, sc);
  return x.c.log.filter((s) => KINDS[s.key] !== undefined);
}
interface Row { name: string; sc: Sc; fault: Fault }
const rows: Row[] = [];
const sitesByScenario = new Map<string, Site[]>();
for (const sc of SCENARIOS) {
  const all = await measure(sc);
  sitesByScenario.set(sc.id, all);
  for (const s of sample(all)) {
    for (const kind of KINDS[s.key]!) {
      rows.push({ name: `${sc.id} | ${s.key}#${s.nth}${s.arg ? `(${s.arg})` : ''} @${s.step} | ${kind}`, sc, fault: { key: s.key, nth: s.nth, kind } });
    }
  }
}
const siteIn = (scId: string, key: string, step: string, arg?: string): Site => {
  const s = sitesByScenario.get(scId)!.find((q) => q.key === key && q.step === step && (arg === undefined || q.arg === arg));
  if (!s) throw new Error(`no site ${scId} ${key} @${step}`);
  return s;
};

describe('FI-0 baseline: every scenario is clean without faults (matrix control)', () => {
  it.each(SCENARIOS.map((s) => ({ id: s.id, sc: s })))('$id', async ({ sc }) => {
    expect(show(await runScenario(sc, null))).toBe('');
  });
});

describe('FI-1 fault matrix: scenario x port call site x fault kind', () => {
  it.each(rows)('$name', async ({ sc, fault }) => {
    expect(show(await runScenario(sc, fault))).toBe('');
  });
});

// ---------------------------------------------------------------- review-concrete BLOCKING inputs
describe('FI-2 REVIEW BLOCKING 1: unregistering another project must wake the scheduler (no external action)', () => {
  const variants: Array<{ name: string; cfg: Partial<ReconcileConfig> }> = [
    { name: 'on_device lane full', cfg: {} },
    { name: 'cloud lane full', cfg: { mode_status: 'ONLY_IN_CLOUD', cloud_concurrency: 1 } },
    { name: 'on_device lane full, queue_max_depth_factor 1', cfg: { queue_max_depth_factor: 1 } },
  ];
  it.each(variants)('$name', async ({ cfg }) => {
    const h = makeHarness({ projects: ['P1', 'P2'], cfg });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);                    // P1 starts
    expect(h.infer.calls.length).toBe(1);
    h.r.observe(ev('P2', 1));
    await h.clock.advance(0);                    // zero-delay dispatch meets lane_full
    expect(h.infer.calls.length).toBe(1);
    h.r.unregisterProject('P1');                 // frees the lane
    await h.clock.advance(1);                    // only time passes, no further public call
    expect(h.infer.calls.map((c) => c.req.key.projectId)).toEqual(['P1', 'P2']);
    expect(h.r.snapshot().pending).toEqual([]);
  });
  it('same stall when the lane is freed by unregistering a project that only had a queued job (bound shrink path)', async () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'], cfg: { queue_max_depth_factor: 1 } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P2', 1));
    h.r.observe(ev('P3', 1));
    await h.clock.advance(0);
    h.r.unregisterProject('P1');
    await h.clock.advance(1);
    expect(h.infer.calls.map((c) => c.req.key.projectId)).toContain('P2');
  });
});

describe('FI-3 REVIEW BLOCKING 2: throwing publication dependencies never escape the outcome continuation', () => {
  const targets: Array<{ key: string; arg?: string }> = [
    { key: 'ledger.inc', arg: 'on_device' }, { key: 'store.read' }, { key: 'store.currentIncarnation' }, { key: 'store.compareAndPublish' },
  ];
  const table = targets.flatMap((t) => (['throw', 'throw_hostile', 'getter'] as Kind[]).map((kind) => ({ ...t, kind, name: `${t.key}${t.arg ? `(${t.arg})` : ''} ${kind}` })));
  it.each(table)('$name while a valid job resolves', async ({ key, arg, kind }) => {
    const s = siteIn('cycle', key, 'resolve1', arg);
    expect(show(await runScenario(SCENARIOS[0]!, { key, nth: s.nth, kind }))).toBe('');
  });
  it('ledger.inc throws new Error("ledger unavailable") on success: no unhandled rejection, lane free, revision re-admitted', async () => {
    const sc = SCENARIOS[0]!;
    const s = siteIn('cycle', 'ledger.inc', 'resolve1', 'on_device');
    const x = build(sc, { key: 'ledger.inc', nth: s.nth, kind: 'throw' });
    await sc.flow(x, sc);
    await settle();
    expect(unhandled).toEqual([]);
    expect(inFlightTotal(x)).toBe(0);
    x.r.observe(ev('P1', 1));
    await drain(x);
    expect(srcRev(x, 'P1')).toBe(1);
  });
});

// ---------------------------------------------------------------- state-based table: hostile caller-supplied objects
describe('FI-4 freshness(): a failing store.read means missing evidence, so stale (B15); never throws', () => {
  const kinds: Kind[] = ['throw', 'throw_hostile', 'getter', 'read_hostile'];
  const table = kinds.flatMap((kind) => [true, false].map((seeded) => ({ kind, seeded, name: `${kind} seeded=${seeded}` })));
  it.each(table)('$name', ({ kind, seeded }) => {
    const x = build(SCENARIOS[0]!, { key: 'store.read', nth: 1, kind });
    if (seeded) x.store.seed('P1', { rev: 1, observed_rev: 1, source_observed_rev: 1 });
    let out: unknown;
    let threw: unknown;
    try { out = x.r.freshness('P1'); } catch (e) { threw = e; }
    expect(threw).toBeUndefined();
    expect(out).toBe('stale');
  });
});

describe('FI-5 caller-supplied ObservedEvent accessors: a throwing field read leaves the reconciler consistent', () => {
  const FIELDS = ['projectId', 'incarnation', 'observedRev', 'templateHash', 'tier', 'task'] as const;
  type Phase = 'new' | 'coalesce';
  const counter = (base: ObservedEvent, onGet: (p: string) => void): ObservedEvent =>
    new Proxy(base, { get(t, p, r): unknown { if (typeof p === 'string') onGet(p); return Reflect.get(t, p, r); } });
  const reads = new Map<string, number>();
  for (const phase of ['new', 'coalesce'] as Phase[]) {
    const x = build(SCENARIOS[0]!, null);
    if (phase === 'coalesce') x.r.observe(ev('P1', 1));
    const n = new Map<string, number>();
    x.r.observe(counter(ev('P1', phase === 'new' ? 1 : 2), (p) => n.set(p, (n.get(p) ?? 0) + 1)));
    for (const f of FIELDS) reads.set(`${phase}|${f}`, n.get(f) ?? 0);
  }
  const table: Array<{ name: string; phase: Phase; field: (typeof FIELDS)[number]; nth: number }> = [];
  for (const phase of ['new', 'coalesce'] as Phase[]) for (const field of FIELDS) {
    const total = reads.get(`${phase}|${field}`) ?? 0;
    const idx = new Set([1, 2, Math.ceil(total / 2), total].filter((i) => i >= 1 && i <= total));
    for (const nth of [...idx].sort((a, b) => a - b)) table.push({ name: `${phase} | ev.${field} getter throws on read#${nth}/${total}`, phase, field, nth });
  }
  it.each(table)('$name', async ({ phase, field, nth }) => {
    const sc: Sc = { ...SCENARIOS[0]! };
    const x = build(sc, null);
    if (phase === 'coalesce') pub(x, () => x.r.observe(ev('P1', 1)));
    let n = 0;
    const poisoned = new Proxy(ev('P1', phase === 'new' ? 1 : 2), {
      get(t, p, r): unknown { if (p === field && ++n === nth) throw x.c.err; return Reflect.get(t, p, r); },
    });
    pub(x, () => x.r.observe(poisoned));
    const v: string[] = [];
    await finish(x, sc, v, { live: false, retry: false, probeP1: true });
    const s = snap(x);
    const slots = s.pending.map((j) => `${j.key.projectId}/${j.task}`);
    if (new Set(slots).size !== slots.length) v.push('B3 duplicate pending job for one slot');
    if (s.pending.length > s.bound) v.push('B4 pending exceeds bound');
    await collect(x, v);
    expect(show(v)).toBe('');
  });
});

describe('FI-6 caller-supplied ReconcileConfig accessors', () => {
  const FIELDS: Array<keyof ReconcileConfig> = ['ondevice_concurrency', 'cloud_concurrency', 'min_inference_interval_ms', 'queue_max_depth_factor',
    'prompt_version', 'kill_switch_cloud', 'mode_status', 'mode_summary', 'mode_next_action', 'mode_screenshot', 'inference_timeout_ms'];
  const poison = (cfg: ReconcileConfig, field: keyof ReconcileConfig, armed: { on: boolean }, err: Error, nthOnly?: number): ReconcileConfig => {
    let n = 0;
    return new Proxy(cfg, { get(t, p, r): unknown {
      if (p === field && armed.on) { if (nthOnly === undefined || ++n === nthOnly) throw err; }
      return Reflect.get(t, p, r);
    } });
  };
  const runCycle = async (x: X, sc: Sc): Promise<string[]> => {
    const v: string[] = [];
    await baseFlow(x, sc);
    await finish(x, sc, v, { live: true, retry: false, probeP1: true });
    await collect(x, v);
    return v;
  };
  it.each(FIELDS.map((f) => ({ f })))('config.$f made to throw after createReconciler (caller mutates its object later): behaviour unchanged', async ({ f }) => {
    const armed = { on: false };
    const holder: { err?: Error } = {};
    const sc = SCENARIOS[0]!;
    const x = build(sc, null, (cfg) => { holder.err = new Error('cfg'); return poison(cfg, f, armed, holder.err); });
    armed.on = true;
    x.c.fired = true;                      // no port fault in this table; mark so isInjected maps cfg error below
    const orig = x.c.isInjected.bind(x.c);
    x.c.isInjected = (e: unknown): boolean => orig(e) || e === holder.err;
    expect(show(await runCycle(x, sc))).toBe('');
  });
  it.each(FIELDS.map((f) => ({ f })))('config.$f made to throw after a later updateConfig(): behaviour unchanged', async ({ f }) => {
    const armed = { on: false };
    const err = new Error('cfg');
    const sc = SCENARIOS[0]!;
    const x = build(sc, null);
    const next = poison({ ...CFG, prompt_version: 'v1' }, f, armed, err);
    pub(x, () => x.r.updateConfig(next));
    armed.on = true;
    const orig = x.c.isInjected.bind(x.c);
    x.c.isInjected = (e: unknown): boolean => orig(e) || e === err;
    expect(show(await runCycle(x, sc))).toBe('');
  });
  it.each(FIELDS.flatMap((f) => [1, 2].map((nth) => ({ f, nth }))))('updateConfig(): config.$f getter throws on read#$nth; reconciler stays operational', async ({ f, nth }) => {
    const armed = { on: true };
    const err = new Error('cfg');
    const sc = SCENARIOS[0]!;
    const x = build(sc, null);
    pub(x, () => x.r.updateConfig(poison({ ...CFG }, f, armed, err, nth)));
    armed.on = false;
    const orig = x.c.isInjected.bind(x.c);
    x.c.isInjected = (e: unknown): boolean => orig(e) || e === err;
    expect(show(await runCycle(x, sc))).toBe('');
  });
});

describe('FI-7 hostile projectId objects (toJSON throws): register/observe/unregister/freshness stay consistent', () => {
  const hostileId = (err: Error): unknown => ({ toJSON(): never { throw err; }, toString(): never { throw err; } });
  const calls: Array<{ name: string; run: (r: Reconciler, id: never) => unknown }> = [
    { name: 'registerProject', run: (r, id) => r.registerProject(id) },
    { name: 'observe (after register)', run: (r, id) => { r.registerProject(id); return r.observe({ ...ev('P1', 1), projectId: id } as ObservedEvent); } },
    { name: 'unregisterProject (after register)', run: (r, id) => { r.registerProject(id); return r.unregisterProject(id); } },
    { name: 'freshness', run: (r, id) => r.freshness(id) },
  ];
  it.each(calls)('$name', async ({ run }) => {
    const sc: Sc = { ...SCENARIOS[0]! };
    const x = build(sc, null);
    const err = x.c.err;
    pub(x, () => run(x.r, hostileId(err) as never));
    const v: string[] = [];
    await finish(x, sc, v, { live: false, retry: false, probeP1: true });
    await collect(x, v);
    expect(show(v)).toBe('');
  });
});

// Matrix size is printed so the ORACLE can quote it.
describe('FI-8 matrix census', () => {
  it('reports size', () => {
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.fault.key, (per.get(r.fault.key) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.log('FI matrix rows', rows.length, JSON.stringify(Object.fromEntries(per)));
    expect(rows.length).toBeGreaterThan(0);
  });
});
