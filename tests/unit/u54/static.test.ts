// U54 O8 (type-level facts read from source) and frozen-type guards.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INFERENCE_SOURCE } from '../../../src/schema/enums';

const src = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('frozen type literals', () => {
  it('reconcile InferenceSource = INFERENCE_SOURCE, same order (needs U46 enums)', () => {
    const m = /export type InferenceSource\s*=\s*([^;]+);/.exec(src('src/reconcile/types.ts'));
    expect(m).not.toBeNull();
    const vals = [...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(vals).toEqual(['ON_DEVICE', 'IN_CLOUD', 'LOCAL_SERVER', 'REMOTE_PROVIDER']);
    expect(vals).toEqual([...INFERENCE_SOURCE]);
  });
  it('reconcile/types.ts keeps no src/schema import and declares ExternalLedgerCounter + optional incExternal', () => {
    const t = src('src/reconcile/types.ts');
    expect(t).not.toMatch(/from\s+['"][^'"]*schema/);
    expect(t).toMatch(/ExternalLedgerCounter\s*=\s*'local_server'\s*\|\s*'remote_provider'/);
    expect(t).toMatch(/incExternal\?\s*\(/);
    expect(t).toMatch(/LedgerCounter\s*=\s*'on_device'\s*\|\s*'in_cloud'\s*\|\s*'fallbacks'\s*\|\s*'refusals'\s*\|\s*'schema_rejects'/);
  });
  it('sync/types.ts: origin has 5 values and RefuseCode gains the two digest codes', () => {
    const t = src('src/sync/types.ts');
    expect(t).toMatch(/"LOCAL_SERVER"/); expect(t).toMatch(/"REMOTE_PROVIDER"/);
    expect(t).toMatch(/"DIGEST_BAD_ORIGIN"/); expect(t).toMatch(/"DIGEST_REMOTE_SHARED"/);
  });
  it('ledger/types.ts G10Violation gains NON_DEVICE_UNDER_DEVICE_FLOOR, keeps the old three', () => {
    const t = src('src/ledger/types.ts');
    for (const c of ['CLOUD_UNDER_DEVICE_FLOOR', 'NON_DEVICE_UNDER_DEVICE_FLOOR', 'TEXT_SYNCED_PRIVATE', 'TEXT_SYNCED_PAGE']) expect(t).toContain(c);
  });
  it('agents/types.ts DriftSource has the 4 literals; agentsui drift.source adds rules', () => {
    const t = src('src/agents/types.ts');
    expect(t).toMatch(/DriftSource\s*=\s*"device"\s*\|\s*"cloud"\s*\|\s*"local"\s*\|\s*"remote"/);
    expect(src('src/agentsui/types.ts')).toMatch(/"device"\s*\|\s*"cloud"\s*\|\s*"local"\s*\|\s*"remote"\s*\|\s*"rules"/);
  });
});
