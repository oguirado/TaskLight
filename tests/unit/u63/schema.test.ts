import { expect, it } from "vitest";
import { parseTaskReviewOutput, parsePlanBriefOutput, TASK_REVIEW_SCHEMA, PLAN_BRIEF_SCHEMA } from "../../../src/planai/schema";
it("S1 schemas match the supported contract",()=>{
 expect(TASK_REVIEW_SCHEMA).toEqual({type:"object",properties:{verdict:{type:"string",enum:["on_track","drift","needs_user"]},reason:{type:"string"}},required:["verdict","reason"]});
 expect(PLAN_BRIEF_SCHEMA).toEqual({type:"object",properties:{brief:{type:"string"}},required:["brief"]});
});
const invalid: [string,string,"bad_json"|"schema_reject"][]=[
 ["invalid JSON","not json","bad_json"],
 ["array","[]","schema_reject"],["null","null","schema_reject"],
 ["number","42","schema_reject"],["boolean","true","schema_reject"],
 ["string",'"text"',"schema_reject"],["missing keys","{}","schema_reject"],
 ["wrong types",'{"verdict":1,"reason":true,"brief":[]}',"schema_reject"],
 ["empty",'{"verdict":"drift","reason":"","brief":""}',"schema_reject"],
 ["whitespace",'{"verdict":"drift","reason":"  ","brief":"  "}',"schema_reject"],
 ["controls",JSON.stringify({verdict:"drift",reason:"\x00\n\r\x7f",brief:"\x00\n\r\x7f"}),"schema_reject"],
];
for(const [job,parse] of [["task",parseTaskReviewOutput],["brief",parsePlanBriefOutput]] as const){
 it.each(invalid)("S2 "+job+" rejects %s",(_name,raw,code)=>{
  expect(parse(raw)).toEqual({ok:false,code});
 });
 it("S3 "+job+" cleans controls and truncates valid long output",()=>{
  const raw=JSON.stringify({verdict:"drift",reason:"a\n\r\x00\x7f"+"x".repeat(200),brief:"a\n\r\x00\x7f"+"x".repeat(200)});
  const result=parse(raw);
  expect(result.ok).toBe(true);
  if(result.ok){
   const value="reason" in result.value?result.value.reason:result.value.brief;
   expect(value).not.toMatch(/[\x00-\x1f\x7f]/);
   expect(value).toHaveLength(160);
   expect(value.endsWith("...")).toBe(true);
  }
 });
}
it.each(["on_track","drift","needs_user"])("S4 accepts verdict %s",verdict=>{
 expect(parseTaskReviewOutput(JSON.stringify({verdict,reason:"ok"}))).toEqual({ok:true,value:{verdict,reason:"ok"}});
});
it("S4 rejects unknown verdict",()=>{
 expect(parseTaskReviewOutput('{"verdict":"maybe","reason":"x"}')).toEqual({ok:false,code:"schema_reject"});
});
it("S4 accepts nonempty brief",()=>{
 expect(parsePlanBriefOutput('{"brief":"Next: none; 0 blocked"}')).toEqual({ok:true,value:{brief:"Next: none; 0 blocked"}});
});
