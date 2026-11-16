import { expect, it } from "vitest";
import { reviewTaskRules, briefPlanRules } from "../../../src/planai/rules";
import type { PlanTaskInput } from "../../../src/planai/types";
import { task, plan } from "./helpers";
const cases: [string, Partial<PlanTaskInput>, string][] = [
 ["blocked task",{status:"blocked"},"needs_user"],
 ["blocked microtask",{microtasks:[{id:"M1",text:"x",state:"blocked"}]},"needs_user"],
 ["blocked precedes cancelled",{status:"cancelled",microtasks:[{id:"M1",text:"x",state:"blocked"}]},"needs_user"],
 ["cancelled precedes empty",{status:"cancelled",microtasks:[]},"on_track"],
 ["empty microtasks",{microtasks:[]},"needs_user"],
 ["missing outcome",{microtasks:[{id:"M1",text:"x",state:"done"}]},"drift"],
 ["whitespace outcome",{microtasks:[{id:"M1",text:"x",state:"done",outcome:" \n\t "}]},"drift"],
 ["all done",{microtasks:[{id:"M1",text:"x",state:"done",outcome:"passed"}]},"on_track"],
 ["in progress",{microtasks:[{id:"M1",text:"x",state:"done",outcome:"passed"},{id:"M2",text:"y",state:"active"},{id:"M3",text:"z",state:"pending"}]},"on_track"],
];
it.each(cases)("R1 %s",(_name,patch,verdict)=>{
 const input=task(patch), result=reviewTaskRules(input);
 expect(result).toMatchObject({verdict,source:"rules"});
 expect(result.reason.trim()).not.toBe("");
 expect(result.reason.length).toBeLessThanOrEqual(160);
 expect(reviewTaskRules(input)).toEqual(result);
});
it("R1 all-done and in-progress reasons distinguish progress",()=>{
 const a=reviewTaskRules(task());
 const b=reviewTaskRules(task({microtasks:[...task().microtasks,{id:"M2",text:"next",state:"pending"}]}));
 expect(a.reason).not.toBe(b.reason);
});
it.each(["active","closed","empty","ready"] as const)("R2 %s brief is bounded and deterministic",kind=>{
 const input=kind==="closed"?plan({status:"closed"}):kind==="empty"?plan({tasks:[]}):kind==="ready"?plan({tasks:[{id:"T03",title:"Ready work",state:"pending",ready:true,waitsFor:[]}]}):plan();
 const result=briefPlanRules(input);
 expect(result.source).toBe("rules");
 expect(result.brief.length).toBeLessThanOrEqual(160);
 expect(result.brief).not.toMatch(/[\r\n]/);
 expect(result.brief).toContain("Next:");
 if(kind==="active") { expect(result.brief).toContain("T01"); expect(result.brief).toContain("T02"); expect(result.brief).toContain("Ship tests"); }
 if(kind==="closed") expect(result.brief).toMatch(/closed/i);
 if(kind==="empty") {expect(result.brief).toMatch(/none/i);expect(result.brief).toContain("0 blocked");}
 if(kind==="ready") {expect(result.brief).toContain("T03");expect(result.brief).toContain("Ready work");}
 expect(briefPlanRules(input)).toEqual(result);
});
it("R2 hostile titles and long blockers preserve single-line bound",()=>{
 const input=plan({tasks:plan().tasks.map(t=>({...t,title:"long\n\r".repeat(100)}))});
 const result=briefPlanRules(input);
 expect(result.brief.length).toBeLessThanOrEqual(160);
 expect(result.brief).not.toMatch(/[\r\n]/);
});
