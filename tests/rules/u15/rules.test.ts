import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAPSULE_STATUS } from "../../../src/schema/enums";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from "firebase/firestore";

const RULES = resolve(__dirname, "../../../firebase/firestore.rules");
let env: RulesTestEnvironment;

const T120 = "h".repeat(120), T121 = "h".repeat(121);
const T600 = "s".repeat(600), T601 = "s".repeat(601);
const ts = () => new Date("2026-11-20T00:00:00Z");

const fullCapsule = (rev: number, over: Record<string, unknown> = {}) => ({
  rev, observed_rev: rev - 1, status: "running", headline: "hi", summary: "sum", next_action: "go",
  attention: "low", inference_source: "ON_DEVICE", updated_at: ts(), writer_uid: "u_ed", ...over,
});
const privCapsule = (rev: number, over: Record<string, unknown> = {}) => ({
  rev, observed_rev: rev - 1, status: "running", attention: "low", updated_at: ts(), writer_uid: "u_ed", ...over,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-context-wall",
    firestore: { rules: readFileSync(RULES, "utf8") },
  });
});
afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "workspaces/ws1"), {
      name: "ws1", members: { u_own: "owner", u_ed: "editor", u_view: "viewer" },
    });
    await setDoc(doc(db, "workspaces/ws1/projects/p1"), {
      name: "P1", source_kind: "terminal", privacy_tier: "standard", template_hash: "h1", created_at: ts(),
    });
    await setDoc(doc(db, "workspaces/ws1/projects/p2"), {
      name: "P2", source_kind: "terminal", privacy_tier: "private", template_hash: "h1", created_at: ts(),
    });
    // Oracle amendment A1 (orchestrator): p3 is a project with no capsule yet, needed by H2/rev-2 cases (E7 denies missing projects).
    await setDoc(doc(db, "workspaces/ws1/projects/p3"), {
      name: "P3", source_kind: "terminal", privacy_tier: "standard", template_hash: "h1", created_at: ts(),
    });
    await setDoc(doc(db, "workspaces/ws1/capsules/p1"), fullCapsule(4));
    await setDoc(doc(db, "workspaces/ws1/capsules/p2"), privCapsule(1));
    await setDoc(doc(db, "workspaces/ws1/ledger/2026-11-20"), {
      on_device: 1, in_cloud: 3, fallbacks: 0, refusals: 0, schema_rejects: 0,
    });
    await setDoc(doc(db, "workspaces/ws1/digests/d0"), {
      rev_vector: { p1: 4 }, needs_you: [], brief: "b", inference_source: "ON_DEVICE", created_at: ts(),
    });
  });
});

const as = (uid: string | null) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const CAP = "workspaces/ws1/capsules/p1";
const PCAP = "workspaces/ws1/capsules/p2";

describe("O1 unauthenticated denied (B2)", () => {
  it("get capsule", async () => { await assertFails(getDoc(doc(as(null), CAP))); });
  it("get workspace", async () => { await assertFails(getDoc(doc(as(null), "workspaces/ws1"))); });
  it("get template", async () => { await assertFails(getDoc(doc(as(null), "templates/h1"))); });
  it("write capsule", async () => { await assertFails(setDoc(doc(as(null), CAP), fullCapsule(5))); });
});

describe("Membership reads (B3, O2)", () => {
  it("O2 non-member cannot get capsule", async () => { await assertFails(getDoc(doc(as("u_out"), CAP))); });
  it("non-member cannot list capsules", async () => {
    await assertFails(getDocs(collection(as("u_out"), "workspaces/ws1/capsules")));
  });
  it("non-member cannot read digest/ledger/project/workspace", async () => {
    const db = as("u_out");
    await assertFails(getDoc(doc(db, "workspaces/ws1/digests/d0")));
    await assertFails(getDoc(doc(db, "workspaces/ws1/ledger/2026-11-20")));
    await assertFails(getDoc(doc(db, "workspaces/ws1/projects/p1")));
    await assertFails(getDoc(doc(db, "workspaces/ws1")));
  });
  it.each(["u_own", "u_ed", "u_view"])("member %s can read capsule and list", async (u) => {
    await assertSucceeds(getDoc(doc(as(u), CAP)));
    await assertSucceeds(getDocs(collection(as(u), "workspaces/ws1/capsules")));
  });
});

