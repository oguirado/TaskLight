import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_KIND, INGEST_LIMITS, canonicalJson, digestHex, loadFixture, redact, replayDigest } from "../../../src/ingest/index";
import type { CapsuleEvent, ReplayManifest } from "../../../src/ingest/index";
import { AIZA_KEY, HIGH_ENTROPY_TOKEN, PLANTED } from "./helpers";

const repoRoot = process.cwd() + "/";
const manifestJson = readFileSync(repoRoot + "fixtures/replay/v1/manifest.json", "utf8");
const eventsJsonl = readFileSync(repoRoot + "fixtures/replay/v1/events.jsonl", "utf8");
const lines = eventsJsonl.split("\n").filter((l) => l.length > 0);
const events = lines.map((l) => JSON.parse(l) as CapsuleEvent);
const manifest = JSON.parse(manifestJson) as ReplayManifest;

const withId = (e: Omit<CapsuleEvent, "eventId">): CapsuleEvent => ({ ...e, eventId: digestHex(canonicalJson(e)) });
const failsWith = (r: ReturnType<typeof loadFixture>): boolean => !r.ok && r.errors.length > 0;

describe("I11 fixture_shape (committed fixtures/replay/v1)", () => {
  it("5 projects, 200 events, version v1", () => {
    expect(manifest.version).toBe("v1");
    expect(manifest.projects.length).toBe(INGEST_LIMITS.FIXTURE_PROJECTS);
    expect(new Set(manifest.projects.map((p) => p.projectId)).size).toBe(5);
    expect(manifest.eventCount).toBe(INGEST_LIMITS.FIXTURE_EVENTS);
    expect(events.length).toBe(200);
    for (const p of manifest.projects) expect(p.projectId).toMatch(INGEST_LIMITS.PROJECT_ID_RE);
  });
  it("at least one private project, every EVENT_KIND present, events belong to manifest projects", () => {
    expect(manifest.projects.some((p) => p.tier === "private")).toBe(true);
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of EVENT_KIND) expect(kinds.has(k), k).toBe(true);
    const ids = new Set(manifest.projects.map((p) => p.projectId));
    for (const e of events) {
      expect(ids.has(e.projectId)).toBe(true);
      expect(e.tier).toBe(manifest.projects.find((p) => p.projectId === e.projectId)!.tier);
    }
    for (const p of manifest.projects) expect(events.some((e) => e.projectId === p.projectId)).toBe(true);
  });
  it("sourceSeq strictly increasing per (project, source); eventIds valid and unique", () => {
    const last = new Map<string, number>();
    for (const e of events) {
      const k = `${e.projectId}:${e.source}`;
      expect(e.sourceSeq).toBeGreaterThan(last.get(k) ?? -1);
      last.set(k, e.sourceSeq);
      const { eventId, ...rest } = e;
      expect(eventId).toBe(digestHex(canonicalJson(rest)));
    }
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });
  it("loadFixture ok and digest equals manifest, also by direct recompute", () => {
    const r = loadFixture(manifestJson, eventsJsonl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events.length).toBe(200);
    expect(r.value.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(replayDigest(r.value.events)).toBe(r.value.manifest.digest);
    expect(replayDigest(events)).toBe(manifest.digest);
    expect(replayDigest([...events].reverse())).toBe(manifest.digest);
  });
});

describe("I12 fixture_tamper", () => {
  it("one event ts +1 -> load fails with a digest mismatch", () => {
    const t = lines.map((l, i) => (i === 100 ? JSON.stringify({ ...(JSON.parse(l) as CapsuleEvent), ts: (JSON.parse(l) as CapsuleEvent).ts + 1 }) : l));
    const r = loadFixture(manifestJson, t.join("\n") + "\n");
    expect(failsWith(r)).toBe(true);
    if (!r.ok) expect(r.errors.some((e) => /digest/i.test(e.path + " " + (e.detail ?? "")))).toBe(true);
  });
  it("text edit, tampered manifest digest, wrong eventCount, dropped line, extra project all fail", () => {
    const t1 = lines.map((l, i) => (i === 7 ? l.replace(/"text":"/, '"text":"X') : l));
    expect(failsWith(loadFixture(manifestJson, t1.join("\n")))).toBe(true);
    expect(failsWith(loadFixture(JSON.stringify({ ...manifest, digest: "0".repeat(64) }), eventsJsonl))).toBe(true);
    expect(failsWith(loadFixture(JSON.stringify({ ...manifest, eventCount: 199 }), eventsJsonl))).toBe(true);
    expect(failsWith(loadFixture(manifestJson, lines.slice(1).join("\n")))).toBe(true);
    expect(failsWith(loadFixture(JSON.stringify({ ...manifest, projects: manifest.projects.slice(1) }), eventsJsonl))).toBe(true);
  });
  it("garbage input fails without throwing", () => {
    for (const [m, e] of [["", ""], ["{", eventsJsonl], [manifestJson, "not json\n"], [manifestJson, "[]\n"], ["[]", eventsJsonl]] as const) {
      expect(failsWith(loadFixture(m, e))).toBe(true);
    }
  });
  it("B14 residue: a self-consistent fixture (digest recomputed) containing an email or token is still refused", () => {
    for (const bad of ["leak dev@example.com", `leak ${HIGH_ENTROPY_TOKEN}`, "Authorization: Bearer abcDEF123fakeTok"]) {
      const evs = events.map((e, i) => {
        if (i !== 50) return e;
        const { eventId: _x, ...rest } = e;
        return withId({ ...rest, text: bad });
      });
      const m = JSON.stringify({ ...manifest, digest: replayDigest(evs) });
      const r = loadFixture(m, evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
      expect(failsWith(r), bad).toBe(true);
    }
  });
  it("B14 shape: a self-consistent fixture with a bad kind / bad tier / non-hex eventId is refused", () => {
    for (const mut of [{ kind: "bogus" }, { tier: "vip" }, { sourceSeq: -1 }, { redactions: 1.5 }, { text: 7 }] as Array<Record<string, unknown>>) {
      const evs = events.map((e, i) => (i === 3 ? ({ ...e, ...mut } as unknown as CapsuleEvent) : e));
      const m = JSON.stringify({ ...manifest, digest: replayDigest(evs) });
      expect(failsWith(loadFixture(m, evs.map((e) => JSON.stringify(e)).join("\n"))), JSON.stringify(mut)).toBe(true);
    }
  });
});

describe("I13 fixture_clean (negative control for I2 patterns)", () => {
  it("tools/secret_scan.sh fixtures/ exits 0", () => {
    const r = spawnSync("bash", ["tools/secret_scan.sh", "fixtures/"], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
  it("every committed event is a redaction fixed point; no planted secret substring appears", () => {
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const r = redact(e.text);
      expect(r.text).toBe(e.text);
      expect(r.redactions).toBe(0);
      expect(e.text.length).toBeLessThanOrEqual(INGEST_LIMITS.EVENT_TEXT_MAX);
    }
    for (const c of PLANTED) for (const s of c.secrets) expect(eventsJsonl).not.toContain(s);
    expect(eventsJsonl).not.toContain(AIZA_KEY);
    expect(eventsJsonl + manifestJson).not.toMatch(/PRIVATE KEY|Bearer\s+\S|AIza[0-9A-Za-z_-]{35}|[\w.+-]+@[\w-]+\.[\w.-]+|\/home\/[a-z]|\/Users\/[A-Za-z]/);
  });
});
