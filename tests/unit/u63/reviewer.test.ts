import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanAi } from "../../../src/planai/reviewer";
import { reviewTaskRules, briefPlanRules } from "../../../src/planai/rules";
import { TASK_REVIEW_SCHEMA, PLAN_BRIEF_SCHEMA } from "../../../src/planai/schema";
import type { PlanAi, PlanAiOptions, ReviewContext, PlanTaskInput, PlanBriefInput } from "../../../src/planai/types";
import { task, plan, fakePort, fakeClock, flush, deferred, response, tracked } from "./helpers";
afterEach(()=>vi.restoreAllMocks());
const jobs=["task_review","plan_brief"] as const;
type Job=typeof jobs[number];
const invoke=async (ai:PlanAi,job:Job,ctx:ReviewContext={})=>job==="task_review"?ai.reviewTask(task(),ctx):ai.briefPlan(plan(),ctx);
const expected=(job:Job)=>job==="task_review"?reviewTaskRules(task()):briefPlanRules(plan());

describe.each(jobs)("%s",job=>{
 it.each(["cloud","local","remote","unknown"] as const)("V1 private rejects source %s and forces device mode",async source=>{
  const {port,generate}=fakePort(async()=>({...response(),source:source as "device"}));
  const resolver=vi.fn(()=>({port,allowExternal:true}));
  const onFallback=vi.fn(), clock=fakeClock();
  const result=await invoke(createPlanAi({port:resolver,onFallback,clock:clock.clock}),job,{tier:"private",floor:"PREFER_ON_DEVICE"});
  expect(resolver).toHaveBeenCalledWith("ONLY_ON_DEVICE");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(result).toEqual(expected(job));
  expect(onFallback).toHaveBeenCalledWith(job,"source_rejected");
 });
 it("V1 private device response is accepted",async()=>{
  const {port}=fakePort();
  const resolver=vi.fn(()=>({port,allowExternal:true}));
  expect((await invoke(createPlanAi({port:resolver,clock:fakeClock().clock}),job,{tier:"private"})).source).toBe("device");
  expect(resolver).toHaveBeenCalledWith("ONLY_ON_DEVICE");
 });
 it.each(["private","kill_switch","floor"] as const)("V1 W0-R20 raw port emits nothing for %s",async restriction=>{
  const {port,generate}=fakePort(),onFallback=vi.fn();
  const ai=createPlanAi({port,onFallback,clock:fakeClock().clock,killSwitchCloud:restriction==="kill_switch"});
  const ctx:ReviewContext=restriction==="private"?{tier:"private",floor:"PREFER_ON_DEVICE"}:restriction==="floor"?{floor:"ONLY_ON_DEVICE"}:{tier:"standard"};
  expect(await invoke(ai,job,ctx)).toEqual(expected(job));
  expect(generate).not.toHaveBeenCalled();
  expect(onFallback).toHaveBeenCalledWith(job,"privacy_blocked");
 });
 it.each(["cloud","local","remote"] as const)("V2 kill switch rejects %s",async source=>{
  const {port}=fakePort(async()=>response(source)), resolver=vi.fn(()=>({port,allowExternal:true})),onFallback=vi.fn();
  expect(await invoke(createPlanAi({port:resolver,clock:fakeClock().clock,killSwitchCloud:true,onFallback}),job,{tier:"standard"})).toEqual(expected(job));
  expect(resolver).toHaveBeenCalledWith("ONLY_ON_DEVICE");
  expect(onFallback).toHaveBeenCalledWith(job,"source_rejected");
 });
 it.each(["raw","resolver","binding"] as const)("V2 %s defaults or clamps external permission",async shape=>{
  for(const source of ["local","remote"] as const){
   const {port}=fakePort(async()=>response(source)),onFallback=vi.fn();
   const option=shape==="raw"?port:shape==="resolver"?()=>port:()=>({port,allowExternal:false});
   expect(await invoke(createPlanAi({port:option,clock:fakeClock().clock,onFallback}),job)).toEqual(expected(job));
   expect(onFallback).toHaveBeenCalledWith(job,"source_rejected");
  }
 });
 it.each(["device","cloud","local","remote"] as const)("V3 explicit grant preserves source %s verbatim",async source=>{
  const {port,generate}=fakePort(async()=>response(source)),resolver=vi.fn(()=>({port,allowExternal:true}));
  const result=await invoke(createPlanAi({port:resolver,clock:fakeClock().clock}),job,{tier:"standard"});
  expect(result.source).toBe(source);
  expect(resolver).toHaveBeenCalledWith("PREFER_ON_DEVICE");
  expect(generate.mock.calls[0]?.[1]).toEqual(job==="task_review"?TASK_REVIEW_SCHEMA:PLAN_BRIEF_SCHEMA);
  expect(generate.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  expect(generate.mock.calls[0]?.[0]).toContain("<untrusted_json>");
 });
 it.each(["device","cloud"] as const)("V3 standard raw port accepts %s",async source=>{
  const {port}=fakePort(async()=>response(source));
  expect((await invoke(createPlanAi({port,clock:fakeClock().clock}),job)).source).toBe(source);
 });
 it("V3 rejects unknown source even with external grant",async()=>{
  const {port}=fakePort(async()=>({...response(),source:"invented" as "device"})),onFallback=vi.fn();
  expect(await invoke(createPlanAi({port:()=>({port,allowExternal:true}),clock:fakeClock().clock,onFallback}),job)).toEqual(expected(job));
  expect(onFallback).toHaveBeenCalledWith(job,"source_rejected");
 });
 const malformed:[string,"bad_json"|"schema_reject"][]=[
  ["not json","bad_json"],["[]","schema_reject"],["null","schema_reject"],["{}","schema_reject"],
  [job==="task_review"?'{"verdict":"maybe","reason":"x"}':'{"brief":3}',"schema_reject"],
  [job==="task_review"?'{"verdict":"drift","reason":"  "}':'{"brief":"  "}',"schema_reject"],
 ];
 it.each(malformed)("V4 malformed response %s falls back",async(text,code)=>{
  const {port}=fakePort(async()=>({text,source:"device"})),onFallback=vi.fn();
  expect(await invoke(createPlanAi({port,clock:fakeClock().clock,onFallback}),job)).toEqual(expected(job));
  expect(onFallback).toHaveBeenCalledWith(job,code);
 });
 it.each(["absent","throws","null","primitive"] as const)("V5 invalid resolver %s emits nothing",async kind=>{
  const {port,generate}=fakePort(),onFallback=vi.fn();
  const opts:PlanAiOptions={clock:fakeClock().clock,onFallback};
  if(kind!=="absent") opts.port=()=>{if(kind==="throws")throw new Error("resolver failed");return (kind==="null"?null:42) as unknown as typeof port;};
  expect(await invoke(createPlanAi(opts),job,{tier:"private"})).toEqual(expected(job));
  expect(generate).not.toHaveBeenCalled();
  expect(onFallback).toHaveBeenCalledWith(job,"no_port");
 });
 it.each(["sync","async"] as const)("V5 %s port failure returns rules and retries",async kind=>{
  const {port,generate}=fakePort(()=>{if(kind==="sync")throw new Error("sync");return Promise.reject(new Error("async"));});
  const onFallback=vi.fn(),ai=createPlanAi({port,clock:fakeClock().clock,onFallback});
  expect(await invoke(ai,job)).toEqual(expected(job));
  expect(onFallback).toHaveBeenCalledWith(job,"port_error");
  await invoke(ai,job);
  expect(generate).toHaveBeenCalledTimes(2);
 });
 it.each([undefined,NaN,-5,Infinity,0])("V5 timeout %s defaults to bounded clock and retries",async timeoutMs=>{
  const clock=fakeClock(),onFallback=vi.fn();
  const {port,generate}=fakePort(()=>new Promise<never>(()=>undefined));
  const opts:PlanAiOptions={port,clock:clock.clock,onFallback};
  if(timeoutMs!==undefined)opts.timeoutMs=timeoutMs;
  const ai=createPlanAi(opts),p=invoke(ai,job),state=tracked(p);
  await flush();
  const signal=generate.mock.calls[0]?.[2];
  expect(signal?.aborted).toBe(false);
  expect(clock.setTimeout.mock.calls.some(c=>c[1]===10000)).toBe(true);
  await clock.advance(9999);expect(state.settled).toBe(false);
  await clock.advance(1);expect(signal?.aborted).toBe(true);
  expect(state.settled).toBe(true);expect(state.error).toBeUndefined();
  expect(await p).toEqual(expected(job));
  expect(onFallback).toHaveBeenCalledWith(job,"timeout");
  expect(clock.clearTimeout).toHaveBeenCalled();
  expect(clock.timers.size).toBe(0);
  const retry=invoke(ai,job);await flush();expect(generate).toHaveBeenCalledTimes(2);
  await clock.advance(10000);await retry;
 });
 it("V5 positive custom timeout is honored",async()=>{
  const clock=fakeClock(),{port}=fakePort(()=>new Promise<never>(()=>undefined));
  const p=invoke(createPlanAi({port,clock:clock.clock,timeoutMs:7}),job),state=tracked(p);
  await flush();await clock.advance(6);expect(state.settled).toBe(false);
  await clock.advance(1);expect(state.settled).toBe(true);
  expect(await p).toEqual(expected(job));
 });
 it.each([false,true])("V5 caller abort preAborted=%s is immediate",async preAborted=>{
  const clock=fakeClock(),caller=new AbortController(),onFallback=vi.fn();
  const {port,generate}=fakePort(()=>new Promise<never>(()=>undefined));
  if(preAborted)caller.abort();
  const ai=createPlanAi({port,clock:clock.clock,onFallback});
  const p=invoke(ai,job,{signal:caller.signal}),state=tracked(p);
  await flush();if(!preAborted)caller.abort();await flush();
  expect(state.settled).toBe(true);expect(state.error).toBeUndefined();
  expect(await p).toEqual(expected(job));
  if(!preAborted)expect(generate.mock.calls[0]?.[2].aborted).toBe(true);
  expect(onFallback).toHaveBeenCalledWith(job,"aborted");
  expect(clock.timers.size).toBe(0);
  const beforeRetry=generate.mock.calls.length;
  const retry=invoke(ai,job);await flush();
  expect(generate.mock.calls.length).toBe(beforeRetry+1);
  await clock.advance(10000);await retry;
 });
 it("V7 injected clock exclusively owns timers and success cleanup",async()=>{
  const clock=fakeClock(),{port}=fakePort();
  const globalTimer=vi.spyOn(globalThis,"setTimeout").mockImplementation(()=>{throw new Error("Global timer forbidden");});
  const interval=vi.spyOn(globalThis,"setInterval").mockImplementation(()=>{throw new Error("Global interval forbidden");});
  const now=vi.spyOn(Date,"now").mockImplementation(()=>{throw new Error("Wall clock forbidden");});
  const result=await invoke(createPlanAi({port,clock:clock.clock}),job);
  expect(result.source).toBe("device");
  expect(globalTimer).not.toHaveBeenCalled();expect(interval).not.toHaveBeenCalled();expect(now).not.toHaveBeenCalled();
  expect(clock.clearTimeout).toHaveBeenCalled();expect(clock.timers.size).toBe(0);
 });
});

it("V6 serialises review and brief jobs across one instance",async()=>{
 const d=deferred<ReturnType<typeof response>>();
 const {port,generate}=fakePort(()=>generate.mock.calls.length===1?d.promise:Promise.resolve(response()));
 const ai=createPlanAi({port,clock:fakeClock().clock});
 const a=ai.reviewTask(task()),b=ai.reviewTask(task({id:"T02",title:"Other"})),c=ai.briefPlan(plan());
 await flush();expect(generate).toHaveBeenCalledTimes(1);
 d.resolve(response());await Promise.all([a,b,c]);expect(generate).toHaveBeenCalledTimes(3);
});
it.each(jobs)("V6 %s privacy isolates successful standard result",async job=>{
 const {port}=fakePort(async()=>response("cloud")),resolver=vi.fn(()=>({port,allowExternal:true})),onFallback=vi.fn();
 const ai=createPlanAi({port:resolver,clock:fakeClock().clock,onFallback});
 expect((await invoke(ai,job,{tier:"standard"})).source).toBe("cloud");
 expect((await invoke(ai,job,{tier:"private"})).source).toBe("rules");
 expect(resolver).toHaveBeenCalledWith("ONLY_ON_DEVICE");
 expect(onFallback).toHaveBeenCalledWith(job,"source_rejected");
});
it.each([null,undefined,42,[],{}, {microtasks:null}, {tasks:"invalid"}])("V5 malformed task/plan %j never throws",async value=>{
 const ai=createPlanAi({clock:fakeClock().clock});
 await expect(ai.reviewTask(value as unknown as PlanTaskInput)).resolves.toMatchObject({source:"rules"});
 await expect(ai.briefPlan(value as unknown as PlanBriefInput)).resolves.toMatchObject({source:"rules"});
});
it.each([null,42,[],{}])("V5 malformed port result %j never rejects",async value=>{
 const {port}=fakePort(async()=>value as never);
 const ai=createPlanAi({port,clock:fakeClock().clock});
 await expect(ai.reviewTask(task())).resolves.toMatchObject({source:"rules"});
 await expect(ai.briefPlan(plan())).resolves.toMatchObject({source:"rules"});
});

it("V6 optional memo stays within its advertised bound",async()=>{
 const {port,generate}=fakePort(),ai=createPlanAi({port,clock:fakeClock().clock});
 for(let i=0;i<257;i++)await ai.reviewTask(task({title:"Task "+i,rev:i}));
 const before=generate.mock.calls.length;
 await ai.reviewTask(task({title:"Task 0",rev:0}));
 expect(generate.mock.calls.length).toBe(before+1);
});
it("V5 hostile getters and cyclic malformed inputs settle safely",async()=>{
 const ai=createPlanAi({clock:fakeClock().clock});
 const hostile=Object.defineProperty({},"microtasks",{get(){throw new Error("hostile getter");}});
 const cyclic:Record<string,unknown>={};cyclic["microtasks"]=cyclic;cyclic["tasks"]=cyclic;
 for(const value of [hostile,cyclic]){
  await expect(ai.reviewTask(value as unknown as PlanTaskInput)).resolves.toMatchObject({source:"rules"});
  await expect(ai.briefPlan(value as unknown as PlanBriefInput)).resolves.toMatchObject({source:"rules"});
 }
});