describe("Capsule writes (B6-B11)", () => {
  it("O3 viewer cannot update capsule", async () => {
    await assertFails(setDoc(doc(as("u_view"), CAP), fullCapsule(5, { writer_uid: "u_view" })));
  });
  it("O3 viewer cannot create capsule", async () => {
    await assertFails(setDoc(doc(as("u_view"), "workspaces/ws1/capsules/p3"), fullCapsule(1, { writer_uid: "u_view" })));
  });
  it("O4 rev skip denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(6)));
  });
  it("O5 stale rev replay denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(4)));
  });
  it("rev rollback denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(3)));
  });
  it("O6 oversize headline (121) denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { headline: T121 })));
  });
  it("O6 oversize summary (601) denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { summary: T601 })));
  });
  it("O7 boundary text (120/600) allowed", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { headline: T120, summary: T600 })));
  });
  it("O8 private tier with headline denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), PCAP), privCapsule(2, { headline: "x" })));
  });
  it("O8 private tier with summary/next_action/inference_source denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), PCAP), privCapsule(2, { summary: "x" })));
    await assertFails(setDoc(doc(as("u_ed"), PCAP), privCapsule(2, { next_action: "x" })));
    await assertFails(setDoc(doc(as("u_ed"), PCAP), privCapsule(2, { inference_source: "ON_DEVICE" })));
  });
  it("O9 private minimal allowed", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), PCAP), privCapsule(2)));
  });
  it("O10 editor full update allowed", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5)));
  });
  it("owner full update allowed", async () => {
    await assertSucceeds(setDoc(doc(as("u_own"), CAP), fullCapsule(5, { writer_uid: "u_own" })));
  });
  it("editor creates new capsule at rev 1 (H2)", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p3"), fullCapsule(1)));
  });
  it("create with rev 2 denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p3"), fullCapsule(2)));
  });
  it("O11 off-allowlist field denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { raw_log: "secret" })));
  });
  it("O13 status off enum denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { status: "banana" })));
  });
  it("writer_uid mismatch denied (B7, hypothesis)", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { writer_uid: "u_own" })));
  });
  it("partial update via updateDoc that skips rev denied", async () => {
    await assertFails(updateDoc(doc(as("u_ed"), CAP), { headline: "new" }));
  });
  it("capsule delete: owner allowed, editor denied (hypothesis)", async () => {
    await assertFails(deleteDoc(doc(as("u_ed"), CAP)));
    await assertSucceeds(deleteDoc(doc(as("u_own"), CAP)));
  });
  it("capsule for project with missing project doc denied (E7)", async () => {
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/ghost"), fullCapsule(1)));
  });
});

describe("Deny by default (B1, O12)", () => {
  it("O12 unknown subcollection create denied", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1/events/e1"), { x: 1 }));
  });
  it("unknown subcollection read denied for member", async () => {
    await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), "workspaces/ws1/logs/l1"), { x: 1 }); });
    await assertFails(getDoc(doc(as("u_own"), "workspaces/ws1/logs/l1")));
  });
  it("unknown top-level collection denied", async () => {
    await assertFails(setDoc(doc(as("u_own"), "random/r1"), { x: 1 }));
    await assertFails(getDoc(doc(as("u_own"), "random/r1")));
  });
});

