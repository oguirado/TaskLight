// U54 O5: routeWithFallback accepts the 4 sources (SPEC_U54 section 3).
import { describe, expect, it } from 'vitest';
import { routeWithFallback } from '../../../src/router/route';
import type { ClassifierPort } from '../../../src/router/types';
import { ev } from '../u39/fixtures';

type PrivacyTier = 'private' | 'standard' | 'shared';
const ABSTAINING = ev('answer', 'bake a cake for grandma');
const says = (text: string, source: string): ClassifierPort =>
  (async () => ({ text, source })) as unknown as ClassifierPort;
const route = (tier: PrivacyTier, source: string, text = 'handoff') => routeWithFallback(ABSTAINING, tier, says(text, source));

describe('O5 accepted and refused source x tier', () => {
  it.each(['LOCAL_SERVER', 'REMOTE_PROVIDER'])('standard + %s -> OK/nano with that source', async (src) => {
    const d = await route('standard', src);
    expect([d.status, d.target, d.stage, d.source]).toEqual(['OK', 'handoff', 'nano', src]);
  });
  it.each(['LOCAL_SERVER', 'REMOTE_PROVIDER'])('private + %s -> ABSTAIN/privacy_cloud/inbox', async (src) => {
    const ctl = await route('standard', src); expect(ctl.status).toBe('OK');
    const d = await route('private', src);
    expect([d.status, d.reason, d.target]).toEqual(['ABSTAIN', 'privacy_cloud', 'inbox']);
    expect(d.source).toBeUndefined();
  });
  it('shared + REMOTE_PROVIDER -> privacy_cloud', async () => {
    const ctl = await route('standard', 'REMOTE_PROVIDER'); expect(ctl.status).toBe('OK');
    const d = await route('shared', 'REMOTE_PROVIDER');
    expect([d.status, d.reason, d.target]).toEqual(['ABSTAIN', 'privacy_cloud', 'inbox']);
  });
  it('shared + LOCAL_SERVER -> OK with that source', async () => {
    const d = await route('shared', 'LOCAL_SERVER');
    expect([d.status, d.target, d.source]).toEqual(['OK', 'handoff', 'LOCAL_SERVER']);
  });
  it.each(['MARS', 'on_device', 'local_server', '', 'remote'])('unknown source %j -> nano_unavailable', async (src) => {
    const ctl = await route('standard', 'LOCAL_SERVER'); expect(ctl.status).toBe('OK');
    const d = await route('standard', src);
    expect([d.status, d.reason, d.target]).toEqual(['ABSTAIN', 'nano_unavailable', 'inbox']);
  });
  it('a bad source with an off-enum label reports the source problem, never a label', async () => {
    const d = await route('standard', 'MARS', 'launch_missiles');
    expect(d.reason).toBe('nano_unavailable');
  });
  it('privacy_cloud takes no new reason value and abstain keeps stage nano', async () => {
    const d = await route('private', 'REMOTE_PROVIDER');
    expect(d.stage).toBe('nano');
  });
});

describe('regression: ON_DEVICE / IN_CLOUD x 3 tiers unchanged', () => {
  const expectOk = (tier: PrivacyTier, src: string) => !(tier === 'private' && src === 'IN_CLOUD');
  const cases: [PrivacyTier, string][] = [];
  for (const t of ['private', 'standard', 'shared'] as const) for (const s of ['ON_DEVICE', 'IN_CLOUD']) cases.push([t, s]);
  it.each(cases)('%s + %s', async (tier, src) => {
    const d = await route(tier, src);
    if (expectOk(tier, src)) expect([d.status, d.source, d.target]).toEqual(['OK', src, 'handoff']);
    else expect([d.status, d.reason, d.target]).toEqual(['ABSTAIN', 'privacy_cloud', 'inbox']);
  });
  it('stage 0/1 OK still never calls the port', async () => {
    let calls = 0;
    const port = (async () => { calls++; return { text: 'handoff', source: 'LOCAL_SERVER' }; }) as unknown as ClassifierPort;
    await routeWithFallback(ev('plan', 'x', { plan: { title: 't', steps: [{ text: 's' }] } } as never), 'private', port);
    expect(calls).toBe(0);
  });
});
