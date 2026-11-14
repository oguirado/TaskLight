// U37c static guards over the new modules (pass on the stubs by design; they protect the real code).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = (f: string): string => strip(readFileSync(resolve(ROOT, f), "utf8"));

describe("hygiene of the U37c modules", () => {
  it.each(["extension/src/agent_relay.ts", "src/app/agent_link.ts", "src/app/agent_wall.ts"])("%s never logs and never touches storage", (f) => {
    const s = src(f);
    expect(s).not.toMatch(/\bconsole\s*\./);
    expect(s).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|storage\s*\.\s*(session|local))\b/);
  });
  it("agent_relay.ts and the page modules never reference the chrome global (ports are injected)", () => {
    for (const f of ["extension/src/agent_relay.ts", "src/app/agent_link.ts", "src/app/agent_wall.ts"]) expect(src(f), f).not.toMatch(/\bchrome\s*\./);
  });
  it("page modules never import firebase/* (U06 is the only caller)", () => {
    for (const f of ["src/app/agent_link.ts", "src/app/agent_wall.ts"]) expect(src(f), f).not.toMatch(/from\s+["']firebase\//);
  });
  it("page modules render no HTML from room text (no innerHTML / insertAdjacentHTML / eval)", () => {
    for (const f of ["src/app/agent_link.ts", "src/app/agent_wall.ts"]) expect(src(f), f).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|eval|new Function)\b/);
  });
});