describe("Projects and workspaces (B4, B5)", () => {
  const proj = (over: Record<string, unknown> = {}) => ({
    name: "P3", source_kind: "terminal", privacy_tier: "standard", template_hash: "h1", created_at: ts(), ...over,
  });
  it("owner creates project", async () => {
    await assertSucceeds(setDoc(doc(as("u_own"), "workspaces/ws1/projects/p4"), proj()));
  });
  it("editor/viewer cannot create project", async () => {
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/projects/p4"), proj()));
    await assertFails(setDoc(doc(as("u_view"), "workspaces/ws1/projects/p4"), proj()));
  });
  it("invalid privacy_tier denied", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1/projects/p4"), proj({ privacy_tier: "public" })));
  });
  it("extra project key denied", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1/projects/p4"), proj({ extra: 1 })));
  });
  it("workspace create: self-owner allowed", async () => {
    await assertSucceeds(setDoc(doc(as("u_new"), "workspaces/u_new"), { name: "me", members: { u_new: "owner" } }));
  });
  it("workspace create: adding another member or non-owner role denied", async () => {
    await assertFails(setDoc(doc(as("u_new"), "workspaces/w2"), { name: "x", members: { u_new: "owner", u_ed: "editor" } }));
    await assertFails(setDoc(doc(as("u_new"), "workspaces/w3"), { name: "x", members: { u_new: "editor" } }));
  });
  it("workspace update: owner allowed, editor denied", async () => {
    const m = { u_own: "owner", u_ed: "editor", u_view: "viewer", u_x: "viewer" };
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1"), { name: "ws1", members: m }));
    await assertSucceeds(setDoc(doc(as("u_own"), "workspaces/ws1"), { name: "ws1", members: m }));
  });
  it("owner updates existing seeded project p3 (update path)", async () => {
    await assertSucceeds(setDoc(doc(as("u_own"), "workspaces/ws1/projects/p3"), proj()));
  });
  it("B4 owner cannot empty members", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1"), { name: "ws1", members: {} }));
  });
  it("B4 owner cannot remove the last owner (demote self)", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1"), { name: "ws1", members: { u_own: "editor", u_ed: "editor" } }));
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1"), { name: "ws1", members: { u_ed: "editor" } }));
  });
  it("B4 invalid role value denied", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1"), { name: "ws1", members: { u_own: "owner", u_x: "superuser" } }));
  });
  it("B4 owner may transfer ownership while keeping an owner", async () => {
    await assertSucceeds(setDoc(doc(as("u_own"), "workspaces/ws1"), { name: "ws1", members: { u_own: "editor", u_ed: "owner" } }));
  });
  it("workspace delete denied (hypothesis)", async () => {
    await assertFails(deleteDoc(doc(as("u_own"), "workspaces/ws1")));
  });
});

describe("Repair loop 1: type and enum strictness", () => {
  it("B7 rev double 5.5 denied on a normal update", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5.5, { observed_rev: 4 })));
  });
  it("B7 rev must be int: malformed stored rev 4.5 then incoming 5.5 denied", async () => {
    // Note: JS SDK serialises 5.0 as integerValue, so a double 5.0 is not producible here; 4.5 -> 5.5 satisfies numeric equality only.
    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore();
      await setDoc(doc(db, "workspaces/ws1/projects/p4"), {
        name: "P4", source_kind: "terminal", privacy_tier: "standard", template_hash: "h1", created_at: ts(),
      });
      await setDoc(doc(db, "workspaces/ws1/capsules/p4"), fullCapsule(4.5, { observed_rev: 4 }));
    });
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p4"), fullCapsule(5.5, { observed_rev: 4 })));
  });
  it.each(["headline", "summary", "next_action"])("B10 %s must be a string (array/map denied)", async (f) => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { [f]: [] })));
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { [f]: { a: 1 } })));
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { [f]: 7 })));
  });
  it("B12 digest brief must be a string (array/map denied)", async () => {
    const base = { rev_vector: { p1: 5 }, needs_you: ["p1"], inference_source: "IN_CLOUD", created_at: ts() };
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/digests/d2"), { ...base, brief: [] }));
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/digests/d3"), { ...base, brief: { a: 1 } }));
  });
  it("E5 status list in rules equals CAPSULE_STATUS (text)", () => {
    const txt = readFileSync(RULES, "utf8");
    const m = [...txt.matchAll(/status in \[([^\]]*)\]/g)];
    if (m.length !== 1) throw new Error("expected exactly one status list, found " + m.length);
    const inRules = (m[0]?.[1] ?? "").split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort();
    if ((CAPSULE_STATUS as readonly string[]).length === 0) throw new Error("CAPSULE_STATUS empty at runtime");
    if (JSON.stringify(inRules) !== JSON.stringify([...CAPSULE_STATUS].sort())) {
      throw new Error("status parity mismatch: " + inRules.join("|") + " vs " + CAPSULE_STATUS.join("|"));
    }
  });
  it("E5 every CAPSULE_STATUS value allowed, outside value denied", async () => {
    if ((CAPSULE_STATUS as readonly string[]).length === 0) throw new Error("CAPSULE_STATUS empty at runtime");
    let rev = 5;
    for (const st of CAPSULE_STATUS) {
      await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(rev, { status: st })));
      rev++;
    }
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(rev, { status: "banana" })));
  });
});

