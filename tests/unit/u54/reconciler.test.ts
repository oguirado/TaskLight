// U54 O1, O2, O3, O8: reconciler consumes the 4 sources fail-closed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceMode, PrivacyTier, CapsuleTask } from '../../../src/reconcile/types';
import {
  EXT_COUNTER, EXTERNAL, ExtLedger, OldLedger, ev, fresh, makeH, published, runJob, flush,
  type Scenario, type Src,
} from './harness';

afterEach(() => vi.unstubAllGlobals());

const STD: Scenario = { tier: 'standard', task: 'status', mode: 'PREFER_IN_CLOUD' };

describe('O1 standard tier publishes external sources', () => {
  it.each(EXTERNAL)('%s under PREFER_IN_CLOUD publishes with that inference_source', async (src) => {
    const h = await fresh(STD, src);
    expect(h.store.read('P1')?.rev).toBe(1);
    expect(h.store.read('P1')?.inference_source).toBe(src);
  });
  it.each(['MARS', 'on_device', 'local_server', '', 5, null, undefined] as unknown[])(
    'unknown source %j is still malformed: nothing published, nothing counted', async (src) => {
      const h = await fresh(STD, src as string);
      expect(h.store.casCalls.length).toBe(0);
      expect(h.ledger.total).toBe(0);
    });
});

