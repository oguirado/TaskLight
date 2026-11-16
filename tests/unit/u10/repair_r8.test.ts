// Repair r8 (cross-family review r7, BLOCKING): the final publication guard must be
// re-validated after the LAST injected callback (store.currentIncarnation /
// store.read) and immediately before CAS. Public API + harness fakes only.
// Threat model DISP_03: all faults here are our own synchronous ports re-entering
// the reconciler (item 5: races between our own async steps).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ev, flush, makeHarness, type Harness } from './harness';

afterEach(() => vi.unstubAllGlobals());

type Method = 'read' | 'currentIncarnation';
type Mutation = 'private' | 'unregister' | 'incarnation';

/**
 * Cloud summary job; once in_cloud is counted, the n-th later call of `method`
 * runs `mutate` (and still returns the pre-mutation underlying value).
 * n = 0 means no mutation (probe: counts calls after the ledger increment).
 */
async function scenario(method: Method, n: number, mutation: Mutation | null) {
  const h: Harness = makeHarness({ cfg: { mode_summary: 'PREFER_IN_CLOUD' } });
  let armed = false;
  let calls = 0;
  let fired = false;
  const mutate = (): void => {
    if (mutation === 'private') h.r.observe(ev('P1', 2, { task: 'status', tier: 'private' }));
    else if (mutation === 'unregister') h.r.unregisterProject('P1');
    else if (mutation === 'incarnation') h.store.inc.set('P1', 'B');
  };
  const origInc = h.ledger.inc.bind(h.ledger);
  h.ledger.inc = (c) => { origInc(c); if (c === 'in_cloud') armed = true; };
  const orig = (h.store[method] as (p: string) => unknown).bind(h.store);
  (h.store as unknown as Record<string, unknown>)[method] = (p: string) => {
    const v = orig(p);
    if (armed) {
      calls++;
      if (n > 0 && calls === n && mutation !== null) { fired = true; mutate(); }
    }
    return v;
  };
  h.r.observe(ev('P1', 1, { task: 'summary' }));
  await h.clock.advance(0);
  expect(h.infer.calls.length).toBe(1);
  h.infer.calls[0]!.resolve({ inferenceSource: 'IN_CLOUD' });
  await flush();
  await h.clock.advance(20000);
  return { h, calls, fired };
}

for (const method of ['read', 'currentIncarnation'] as Method[]) {
  describe(`R8-1 publication guard re-checked after store.${method}`, () => {
    it('probe: the guard calls the port after the cloud ledger increment (non-vacuous)', async () => {
      const { calls } = await scenario(method, 0, null);
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    for (const mutation of ['private', 'unregister', 'incarnation'] as Mutation[]) {
      it(`${mutation} change during every post-ledger ${method} call blocks publication`, async () => {
        const probe = await scenario(method, 0, null);
        for (let n = 1; n <= probe.calls; n++) {
          // Amendment A1-U10r8 (orchestrator): an incarnation change on the LAST store read before CAS is a
          // TOCTOU only the atomic compareAndPublish port can close (port contract, execution/ACCEPTANCE_SCOPE.md);
          // the reconciler cannot observe it, so that single position is excluded here.
          if (mutation === 'incarnation' && method === 'currentIncarnation' && n === probe.calls) continue;
          const { h, fired } = await scenario(method, n, mutation);
          expect(fired, `hook ${n} fired`).toBe(true);
          const cloud = h.store.casCalls.filter((c) => c.result && c.next.inference_source === 'IN_CLOUD');
          expect(cloud, `${mutation}@${method}#${n}: cloud publication`).toHaveLength(0);
          if (mutation !== 'private') {
            expect(h.store.casCalls, `${mutation}@${method}#${n}: CAS attempted`).toHaveLength(0);
            expect(h.store.caps.get('P1'), `${mutation}@${method}#${n}: capsule`).toBeUndefined();
          }
        }
      });
    }
  });
}