describe("Digests (B12)", () => {
  const dg = (over: Record<string, unknown> = {}) => ({
    rev_vector: { p1: 5 }, needs_you: ["p1"], brief: "b", inference_source: "IN_CLOUD", created_at: ts(), ...over,
  });
  const D = "workspaces/ws1/digests/d1";
  it("non-member cannot read or write", async () => {
    await assertFails(getDoc(doc(as("u_out"), "workspaces/ws1/digests/d0")));
    await assertFails(setDoc(doc(as("u_out"), D), dg()));
  });
  it("member reads", async () => {
    await assertSucceeds(getDoc(doc(as("u_view"), "workspaces/ws1/digests/d0")));
  });
  it("editor creates, viewer cannot", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), D), dg()));
  });
  it("repair3: viewer cannot CREATE an unseeded digest (d2, create path)", async () => {
    await assertFails(setDoc(doc(as("u_view"), "workspaces/ws1/digests/d2"), dg()));
  });
  it("repair3: viewer cannot update an existing digest (immutable update path)", async () => {
    await assertFails(setDoc(doc(as("u_view"), "workspaces/ws1/digests/d0"), dg()));
  });
  it("bad inference_source, oversize brief, extra key denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), D), dg({ inference_source: "OTHER" })));
    await assertFails(setDoc(doc(as("u_ed"), D), dg({ brief: "b".repeat(601) })));
    await assertFails(setDoc(doc(as("u_ed"), D), dg({ extra: 1 })));
  });
  it("update and delete immutable", async () => {
    await assertFails(setDoc(doc(as("u_own"), "workspaces/ws1/digests/d0"), dg()));
    await assertFails(deleteDoc(doc(as("u_own"), "workspaces/ws1/digests/d0")));
  });
});

describe("O14 templates immutable (B13)", () => {
  it("signed-in create allowed, then update/delete denied", async () => {
    const t = doc(as("u_ed"), "templates/h1");
    await assertSucceeds(setDoc(t, { spec: {} }));
    await assertFails(setDoc(t, { spec: { a: 1 } }));
    await assertFails(deleteDoc(t));
  });
  it("preexisting template: signed-in read ok, update/delete denied even for owner", async () => {
    await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), "templates/h9"), { spec: {} }); });
    await assertSucceeds(getDoc(doc(as("u_own"), "templates/h9")));
    await assertFails(updateDoc(doc(as("u_own"), "templates/h9"), { spec: { b: 1 } }));
    await assertFails(deleteDoc(doc(as("u_own"), "templates/h9")));
  });
  it("create with extra keys denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), "templates/h2"), { spec: {}, extra: 1 }));
  });
});

describe("O15 ledger counters (B14)", () => {
  const L = "workspaces/ws1/ledger/2026-11-20";
  const led = (over: Record<string, unknown> = {}) => ({
    on_device: 1, in_cloud: 3, fallbacks: 0, refusals: 0, schema_rejects: 0, ...over,
  });
  it("decrease denied", async () => { await assertFails(setDoc(doc(as("u_view"), L), led({ in_cloud: 2 }))); });
  it("increase by viewer allowed", async () => { await assertSucceeds(setDoc(doc(as("u_view"), L), led({ in_cloud: 4 }))); });
  it("non-member denied", async () => { await assertFails(setDoc(doc(as("u_out"), L), led({ in_cloud: 4 }))); });
  it("extra key / negative / non-integer denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), L), led({ in_cloud: 4, extra: 1 })));
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/ledger/2026-11-21"), led({ in_cloud: -1 })));
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/ledger/2026-11-21"), led({ in_cloud: 1.5 })));
  });
  it("member creates new day", async () => {
    await assertSucceeds(setDoc(doc(as("u_view"), "workspaces/ws1/ledger/2026-11-21"), led()));
  });
  it("delete denied", async () => { await assertFails(deleteDoc(doc(as("u_own"), L))); });
});

