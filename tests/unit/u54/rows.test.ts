// U54 O7: checkG10 NON_DEVICE_UNDER_DEVICE_FLOOR (SPEC_U54 section 5).
import { describe, expect, it } from 'vitest';
import { checkG10, createRowLog } from '../../../src/ledger';
import type { LedgerRow } from '../../../src/ledger';

const row = (o: Record<string, unknown> = {}): LedgerRow => ({
  jobKey: 'j1', projectId: 'p1', lens_id: 'dev', task: 'summary', source: 'agent', tier: 'standard',
  floor: null, requested: 'PREFER_IN_CLOUD', effective: 'PREFER_IN_CLOUD', inference_source: 'ON_DEVICE', ...o,
}) as unknown as LedgerRow;

const DEVICE_FLOORS: [string, Record<string, unknown>][] = [
  ['floor ONLY_ON_DEVICE', { floor: 'ONLY_ON_DEVICE', effective: 'ONLY_ON_DEVICE' }],
  ['only floor', { floor: 'ONLY_ON_DEVICE', effective: 'PREFER_IN_CLOUD' }],
  ['only effective', { floor: null, effective: 'ONLY_ON_DEVICE' }],
];

describe('O7 non-device source under a device floor', () => {
  for (const [name, over] of DEVICE_FLOORS) {
    it.each(['LOCAL_SERVER', 'REMOTE_PROVIDER', 'OTHER', 'on_device', 'local_server', 'in_cloud'])(`${name}: %s -> NON_DEVICE_UNDER_DEVICE_FLOOR`, (src) => {
      const ctl = checkG10([row({ ...over, inference_source: 'ON_DEVICE' })]); expect(ctl.ok).toBe(true);
      const r = checkG10([row({ ...over, inference_source: src })]);
      expect(r.ok).toBe(false);
      expect(r.violations).toEqual([{ row: 0, code: 'NON_DEVICE_UNDER_DEVICE_FLOOR' }]);
    });
  }
  it('null source (skipped job) and ON_DEVICE are ok under a device floor', () => {
    expect(checkG10([row({ ...DEVICE_FLOORS[0]![1], inference_source: null })])).toEqual({ ok: true, violations: [] });
    expect(checkG10([row({ ...DEVICE_FLOORS[0]![1], inference_source: 'ON_DEVICE' })])).toEqual({ ok: true, violations: [] });
  });
  it('IN_CLOUD keeps CLOUD_UNDER_DEVICE_FLOOR (code unchanged)', () => {
    expect(checkG10([row({ ...DEVICE_FLOORS[0]![1], inference_source: 'IN_CLOUD' })]).violations)
      .toEqual([{ row: 0, code: 'CLOUD_UNDER_DEVICE_FLOOR' }]);
  });
  it('external/unknown sources without a device floor are not violations', () => {
    for (const src of ['LOCAL_SERVER', 'REMOTE_PROVIDER']) {
      expect(checkG10([row({ inference_source: src })])).toEqual({ ok: true, violations: [] });
      expect(checkG10([row({ floor: 'PREFER_ON_DEVICE', effective: 'PREFER_ON_DEVICE', inference_source: src })]).ok).toBe(true);
    }
  });
  it('reports every offending row with its index, mixed codes, in order', () => {
    const f = DEVICE_FLOORS[0]![1];
    const rows = [row({ ...f, inference_source: 'LOCAL_SERVER' }), row({ ...f }), row({ ...f, inference_source: 'IN_CLOUD' }), row({ ...f, inference_source: 'REMOTE_PROVIDER' })];
    expect(checkG10(rows)).toEqual({ ok: false, violations: [
      { row: 0, code: 'NON_DEVICE_UNDER_DEVICE_FLOOR' }, { row: 2, code: 'CLOUD_UNDER_DEVICE_FLOOR' }, { row: 3, code: 'NON_DEVICE_UNDER_DEVICE_FLOOR' }] });
  });
  it('the row log check() reports it and never throws on hostile rows', () => {
    const log = createRowLog();
    log.record(row({ jobKey: 'a', ...DEVICE_FLOORS[0]![1], inference_source: 'REMOTE_PROVIDER' }));
    expect(log.check().violations).toEqual([{ row: 0, code: 'NON_DEVICE_UNDER_DEVICE_FLOOR' }]);
    expect(() => checkG10([null as never, 5 as never, {} as never])).not.toThrow();
  });
});
