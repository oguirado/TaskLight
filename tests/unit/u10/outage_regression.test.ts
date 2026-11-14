import {afterEach, describe, expect, it, vi} from 'vitest';
import {CFG, ev, flush, makeHarness, type Harness} from './harness';
afterEach(() => vi.unstubAllGlobals());
describe('Outage recovery independent regressions', () => {
 it('project privacy covers an in-flight different task', async () => {
  const h=makeHarness({cfg:{mode_summary:'PREFER_IN_CLOUD'}});
  h.r.observe(ev('P1',1,{task:'summary'}));await h.clock.advance(0);
  h.r.observe(ev('P1',2,{task:'status',tier:'private'}));
  h.infer.calls[0]!.resolve({inferenceSource:'IN_CLOUD'});await flush();
  expect(h.store.casCalls.filter(c=>c.result&&c.next.inference_source==='IN_CLOUD')).toHaveLength(0);
  expect(h.ledger.counts.in_cloud).toBe(0);
 });
 it('dispatch-time refusal retains same-revision retry intent', async () => {
  const h=makeHarness({cfg:{mode_status:'ONLY_IN_CLOUD'}});
  h.r.observe(ev('P1',1));await h.clock.advance(0);h.infer.calls[0]!.resolve();await flush();
  await h.clock.advance(5000);h.r.observe(ev('P1',2));
  h.r.updateConfig({...CFG,mode_status:'ONLY_IN_CLOUD',kill_switch_cloud:true});await h.clock.advance(15000);
  expect(h.ledger.counts.refusals).toBeGreaterThan(0);
  h.r.updateConfig({...CFG,mode_status:'ONLY_IN_CLOUD',kill_switch_cloud:false});
  h.r.observe(ev('P1',2));await h.clock.advance(0);
  expect(h.infer.calls.some(c=>c.req.key.observedRev===2)).toBe(true);
 });
 it('interval-blocked pending work does not reserve a free lane from another project', async () => {
  const h=makeHarness({projects:['P1','P2']});
  h.r.observe(ev('P1',1));await h.clock.advance(0);h.infer.calls[0]!.resolve();await flush();
  await h.clock.advance(5000);h.r.observe(ev('P1',2));
  expect(h.r.observe(ev('P2',1))).not.toMatchObject({kind:'THROTTLE',reason:'lane_full'});
  await h.clock.advance(0);expect(h.infer.calls.some(c=>c.req.key.projectId==='P2')).toBe(true);
 });
 it('stored latest observation prevents false fresh state on restart', () => {
  const h=makeHarness({projects:[]});
  h.store.seed('P1',{rev:1,observed_rev:10,source_observed_rev:5});h.r.registerProject('P1');
  h.r.observe(ev('P1',5));expect(h.r.freshness('P1')).not.toBe('fresh');
 });
 it('an older successful outcome cannot erase a newer queue-full retry',async()=>{
  const h=makeHarness();h.r.observe(ev('P1',1));await h.clock.advance(0);
  h.r.observe(ev('P1',1,{task:'summary'}));h.r.observe(ev('P1',1,{task:'next_action'}));
  expect(h.r.observe(ev('P1',2))).toMatchObject({kind:'REFUSE',reason:'queue_full'});
  for(let i=0;i<4;i++){h.infer.calls.forEach(c=>c.resolve());await flush();await h.clock.advance(20000);}
  h.r.observe(ev('P1',2));await h.clock.advance(0);
  expect(h.infer.calls.some(c=>c.req.task==='status'&&c.req.key.observedRev===2)).toBe(true);
 });
 it('a refused newer observation supersedes obsolete pending work',async()=>{
  const h=makeHarness({cfg:{mode_status:'ONLY_IN_CLOUD'}});
  h.r.observe(ev('P1',1));await h.clock.advance(0);h.infer.calls[0]!.resolve();await flush();
  h.r.observe(ev('P1',2));h.r.updateConfig({...CFG,mode_status:'ONLY_IN_CLOUD',kill_switch_cloud:true});
  h.r.observe(ev('P1',3));h.r.updateConfig({...CFG,mode_status:'ONLY_IN_CLOUD',kill_switch_cloud:false});
  await h.clock.advance(20000);
  expect(h.infer.calls.filter(c=>c.req.key.observedRev===2)).toHaveLength(0);
  h.infer.calls.forEach(c=>c.resolve());await flush();h.r.observe(ev('P1',3));await h.clock.advance(20000);
  expect(h.infer.calls.some(c=>c.req.key.observedRev===3)).toBe(true);
 });
 it('admission simulates the interval after an eligible predecessor starts',async()=>{
  const h=makeHarness({projects:['P1','P2'],cfg:{mode_status:'PREFER_IN_CLOUD',mode_summary:'PREFER_IN_CLOUD'}});
  h.r.observe(ev('P1',1));h.r.observe(ev('P1',1,{task:'summary'}));
  expect(h.r.observe(ev('P2',1))).not.toMatchObject({kind:'THROTTLE',reason:'lane_full'});
  await h.clock.advance(0);expect(h.infer.calls.map(c=>c.req.key.projectId)).toEqual(['P1','P2']);
 });
 it('a fresh persisted publication is fresh before the first new observation',()=>{
  const h=makeHarness({projects:[]});h.store.seed('P1',{rev:1,observed_rev:5,source_observed_rev:5});
  h.r.registerProject('P1');expect(h.r.freshness('P1')).toBe('fresh');
 });
 it('a stale rejected observation cannot change project privacy policy',async()=>{
  const h=makeHarness({cfg:{mode_status:'PREFER_IN_CLOUD'}});
  h.r.observe(ev('P1',2));await h.clock.advance(0);h.infer.calls[0]!.resolve({inferenceSource:'IN_CLOUD'});await flush();
  h.r.observe(ev('P1',1,{tier:'private'}));h.r.observe(ev('P1',3));await h.clock.advance(20000);
  expect(h.infer.calls[1]!.req.mode).toBe('PREFER_IN_CLOUD');
 });
 it('validation reentrancy cannot publish a cloud result after private promotion',async()=>{
  let h:Harness;
  h=makeHarness({cfg:{mode_summary:'PREFER_IN_CLOUD'},validator:{validate(_task,raw){
   h.r.observe(ev('P1',2,{tier:'private',task:'status'}));return {ok:true,patch:{raw}};
  }}});
  h.r.observe(ev('P1',1,{task:'summary'}));await h.clock.advance(0);
  h.infer.calls[0]!.resolve({inferenceSource:'IN_CLOUD'});await flush();
  expect(h.store.casCalls.filter(c=>c.result&&c.next.inference_source==='IN_CLOUD')).toHaveLength(0);
  expect(h.ledger.counts.in_cloud).toBe(0);
 });
 it('same revision retry preserves originally accepted template metadata',async()=>{
  const h=makeHarness();h.r.observe(ev('P1',1,{templateHash:'h1'}));await h.clock.advance(0);
  h.infer.calls[0]!.reject();await flush();h.r.observe(ev('P1',1,{templateHash:'h2'}));await h.clock.advance(20000);
  expect(h.infer.calls[1]!.req.key.templateHash).toBe('h1');
 });
 it('equal revision admission reports the lane actually used after rerouting',async()=>{
  const h=makeHarness({cfg:{mode_status:'PREFER_IN_CLOUD'}});h.r.observe(ev('P1',1));
  h.r.updateConfig({...CFG,mode_status:'PREFER_IN_CLOUD',kill_switch_cloud:true});await h.clock.advance(0);
  expect(h.infer.calls[0]!.req.mode).toBe('ONLY_ON_DEVICE');
  expect(h.r.observe(ev('P1',1))).toMatchObject({kind:'ADMIT',lane:'on_device'});
 });
 it.each(['incarnation','prompt','template','dispose'] as const)('publication rechecks %s after validator reentrancy',async(kind)=>{
  let h:Harness;
  h=makeHarness({validator:{validate(_task,raw){
   if(kind==='incarnation')h.store.inc.set('P1','B');
   if(kind==='prompt')h.r.updateConfig({...CFG,prompt_version:'v2'});
   if(kind==='template')h.r.observe(ev('P1',2,{templateHash:'new'}));
   if(kind==='dispose')h.r.dispose();
   return {ok:true,patch:{raw}};
  }}});
  h.r.observe(ev('P1',1));await h.clock.advance(0);h.infer.calls[0]!.resolve();await flush();
  expect(h.store.casCalls.filter(c=>c.result)).toHaveLength(0);
 });
 it.each(['private','dispose'] as const)('publication rechecks authorization after ledger callback: %s',async(kind)=>{
  const h=makeHarness({cfg:{mode_summary:'PREFER_IN_CLOUD'}});const inc=h.ledger.inc.bind(h.ledger);
  h.ledger.inc=c=>{inc(c);if(c==='in_cloud'){if(kind==='private')h.r.observe(ev('P1',2,{tier:'private'}));else h.r.dispose();}};
  h.r.observe(ev('P1',1,{task:'summary'}));await h.clock.advance(0);h.infer.calls[0]!.resolve({inferenceSource:'IN_CLOUD'});await flush();
  expect(h.store.casCalls.filter(c=>c.result)).toHaveLength(0);
 });
 it('dispatch stops after inference callback disposes the reconciler',async()=>{
  const h=makeHarness({projects:['P1','P2'],cfg:{mode_status:'PREFER_IN_CLOUD'}});const run=h.infer.run.bind(h.infer);
  h.infer.run=(request,signal)=>{if(request.key.projectId==='P1')h.r.dispose();return run(request,signal);};
  h.r.observe(ev('P1',1));h.r.observe(ev('P2',1));await h.clock.advance(0);
  expect(h.infer.calls.map(c=>c.req.key.projectId)).toEqual(['P1']);
 });
 it('dispatch ignores a captured pending entry replaced during another inference callback',async()=>{
  const h=makeHarness({projects:['P1','P2'],cfg:{mode_status:'PREFER_IN_CLOUD'}});const run=h.infer.run.bind(h.infer);
  h.infer.run=(request,signal)=>{if(request.key.projectId==='P1')h.r.observe(ev('P2',2));return run(request,signal);};
  h.r.observe(ev('P1',1));h.r.observe(ev('P2',1));await h.clock.advance(0);
  expect(h.infer.calls.filter(c=>c.req.key.projectId==='P2'&&c.req.key.observedRev===1)).toHaveLength(0);
 });
});
