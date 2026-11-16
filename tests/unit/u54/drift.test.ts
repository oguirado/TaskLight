// U54 O6: reviewDrift allowExternal gate (SPEC_U54 section 4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewDrift } from '../../../src/agents';
import { contract } from '../u34/fixture';

const PREV = contract('Plan', ['a', 'b', 'c']);
const REMOVE = contract('Plan', ['a', 'b']);
const ANSWER = JSON.stringify({ verdict: 'drift', reason: 'Step c was dropped.' });
const port = (source: unknown) => ({ generate: vi.fn(async () => ({ text: ANSWER, source })) }) as never;
const run = (source: unknown, opts?: Record<string, unknown>) => reviewDrift(port(source), PREV, REMOVE, opts as never);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('O6 local/remote kept only with allowExternal: true', () => {
  it.each(['local', 'remote'])('%s + allowExternal true -> model verdict with that source', async (src) => {
    expect(await run(src, { allowExternal: true })).toEqual({ verdict: 'drift', reason: 'Step c was dropped.', source: src });
  });
  it.each(['local', 'remote'])('%s without the option -> rules verdict', async (src) => {
    const ctl = await run(src, { allowExternal: true }); expect(ctl.source).toBe(src);
    expect((await run(src)).source).toBe('rules');
    expect((await run(src, {})).source).toBe('rules');
    expect((await run(src, { timeoutMs: 5000 })).source).toBe('rules');
  });
  it.each([false, 'true', 1, null, undefined, {}] as unknown[])('%j is not === true -> rules', async (flag) => {
    const ctl = await run('local', { allowExternal: true }); expect(ctl.source).toBe('local');
    expect((await run('remote', { allowExternal: flag })).source).toBe('rules');
  });
  it('rules fallback equals the verdict the rules give with no port answer', async () => {
    const ctl = await run('local', { allowExternal: true }); expect(ctl.source).toBe('local');
    const rules = await run('edge');
    expect(await run('local')).toEqual(rules);
    expect(rules.source).toBe('rules');
  });
  it.each(['edge', 'LOCAL', 'cloud ', '', null, 5, undefined] as unknown[])('unknown source %j -> rules even with allowExternal', async (src) => {
    const ctl = await run('local', { allowExternal: true }); expect(ctl.source).toBe('local');
    expect((await run(src, { allowExternal: true })).source).toBe('rules');
  });
});

describe('regression: device / cloud unchanged and independent of allowExternal', () => {
  it.each(['device', 'cloud'])('%s kept with and without the option', async (src) => {
    const want = { verdict: 'drift', reason: 'Step c was dropped.', source: src };
    expect(await run(src)).toEqual(want);
    expect(await run(src, { allowExternal: true })).toEqual(want);
    expect(await run(src, { allowExternal: false })).toEqual(want);
  });
});
