import {describe,expect,it,vi} from 'vitest';
import {createHybrid} from '../../../src/ai/hybrid';
import {runParity} from '../../../src/ai/parity';
import {makeFake,modeNameOf,OK_ORIGIN,PNG,req} from './harness';
vi.mock('../../../src/schema',()=>import('./schemaMock'));
describe('Outage recovery independent regressions',()=>{
 it('failed replacement creation leaves configuration and generation coherent',async()=>{
  const fake=makeFake();
  const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true,config:{mode_summary:'ONLY_IN_CLOUD'}});
  await h.initDevice();const create=fake.create.bind(fake);let fail=true;
  fake.create=p=>{if(fail)throw new Error('replacement construction failed');return create(p);};
  expect(()=>h.applyConfig({kill_switch_cloud:true})).toThrow();fail=false;
  await h.initDevice();const r=await h.run(req('summary'));
  expect(r.meta.configGen).toBe(0);
  expect(r.meta.mode).toBe('ONLY_IN_CLOUD');
  expect(fake.calls.every(c=>modeNameOf(c.handle.params)==='ONLY_IN_CLOUD')).toBe(true);
 });
 it('parity never sends screenshot pixels to a cloud handle',async()=>{
  const fake=makeFake();await runParity([{task:'screenshot',prompt:'inspect',image:PNG}],fake);
  expect(fake.calls.filter(c=>modeNameOf(c.handle.params)==='ONLY_IN_CLOUD')).toHaveLength(0);
 });
 it('parity never sends misplaced image bytes on a summary cloud pass',async()=>{
  const fake=makeFake();await runParity([{task:'summary',prompt:'inspect',image:PNG}],fake);
  expect(fake.calls.filter(c=>modeNameOf(c.handle.params)==='ONLY_IN_CLOUD'&&Array.isArray(c.req))).toHaveLength(0);
 });
 it('late progress cannot change a completed initialization back to downloading',async()=>{
  const fake=makeFake();fake.initMode='manual';
  const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true});
  const p=h.initDevice();fake.initResolves.splice(0).forEach(f=>f());await p;
  expect(h.deviceStatus().state).toBe('ready');fake.handles.forEach(x=>x.initCb?.(0.5));
  expect(h.deviceStatus().state).toBe('ready');
 });
 it('pending replacement does not advertise device ready',async()=>{
  const fake=makeFake();const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true});
  await h.initDevice();fake.initMode='manual';h.applyConfig({});
  expect(h.deviceStatus().state).not.toBe('ready');
 });
 it('pending lazy private initialization does not advertise ready and recovers after completion',async()=>{
  const fake=makeFake();const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true});
  await h.initDevice();fake.initMode='manual';
  const r=await h.run(req('summary',{tier:'private'}));
  expect(r).toMatchObject({ok:false,code:'DEVICE_NOT_INITIALISED'});
  expect(h.deviceStatus().state).not.toBe('ready');
  fake.initResolves.splice(0).forEach(f=>f());for(let i=0;i<20;i++)await Promise.resolve();
  expect(h.deviceStatus().state).toBe('ready');
  expect((await h.run(req('summary',{tier:'private'}))).ok).toBe(true);
 });
 it('private generation revalidates initialization ownership after lazy awaits',async()=>{
  const fake=makeFake();const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true});await h.initDevice();
  const pending=h.run(req('summary',{tier:'private'}));
  queueMicrotask(()=>{fake.initMode='manual';void h.initDevice();});
  const r=await pending;expect(r).toMatchObject({ok:false,code:'DEVICE_NOT_INITIALISED',meta:{called:false}});
  expect(fake.calls).toHaveLength(0);
 });
 it('a ready cached private handle cannot bypass another pending private initialization',async()=>{
  const fake=makeFake();const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true});await h.initDevice();
  expect((await h.run(req('summary',{tier:'private'}))).ok).toBe(true);
  fake.initMode='manual';await h.run(req('digest',{tier:'private'}));
  expect(h.deviceStatus().state).not.toBe('ready');
  expect(await h.run(req('summary',{tier:'private'}))).toMatchObject({ok:false,code:'DEVICE_NOT_INITIALISED',meta:{called:false}});
 });
 it('the SDK receives the validated input snapshot despite caller mutation during awaits',async()=>{
  const fake=makeFake();const h=createHybrid({factory:fake,origin:OK_ORIGIN,appCheckReady:true});await h.initDevice();
  const request=req('summary',{tier:'private',prompt:'short'});const pending=h.run(request);
  request.prompt='x'.repeat(8000);await pending;
  expect(fake.calls[0]!.req).toBe('short');
 });
});
