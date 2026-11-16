import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("V7 static direct timers have a single fallback construction",()=>{
 const root=resolve("src/planai");
 const direct:{kind:string;file:string}[]=[];
 for(const file of readdirSync(root).filter(f=>f.endsWith(".ts"))){
  const text=readFileSync(resolve(root,file),"utf8");
  // Strip comments; types.ts contains method signatures rather than timer calls.
  const code=text.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");
  expect(code,file).not.toMatch(/\bDate\s*\.\s*now\s*\(/);
  expect(code,file).not.toMatch(/\bsetInterval\s*\(/);
  if(file==="types.ts")continue;
  for(const match of code.matchAll(/(?<![\w.])(?:(?:globalThis|window)\s*\.\s*)?(setTimeout|clearTimeout)\s*\(/g))
   direct.push({kind:match[1]!,file});
 }
 // The only permitted native calls construct the default clock. Dynamic tests
 // additionally forbid all native timer access when an injected clock is used.
 for(const kind of ["setTimeout","clearTimeout"])
  expect(direct.filter(v=>v.kind===kind).length,kind).toBeLessThanOrEqual(1);
 if(direct.length===2)expect(direct[0]?.file).toBe(direct[1]?.file);
});