describe('O2 stop rule 1: external/cloud sources blocked where policy forbids them', () => {
  interface Block { name: string; sc: Scenario; src: Src }
  const blocks: Block[] = [
    ...(['IN_CLOUD', 'LOCAL_SERVER', 'REMOTE_PROVIDER'] as Src[]).map((src): Block => ({
      name: `private x ${src}`, sc: { tier: 'private', task: 'status', mode: 'PREFER_IN_CLOUD' }, src })),
    ...EXTERNAL.map((src): Block => ({
      name: `screenshot x ${src}`, sc: { tier: 'standard', task: 'screenshot', mode: 'PREFER_IN_CLOUD' }, src })),
    ...EXTERNAL.map((src): Block => ({
      name: `ONLY_ON_DEVICE x ${src}`, sc: { tier: 'standard', task: 'status', mode: 'ONLY_ON_DEVICE' }, src })),
    { name: 'shared x REMOTE_PROVIDER', sc: { tier: 'shared', task: 'status', mode: 'PREFER_IN_CLOUD' }, src: 'REMOTE_PROVIDER' },
  ];
  it.each(blocks)('$name: store unchanged, no counter (and the same source publishes in a permitted config)', async ({ sc, src }) => {
    // non-vacuity: the control must publish, otherwise "blocked" would hold just because the value is rejected as malformed
    const ctl = await fresh({ tier: 'standard', task: 'status', mode: 'PREFER_IN_CLOUD' }, src);
    expect(published(ctl)).toBe(true);
    const h = await fresh(sc, src);
    expect(h.store.casCalls.length).toBe(0);
    expect(h.store.read('P1')).toBeUndefined();
    expect(h.ledger.total).toBe(0);
  });

  it('shared x LOCAL_SERVER publishes (only REMOTE_PROVIDER is refused for shared)', async () => {
    const h = await fresh({ tier: 'shared', task: 'status', mode: 'PREFER_IN_CLOUD' }, 'LOCAL_SERVER');
    expect(h.store.read('P1')?.inference_source).toBe('LOCAL_SERVER');
  });

  describe.each(EXTERNAL)('tier promoted to private by a ledger callback (%s)', (src) => {
    it('inside incExternal: not published', async () => {
      const ctl = await fresh(STD, src); expect(published(ctl)).toBe(true);
      const ledger = new ExtLedger();
      const h = makeH({ ledger, cfg: { mode_status: 'PREFER_IN_CLOUD' } });
      const orig = ledger.incExternal.bind(ledger);
      ledger.incExternal = (c) => { orig(c); h.r.observe(ev('P1', 2, { tier: 'private' })); };
      await runJob(h, STD, src);
      expect(ledger.ext.length).toBe(1);
      expect(h.store.casCalls.filter((c) => c.result).length).toBe(0);
      expect(h.store.read('P1')).toBeUndefined();
    });
    it('inside inc("fallbacks") (PREFER_ON_DEVICE): not published', async () => {
      const ctl = await fresh({ ...STD, mode: 'PREFER_ON_DEVICE' }, src); expect(published(ctl)).toBe(true);
      const ledger = new ExtLedger();
      const h = makeH({ ledger, cfg: { mode_status: 'PREFER_ON_DEVICE' } });
      const orig = ledger.inc.bind(ledger);
      ledger.inc = (c) => { orig(c); if (c === 'fallbacks') h.r.observe(ev('P1', 2, { tier: 'private' })); };
      await runJob(h, { ...STD, mode: 'PREFER_ON_DEVICE' }, src);
      expect(ledger.counts.fallbacks).toBe(1);
      expect(h.store.read('P1')).toBeUndefined();
    });
  });
  it('control (old behaviour): IN_CLOUD with tier promoted inside inc("in_cloud") is not published', async () => {
    const ledger = new ExtLedger();
    const h = makeH({ ledger, cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    const orig = ledger.inc.bind(ledger);
    ledger.inc = (c) => { orig(c); if (c === 'in_cloud') h.r.observe(ev('P1', 2, { tier: 'private' })); };
    await runJob(h, STD, 'IN_CLOUD');
    expect(h.store.read('P1')).toBeUndefined();
  });
});

describe('O3 ledger: external counted via incExternal, never as in_cloud', () => {
  it.each(EXTERNAL)('%s: in_cloud 0, on_device 0, incExternal once with the matching counter', async (src) => {
    const h = await fresh(STD, src);
    expect(h.store.read('P1')?.rev).toBe(1);
    expect(h.ledger.counts).toEqual({ on_device: 0, in_cloud: 0, fallbacks: 0, refusals: 0, schema_rejects: 0 });
    expect(h.ledger.ext).toEqual([EXT_COUNTER[src]]);
  });
  it.each(EXTERNAL)('%s under PREFER_ON_DEVICE: fallbacks 1 (source !== ON_DEVICE) plus the external count', async (src) => {
    const h = await fresh({ ...STD, mode: 'PREFER_ON_DEVICE' }, src);
    expect(h.store.read('P1')?.rev).toBe(1);
    expect(h.ledger.counts.fallbacks).toBe(1);
    expect(h.ledger.counts.in_cloud).toBe(0);
    expect(h.ledger.ext).toEqual([EXT_COUNTER[src]]);
  });
  it.each(EXTERNAL)('%s with a ledger port lacking incExternal: publishes, no throw, nothing counted', async (src) => {
    const led = new OldLedger();
    const h = await fresh(STD, src, led);
    expect(h.store.read('P1')?.inference_source).toBe(src);
    expect(led.total).toBe(0);
  });
  it('port without incExternal under PREFER_ON_DEVICE still counts fallbacks only', async () => {
    const led = new OldLedger();
    const h = await fresh({ ...STD, mode: 'PREFER_ON_DEVICE' }, 'REMOTE_PROVIDER', led);
    expect(h.store.read('P1')?.rev).toBe(1);
    expect(led.counts).toEqual({ on_device: 0, in_cloud: 0, fallbacks: 1, refusals: 0, schema_rejects: 0 });
  });
  it.each(EXTERNAL)('%s: a throwing incExternal drops the result (same semantics as ledgerOrBlock)', async (src) => {
    const ctl = await fresh(STD, src); expect(published(ctl)).toBe(true);
    const ledger = new ExtLedger();
    ledger.incExternal = () => { throw new Error('ledger down'); };
    const h = await fresh(STD, src, ledger);
    expect(h.store.casCalls.length).toBe(0);
    expect(h.store.read('P1')).toBeUndefined();
  });
  it('old sources never call incExternal', async () => {
    const a = await fresh(STD, 'ON_DEVICE'); const b = await fresh(STD, 'IN_CLOUD');
    expect(a.ledger.ext).toEqual([]); expect(b.ledger.ext).toEqual([]);
    expect(a.ledger.counts.on_device).toBe(1); expect(b.ledger.counts.in_cloud).toBe(1);
  });
});

describe('O8 regression: 3 tiers x 4 modes x {ON_DEVICE, IN_CLOUD} equal pre-U54 behaviour', () => {
  const tiers: PrivacyTier[] = ['private', 'standard', 'shared'];
  const modes: InferenceMode[] = ['PREFER_ON_DEVICE', 'ONLY_ON_DEVICE', 'PREFER_IN_CLOUD', 'ONLY_IN_CLOUD'];
  const cases: [PrivacyTier, InferenceMode, 'ON_DEVICE' | 'IN_CLOUD'][] = [];
  for (const t of tiers) for (const m of modes) for (const s of ['ON_DEVICE', 'IN_CLOUD'] as const) cases.push([t, m, s]);
  it.each(cases)('%s / %s / %s', async (tier, mode, src) => {
    const task: CapsuleTask = 'status';
    const h = await fresh({ tier, task, mode }, src);
    // pre-U54 model: only private x IN_CLOUD is blocked; private forces ONLY_ON_DEVICE
    const effMode: InferenceMode = tier === 'private' ? 'ONLY_ON_DEVICE' : mode;
    const blocked = tier === 'private' && src === 'IN_CLOUD';
    if (blocked) {
      expect(h.store.casCalls.length).toBe(0);
      expect(h.ledger.total).toBe(0);
      return;
    }
    expect(h.store.read('P1')?.rev).toBe(1);
    expect(h.store.read('P1')?.inference_source).toBe(src);
    expect(h.ledger.counts).toEqual({
      on_device: src === 'ON_DEVICE' ? 1 : 0,
      in_cloud: src === 'IN_CLOUD' ? 1 : 0,
      fallbacks: effMode === 'PREFER_ON_DEVICE' && src === 'IN_CLOUD' ? 1 : 0,
      refusals: 0, schema_rejects: 0,
    });
    expect(h.ledger.ext).toEqual([]);
  });
  it('screenshot task with IN_CLOUD under a cloud-permitting mode is not newly blocked (only external is)', async () => {
    const h = await fresh({ tier: 'standard', task: 'screenshot', mode: 'PREFER_IN_CLOUD' }, 'IN_CLOUD');
    expect(h.store.read('P1')?.inference_source).toBe('IN_CLOUD');
    expect(h.ledger.counts.in_cloud).toBe(1);
  });
  it('standard IN_CLOUD under ONLY_ON_DEVICE is unchanged (published, as before)', async () => {
    const h = await fresh({ tier: 'standard', task: 'status', mode: 'ONLY_ON_DEVICE' }, 'IN_CLOUD');
    expect(h.store.read('P1')?.inference_source).toBe('IN_CLOUD');
  });
  void flush;
});