describe("Repair loop 2: E7 unknown tier fail-closed", () => {
  const seedTier = async (p: string, tier: unknown) => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `workspaces/ws1/projects/${p}`), {
        name: p, source_kind: "terminal", privacy_tier: tier, template_hash: "h1", created_at: ts(),
      });
    });
  };
  it("unknown tier string + text fields denied (create)", async () => {
    await seedTier("p5", "unknown");
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p5"), fullCapsule(1)));
  });
  it("unknown tier + text fields denied (update from rev 4)", async () => {
    await seedTier("p1", "unknown");
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5)));
  });
  it("non-string tier + text fields denied", async () => {
    await seedTier("p6", 7);
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p6"), fullCapsule(1)));
  });
  it("shared tier still allowed", async () => {
    await seedTier("p7", "shared");
    await assertSucceeds(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p7"), fullCapsule(1)));
  });
});

describe("Repair loop 2: capsule inference_source enum", () => {
  it("invalid string denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { inference_source: "OTHER" })));
  });
  it("map denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { inference_source: { arbitrary: true } })));
  });
  it("ON_DEVICE accepted", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { inference_source: "ON_DEVICE" })));
  });
  it("IN_CLOUD accepted", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { inference_source: "IN_CLOUD" })));
  });
});

describe("Repair loop 2: H1 provenance header", () => {
  it("firestore.rules starts with // TO VERIFY comment", () => {
    const first = readFileSync(RULES, "utf8").replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
    if (!/^\/\/\s*TO VERIFY\b/.test(first)) throw new Error(`first line lacks "// TO VERIFY" provenance: ${first}`);
  });
});

describe("Repair loop 3: observed_rev and Unicode length", () => {
  it.each([[-1], [1.5], ["4"], [null]])("observed_rev %j denied (valid rev increment)", async (v) => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { observed_rev: v as unknown as number })));
  });
  it("observed_rev missing denied", async () => {
    const c: Record<string, unknown> = fullCapsule(5);
    delete c.observed_rev;
    await assertFails(setDoc(doc(as("u_ed"), CAP), c));
  });
  it("observed_rev 0 and large int allowed", async () => {
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { observed_rev: 0 })));
    await assertSucceeds(setDoc(doc(as("u_ed"), "workspaces/ws1/capsules/p3"), fullCapsule(1, { observed_rev: 999 })));
  });
  it("private tier observed_rev -1 / 1.5 / string denied", async () => {
    for (const v of [-1, 1.5, "1"]) {
      await assertFails(setDoc(doc(as("u_ed"), PCAP), privCapsule(2, { observed_rev: v as unknown as number })));
    }
  });
  // CJK is BMP: UTF-16 length == code points, so limits are unambiguous.
  // Denials first, success last: a success bumps stored rev to 5 and would make later denials vacuous (rev guard).
  it("CJK 120 headline / 600 summary allowed, 121 / 601 denied", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { headline: "漢".repeat(121) })));
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { summary: "字".repeat(601) })));
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { next_action: "漢".repeat(121) })));
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { headline: "漢".repeat(120), summary: "字".repeat(600), next_action: "漢".repeat(120) })));
  });
  // Astral emoji: 2 UTF-16 units each. MEASURED on the emulator: rules .size() counts UTF-16 units (max 60 emoji in a 120 field), matching spec .length.
  it("emoji: 60 (=120 UTF-16) accepted, 61 (=122) denied; summary 300 / 301", async () => {
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { headline: "😀".repeat(61) })));
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { summary: "😀".repeat(301) })));
    await assertFails(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { next_action: "😀".repeat(61) })));
    await assertSucceeds(setDoc(doc(as("u_ed"), CAP), fullCapsule(5, { headline: "😀".repeat(60), summary: "😀".repeat(300), next_action: "😀".repeat(60) })));
  });
  it("emoji digest brief: 300 accepted, 301 denied", async () => {
    const d = { rev_vector: { p1: 5 }, needs_you: [], inference_source: "IN_CLOUD", created_at: ts() };
    await assertSucceeds(setDoc(doc(as("u_ed"), "workspaces/ws1/digests/e1"), { ...d, brief: "😀".repeat(300) }));
    await assertFails(setDoc(doc(as("u_ed"), "workspaces/ws1/digests/e2"), { ...d, brief: "😀".repeat(301) }));
  });
});
