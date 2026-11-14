import { describe, it, expect } from 'vitest';
import { jobKeyId, slotId } from '../../../src/reconcile/jobKey';
import type { JobKey } from '../../../src/reconcile/types';

const base: JobKey = { projectId: 'a|b', observedRev: 1, promptVersion: 'v1', templateHash: 'h' };

describe('O1 key_injective (B1)', () => {
  it('identical tuples give equal ids', () => {
    expect(jobKeyId({ ...base })).toBe(jobKeyId({ ...base }));
  });
  it('varying each field singly changes the id', () => {
    const ids = new Set([
      jobKeyId(base),
      jobKeyId({ ...base, projectId: 'a' }),
      jobKeyId({ ...base, observedRev: 2 }),
      jobKeyId({ ...base, promptVersion: 'v2' }),
      jobKeyId({ ...base, templateHash: 'h2' }),
    ]);
    expect(ids.size).toBe(5);
  });
  it('crafted delimiter collisions stay distinct', () => {
    const x: JobKey = { projectId: 'a|b', observedRev: 1, promptVersion: 'v1', templateHash: 'h' };
    const y: JobKey = { projectId: 'a', observedRev: 1, promptVersion: 'b|1|v1', templateHash: 'h' };
    const z: JobKey = { projectId: 'a|b|1', observedRev: 1, promptVersion: 'v1', templateHash: 'h' };
    const w: JobKey = { projectId: 'a', observedRev: 1, promptVersion: 'b|1|v1|1', templateHash: 'v1|h' };
    const ids = [x, y, z, w].map(jobKeyId);
    expect(new Set(ids).size).toBe(4);
    const c1: JobKey = { projectId: 'a', observedRev: 1, promptVersion: 'x|y', templateHash: 'h' };
    const c2: JobKey = { projectId: 'a', observedRev: 1, promptVersion: 'x', templateHash: 'y|h' };
    expect(jobKeyId(c1)).not.toBe(jobKeyId(c2));
    const d1: JobKey = { projectId: 'a|1', observedRev: 2, promptVersion: 'v', templateHash: 'h' };
    const d2: JobKey = { projectId: 'a', observedRev: 1, promptVersion: '2|v', templateHash: 'h' };
    expect(jobKeyId(d1)).not.toBe(jobKeyId(d2));
    const q1: JobKey = { projectId: 'p', observedRev: 1, promptVersion: '1', templateHash: 'h' };
    const q2: JobKey = { projectId: 'p', observedRev: 11, promptVersion: '', templateHash: 'h' };
    expect(jobKeyId(q1)).not.toBe(jobKeyId(q2));
  });
  it('slotId is distinct per (projectId, task) and does not collide on delimiters', () => {
    expect(slotId('P1', 'status')).not.toBe(slotId('P1', 'summary'));
    expect(slotId('P1', 'status')).not.toBe(slotId('P2', 'status'));
    expect(slotId('a|status', 'summary')).not.toBe(slotId('a', 'status'));
    expect(slotId('P1', 'status')).toBe(slotId('P1', 'status'));
  });
});
