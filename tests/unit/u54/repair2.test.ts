// U54 repair loop 2 (review HOLD): cross-task observations must not move non-private project
// tier policy backwards in revision order. A project-wide governing revision gates tier changes.
// Equal-revision rule (pinned): at the governing revision a non-private observation may only
// tighten (standard -> shared), never loosen (shared -> standard). Private is always sticky.
import { describe, expect, it } from 'vitest';
import { ev, flush, makeH, published } from './harness';

const CFG = { mode_status: 'PREFER_IN_CLOUD' as const };
type T = 'standard' | 'shared' | 'private';

/** status rev 1 (standard) in flight, then `obs` observed in order, then rev-1 resolves with `src`. */
async function seq(obs: [number, T, 'status' | 'summary'][], src = 'REMOTE_PROVIDER') {
  const h = makeH({ cfg: CFG });
  h.r.observe(ev('P1', 1, { tier: 'standard', task: 'status' }));
  await h.clock.advance(0);
  expect(h.infer.calls.length).toBe(1);
  for (const [rev, tier, task] of obs) h.r.observe(ev('P1', rev, { tier, task: task as never }));
  h.infer.calls[0]!.resolve({ inferenceSource: src as never });
  await flush();
  await h.clock.advance(0);
  return h;
}
const blocked = (h: Awaited<ReturnType<typeof seq>>) => {
  expect(published(h)).toBe(false);
  expect(h.ledger.ext).toEqual([]);
};

describe('A-U54r2 reconciler: project tier governed by project-wide revision', () => {
  it('BLOCKING: shared rev 3 (summary) then stale standard rev 2 (status): REMOTE_PROVIDER not published/counted', async () => {
    blocked(await seq([[3, 'shared', 'summary'], [2, 'standard', 'status']]));
  });
  it('stale standard rev 2 repeated (slot-equal re-observe) stays blocked', async () => {
    blocked(await seq([[3, 'shared', 'summary'], [2, 'standard', 'status'], [2, 'standard', 'status']]));
  });
  it('control: genuinely newer standard rev 4 after shared rev 3 replaces shared; REMOTE_PROVIDER publishes', async () => {
    const h = await seq([[3, 'shared', 'summary'], [4, 'standard', 'status']]);
    expect(published(h)).toBe(true);
    expect(h.ledger.ext).toEqual(['remote_provider']);
  });
  it('equal revision: standard rev 3 (status) after shared rev 3 (summary) does not loosen', async () => {
    blocked(await seq([[3, 'shared', 'summary'], [3, 'standard', 'status']]));
  });
  it('equal revision: shared rev 3 (summary) after standard rev 3 (status) tightens', async () => {
    blocked(await seq([[3, 'standard', 'status'], [3, 'shared', 'summary']]));
  });
  it('control: LOCAL_SERVER under shared still publishes after the stale standard', async () => {
    const h = await seq([[3, 'shared', 'summary'], [2, 'standard', 'status']], 'LOCAL_SERVER');
    expect(published(h)).toBe(true);
    expect(h.ledger.ext).toEqual(['local_server']);
  });
  it('private below the governing revision still promotes (sticky): IN_CLOUD blocked', async () => {
    const h = await seq([[3, 'shared', 'summary'], [2, 'private', 'status']], 'IN_CLOUD');
    expect(published(h)).toBe(false);
    expect(h.ledger.counts.in_cloud).toBe(0);
  });
  it('unregister clears the governing revision: re-registered standard rev 1 governs again', async () => {
    const h = makeH({ cfg: CFG });
    h.r.observe(ev('P1', 5, { tier: 'shared', task: 'summary' as never }));
    h.r.unregisterProject('P1');
    h.r.registerProject('P1');
    h.r.observe(ev('P1', 1, { tier: 'standard', task: 'next_action' as never }));
    h.r.observe(ev('P1', 1, { tier: 'standard', task: 'status' }));
    await h.clock.advance(0);
    const call = h.infer.calls.find((c) => (c as { task?: string }).task === 'status') ?? h.infer.calls.at(-1)!;
    call.resolve({ inferenceSource: 'REMOTE_PROVIDER' as never });
    await flush();
    await h.clock.advance(0);
    expect(published(h)).toBe(true);
    expect(h.ledger.ext).toEqual(['remote_provider']);
  });
});
