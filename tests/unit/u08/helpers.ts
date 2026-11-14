import type { PrivacyTier } from "../../../src/schema";
import type { CapsuleEvent, EventSource, ProjectRegistry } from "../../../src/ingest/index";

export interface PlantedCase { cls: string; text: string; secrets: string[]; exactClass: boolean }

// All values are obviously fake (D-4).
export const PEM_BODY = "MIIFAKEFAKEFAKEfakefakefake0123456789notarealkeyZZZZ";
export const HIGH_ENTROPY_TOKEN = "Zk3Qm9xT7vLp2RwYc8NfH5dJb1GsA6uE0eXo4iKt";
// Fake-secret literals are assembled at runtime so scanners and push protection do not flag the source.
export const AIZA_KEY = "AIza" + "SyFAKEfakeFAKE0123456789abcdefghiJK";
const PEM_BEGIN = "-----BEGIN RSA PRIVATE" + " KEY-----";
const PEM_END = "-----END RSA PRIVATE" + " KEY-----";
export const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZXNpZ25hdHVyZTEyMzQ1";

export const PLANTED: PlantedCase[] = [
  { cls: "PRIVATE_KEY", exactClass: true, secrets: [PEM_BODY, "BEGIN RSA PRIVATE KEY", "END RSA PRIVATE KEY"],
    text: `key follows\n${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}\nend` },
  { cls: "BEARER", exactClass: true, secrets: ["abcDEF123fakeTok"], text: "Authorization: Bearer abcDEF123fakeTok" },
  { cls: "JWT", exactClass: true, secrets: [JWT, "eyJzdWIiOiJmYWtlLXVzZXIifQ"], text: `session ${JWT} issued` },
  { cls: "KEY_ASSIGN", exactClass: true, secrets: ["sk-FAKE-0000-not-real"], text: "OPENAI_API_KEY=sk-FAKE-0000-not-real" },
  { cls: "KEY_ASSIGN", exactClass: true, secrets: ["hunter2fake"], text: "db password: hunter2fake" },
  { cls: "URL_CREDS", exactClass: true, secrets: ["fakeuser:fakepw", "fakepw"], text: "clone https://fakeuser:fakepw@host.example/repo.git" },
  { cls: "APPCHECK_DEBUG", exactClass: false, secrets: ["11111111-2222-3333-4444-555555555555"],
    text: 'AppCheck debug token: "11111111-2222-3333-4444-555555555555" (set it in the console)' },
  { cls: "APPCHECK_DEBUG", exactClass: false, secrets: ["99999999-8888-7777-6666-555555555555"],
    text: "FIREBASE_APPCHECK_DEBUG_TOKEN=99999999-8888-7777-6666-555555555555" },
  { cls: "EMAIL", exactClass: true, secrets: ["dev@example.com"], text: "contact dev@example.com for access" },
  { cls: "HIGH_ENTROPY", exactClass: true, secrets: [HIGH_ENTROPY_TOKEN], text: `value ${HIGH_ENTROPY_TOKEN} here` },
  { cls: "HIGH_ENTROPY", exactClass: true, secrets: [AIZA_KEY], text: `web key ${AIZA_KEY} leaked` },
];

export const HOME_PATH_CASES: Array<{ text: string; secrets: string[] }> = [
  { text: "error at /home/jdoe42/projects/app/src/main.ts:10", secrets: ["jdoe42"] },
  { text: "error at /Users/jdoe42/code/app/index.js", secrets: ["jdoe42"] },
  { text: "error at C:\\Users\\jdoe42\\code\\app\\index.js", secrets: ["jdoe42"] },
];

export const mkReg = (
  projects: Record<string, PrivacyTier> = { p1: "standard", p2: "private" },
  seqs: Record<string, number> = {},
): ProjectRegistry => ({
  tierOf: (p) => projects[p],
  lastSeq: (p, s) => seqs[`${p}:${s}`],
});

export const rawEnv = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ source: "agent", projectId: "p1", sourceSeq: 1, ts: 1000, kind: "waiting_input", text: "Approve migration?", ...o });

export const GROUP: Record<EventSource, string[]> = {
  agent: ["output", "waiting_input", "error", "exit"],
  ci: ["ci_started", "ci_passed", "ci_failed"],
  git: ["commit", "push"],
};

export const FIXTURE_PROJECT_IDS = ["alpha", "beta", "gamma", "delta", "epsilon"];

/** Deterministic 200 raw envelopes over 5 projects, every kind present, some planted secrets. */
export function genRaw(n = 200): string[] {
  const reg: Record<string, PrivacyTier> = {};
  FIXTURE_PROJECT_IDS.forEach((p, i) => { reg[p] = i === 1 ? "private" : "standard"; });
  const seq: Record<string, number> = {};
  const sources: EventSource[] = ["agent", "ci", "git"];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const projectId = FIXTURE_PROJECT_IDS[i % 5]!;
    const source = sources[i % 3]!;
    const kinds = GROUP[source];
    const kind = kinds[Math.floor(i / 3) % kinds.length]!;
    const k = `${projectId}:${source}`;
    seq[k] = (seq[k] ?? 0) + 1;
    const text = i % 7 === 0 ? `note ${i} mail user${i}@example.test` : `step ${i} ok`;
    out.push(JSON.stringify({ source, projectId, sourceSeq: seq[k], ts: 1_700_000_000_000 + i * 250, kind, text }));
  }
  return out;
}

/** Normalise a raw list in order, tracking sequence like a live registry. */
export function normaliseAll(normaliseFn: (raw: string, reg: ProjectRegistry) => { ok: boolean; value?: CapsuleEvent }, raws: string[]): CapsuleEvent[] {
  const projects: Record<string, PrivacyTier> = {};
  FIXTURE_PROJECT_IDS.forEach((p, i) => { projects[p] = i === 1 ? "private" : "standard"; });
  const seqs: Record<string, number> = {};
  const evs: CapsuleEvent[] = [];
  for (const raw of raws) {
    const r = normaliseFn(raw, mkReg(projects, seqs));
    if (!r.ok || !r.value) throw new Error("normalise rejected a valid generated event");
    evs.push(r.value);
    seqs[`${r.value.projectId}:${r.value.source}`] = r.value.sourceSeq;
  }
  return evs;
}

export const mkEvent = (o: Partial<CapsuleEvent> = {}): CapsuleEvent => ({
  eventId: "e".repeat(64), projectId: "p1", source: "agent", kind: "output",
  sourceSeq: 1, ts: 1000, text: "hello", redactions: 0, truncated: false, tier: "standard", ...o,
});
