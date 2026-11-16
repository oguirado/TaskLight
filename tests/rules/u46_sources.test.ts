// U46 rules oracle. Needs the Firestore emulator (run deferred to W3). R1 is pure text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { INFERENCE_SOURCE } from "../../src/schema/enums";

const RULES = resolve(__dirname, "../../firebase/firestore.rules");
let env: RulesTestEnvironment;
const ts = () => new Date("2026-11-20T00:00:00Z");
const FOUR = ["ON_DEVICE", "IN_CLOUD", "LOCAL_SERVER", "REMOTE_PROVIDER"];
const BAD: unknown[] = ["OTHER", "local_server", "REMOTE", 5, {}];

const cap = (rev: number, over: Record<string, unknown> = {}) => ({
  rev, observed_rev: rev - 1, status: "running", headline: "hi", summary: "sum", next_action: "go",
  attention: "low", inference_source: "ON_DEVICE", updated_at: ts(), writer_uid: "u_ed", ...over,
});
const privCap = (rev: number, over: Record<string, unknown> = {}) => ({
  rev, observed_rev: rev - 1, status: "running", attention: "low", updated_at: ts(), writer_uid: "u_ed", ...over,
});
const dg = (over: Record<string, unknown> = {}) => ({
  rev_vector: { p1: 5 }, needs_you: ["p1"], brief: "b", inference_source: "IN_CLOUD", created_at: ts(), ...over,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-context-wall", firestore: { rules: readFileSync(RULES, "utf8") } });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "workspaces/ws1"), { name: "ws1", members: { u_own: "owner", u_ed: "editor", u_view: "viewer" } });
    await setDoc(doc(db, "workspaces/ws1/projects/p1"), { name: "P1", source_kind: "terminal", privacy_tier: "standard", template_hash: "h1", created_at: ts() });
    await setDoc(doc(db, "workspaces/ws1/projects/p2"), { name: "P2", source_kind: "terminal", privacy_tier: "private", template_hash: "h1", created_at: ts() });
    await setDoc(doc(db, "workspaces/ws1/capsules/p1"), cap(4));
    await setDoc(doc(db, "workspaces/ws1/capsules/p2"), privCap(1));
  });
});
const ed = () => env.authenticatedContext("u_ed").firestore();
const CAP = "workspaces/ws1/capsules/p1";
const PCAP = "workspaces/ws1/capsules/p2";

describe("R1 rules text", () => {
  it("exactly 2 `inference_source in [...]` lists, each equal as a set to INFERENCE_SOURCE", () => {
    const txt = readFileSync(RULES, "utf8");
    const m = [...txt.matchAll(/inference_source\s+in\s+\[([^\]]*)\]/g)];
    expect(m.length).toBe(2);
    for (const x of m) {
      const vals = (x[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, "")).sort();
      expect(vals).toEqual([...INFERENCE_SOURCE].sort());
      expect(vals).toEqual([...FOUR].sort());
    }
  });
});

describe("R2 standard capsule and digest accept the 4 values, reject the rest", () => {
  it.each(FOUR)("capsule accepts %s", async (v) => { await assertSucceeds(setDoc(doc(ed(), CAP), cap(5, { inference_source: v }))); });
  it.each(FOUR)("digest accepts %s", async (v) => { await assertSucceeds(setDoc(doc(ed(), "workspaces/ws1/digests/dN"), dg({ inference_source: v }))); });
  it.each(BAD.map((b) => [JSON.stringify(b), b]))("capsule rejects %s", async (_n, v) => { await assertFails(setDoc(doc(ed(), CAP), cap(5, { inference_source: v }))); });
  it.each(BAD.map((b) => [JSON.stringify(b), b]))("digest rejects %s", async (_n, v) => { await assertFails(setDoc(doc(ed(), "workspaces/ws1/digests/dN"), dg({ inference_source: v }))); });
  it("capsule without inference_source still accepted (optional key)", async () => {
    const { inference_source: _drop, ...rest } = cap(5);
    await assertSucceeds(setDoc(doc(ed(), CAP), rest));
  });
  it("digest without inference_source still denied (required key)", async () => {
    const { inference_source: _drop, ...rest } = dg();
    await assertFails(setDoc(doc(ed(), "workspaces/ws1/digests/dN"), rest));
  });
  it("viewer still cannot write a new-source capsule or digest", async () => {
    const v = env.authenticatedContext("u_view").firestore();
    await assertFails(setDoc(doc(v, CAP), cap(5, { inference_source: "LOCAL_SERVER", writer_uid: "u_view" })));
    await assertFails(setDoc(doc(v, "workspaces/ws1/digests/dV"), dg({ inference_source: "REMOTE_PROVIDER" })));
  });
});

describe("R3 private capsule never carries inference_source", () => {
  it("baseline: private capsule without inference_source is accepted", async () => { await assertSucceeds(setDoc(doc(ed(), PCAP), privCap(2))); });
  it.each(FOUR)("private capsule with inference_source %s denied", async (v) => { await assertFails(setDoc(doc(ed(), PCAP), privCap(2, { inference_source: v }))); });
});
