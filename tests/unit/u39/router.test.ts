import { describe, expect, it } from "vitest";
import { MIN_COVERAGE_PPM, MIN_MARGIN_PPM, MAX_TEXT, NANO_TIMEOUT_MS } from "../../../src/router/score";
import { routeEvent, routeText } from "../../../src/router/route";
import { tableHash, validateTable, ROUTE_TABLE } from "../../../src/router/table";
import { tokenize } from "../../../src/router/tokenize";
import { ROUTE_TARGETS } from "../../../src/router/types";
import type { RouteDecision, RouteTable } from "../../../src/router/types";
import {
  ACCENT_PAIRS, ACTS, ANCHORS, CLEAR_TABLE, EVENT_PER_ACT, HOSTILE, TIE_TABLE, TIE_TEXT,
  decisionProblems, ev, loadGolden, rule, table,
} from "./fixtures";

const j = (d: unknown): string => JSON.stringify(d);

describe("constants (spec)", () => {
  it("pins the tunables", () => {
    expect(MIN_MARGIN_PPM).toBe(100_000);
    expect(MIN_COVERAGE_PPM).toBe(250_000);
    expect(NANO_TIMEOUT_MS).toBe(400);
    expect(MAX_TEXT).toBe(1000);
    expect([...ROUTE_TARGETS]).toEqual(["ask_agent", "plan_change", "escalate", "status_query", "focus_capsule", "handoff", "ack_noise", "inbox"]);
  });
  it("the shipped table is valid and non-trivial", () => {
    expect(validateTable(ROUTE_TABLE)).toEqual([]);
    expect(ROUTE_TABLE.rules.length).toBeGreaterThanOrEqual(7);
    const targets = new Set(ROUTE_TABLE.rules.map((r) => r.target));
    for (const t of ROUTE_TARGETS.filter((x) => x !== "inbox")) expect(targets.has(t), t).toBe(true);
  });
});

describe("tokenize", () => {
  it("A2: PlanChange tokenizes to plan, change", () => {
    expect(tokenize("PlanChange")).toEqual(["plan", "change"]);
    expect(tokenize("plan_change")).toEqual(["plan", "change"]);
  });
  it("folds accents, case and compatibility forms", () => {
    expect(tokenize("planificación")).toEqual(tokenize("PLANIFICACION"));
    expect(tokenize("ＰＬＡＮ　ＣＨＡＮＧＥ")).toEqual(["plan", "change"]);
    for (const t of tokenize("¿Cómo va la Cápsula, ÑANDÚ?")) {
      expect(t).toBe(t.toLowerCase());
      expect(t).not.toMatch(/\p{M}/u);
      expect(t.length).toBeGreaterThan(0);
    }
  });
  it("empty and punctuation-only inputs give no tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" \n\t ¿?!... ")).toEqual([]);
  });
  it("is pure", () => {
    expect(tokenize("cambio de planificación")).toEqual(tokenize("cambio de planificación"));
  });
});

describe("A1 exact stage", () => {
  it("question with `to` routes to ask_agent regardless of text", () => {
    for (const text of ["", "bake a cake for grandma", "cambio de planificación", "ok thanks", "estoy bloqueado, necesito aprobación", "x".repeat(5000)]) {
      const d = routeEvent(ev("question", text, { to: "claude-code" }));
      expect(d.status).toBe("OK");
      expect(d.target).toBe("ask_agent");
      expect(d.agent).toBe("claude-code");
      expect(d.stage).toBe("exact");
    }
  });
  it("the destination is the `to` value verbatim", () => {
    expect(routeEvent(ev("question", "hola", { to: "codex" })).agent).toBe("codex");
    expect(routeEvent(ev("question", "hola", { to: "gemini-cli" })).agent).toBe("gemini-cli");
  });
  it("J1: act=plan with a plan body routes to plan_change at stage exact", () => {
    const d = routeEvent(ev("plan", "anything", { plan: { title: "T", steps: [{ text: "a" }] } }));
    expect([d.status, d.target, d.stage]).toEqual(["OK", "plan_change", "exact"]);
  });
  it("J2: verdict mentioning needs_user escalates at stage exact", () => {
    const d = routeEvent(ev("verdict", "needs_user: cannot choose"));
    expect([d.status, d.target, d.stage]).toEqual(["OK", "escalate", "exact"]);
  });
  it("J3: @<agent-id> addressing sets the agent exactly", () => {
    const d = routeEvent(ev("answer", "@claude-code revisa por favor el test"));
    expect([d.status, d.target, d.stage, d.agent]).toEqual(["OK", "ask_agent", "exact", "claude-code"]);
  });
  it("exact beats a lexical hit", () => {
    const d = routeEvent(ev("question", "focus the capsule", { to: "codex" }));
    expect(d.stage).toBe("exact");
    expect(d.target).toBe("ask_agent");
  });
  it("question without `to` and with no vocabulary is not exact", () => {
    expect(routeEvent(ev("question", "bake a cake for grandma")).stage).not.toBe("exact");
  });
});

describe("A2 accents and folding", () => {
  it.each(ACCENT_PAIRS)("%s == %s", (a, b) => {
    expect(j(routeText(a))).toBe(j(routeText(b)));
  });
  it("spec pair gives plan_change", () => {
    const a = routeText("cambio de planificación");
    expect(a.status).toBe("OK");
    expect(a.target).toBe("plan_change");
    expect(a.stage).toBe("lexical");
  });
  it("case and fullwidth do not change the decision", () => {
    expect(j(routeText("FOCUS THE CAPSULE"))).toBe(j(routeText("focus the capsule")));
    expect(j(routeText("ＦＯＣＵＳ ＴＨＥ ＣＡＰＳＵＬＥ"))).toBe(j(routeText("focus the capsule")));
  });
  it("EN and ES phrasings of the same intent agree", () => {
    expect(routeText("what is the status of the build?").target).toBe(routeText("¿qué estado tiene el build?").target);
  });
});

describe("A3 abstention", () => {
  it.each(["bake a cake for grandma", "hornea un pastel para la abuela", "asdf qwer zxcv", "", "   "])("%j never OK", (t) => {
    const d = routeText(t);
    expect(["ABSTAIN", "NO_MATCH"]).toContain(d.status);
    expect(d.target).toBe("inbox");
    expect(d.reason).toBeDefined();
  });
  it("two-rule tie gives ABSTAIN/low_margin", () => {
    const d = routeText(TIE_TEXT, TIE_TABLE);
    expect(d.status).toBe("ABSTAIN");
    expect(d.reason).toBe("low_margin");
    expect(d.target).toBe("inbox");
    expect(d.marginPpm).toBeLessThan(MIN_MARGIN_PPM);
  });
  it("near-tie (top-2 scores too close) also abstains", () => {
    const near: RouteTable = table([
      rule("n.a", "status_query", ["deploy", "release", "pipeline"]),
      rule("n.b", "handoff", ["deploy", "release", "pipeline", "rollback"]),
    ]);
    const d = routeText(TIE_TEXT, near);
    expect(d.marginPpm).toBeLessThan(MIN_MARGIN_PPM);
    expect(d.status).toBe("ABSTAIN");
    expect(d.reason).toBe("low_margin");
  });
  it("tie order does not matter", () => {
    const rev: RouteTable = { ...TIE_TABLE, rules: [...TIE_TABLE.rules].reverse() };
    expect(j(routeText(TIE_TEXT, rev))).toBe(j(routeText(TIE_TEXT, TIE_TABLE)));
  });
  it("a clear winner is accepted (control for the tie)", () => {
    const d = routeText("status progress estado", CLEAR_TABLE);
    expect([d.status, d.target, d.ruleId, d.stage]).toEqual(["OK", "status_query", "c.status", "lexical"]);
    expect(d.marginPpm).toBeGreaterThanOrEqual(MIN_MARGIN_PPM);
    expect(d.coveragePpm).toBeGreaterThanOrEqual(MIN_COVERAGE_PPM);
  });
  it("low coverage abstains with low_coverage", () => {
    const d = routeText("status " + "zeta ".repeat(20), CLEAR_TABLE);
    expect(d.status).not.toBe("OK");
    expect(d.coveragePpm).toBeLessThan(MIN_COVERAGE_PPM);
    expect(["low_coverage", "low_margin"]).toContain(d.reason);
  });
  it("text without any known term reports no_terms", () => {
    const d = routeText("zzz qqq", CLEAR_TABLE);
    expect(d.status).toBe("NO_MATCH");
    expect(d.reason).toBe("no_terms");
  });
  it("matched lists only tokens present in the text", () => {
    const d = routeText("status progress estado", CLEAR_TABLE);
    for (const m of d.matched) expect(tokenize("status progress estado")).toContain(m);
  });
});

describe("A4 determinism", () => {
  it("1000 calls are byte-identical", () => {
    const first = j(routeText("¿Cómo va el estado del proyecto?"));
    for (let i = 0; i < 1000; i++) expect(j(routeText("¿Cómo va el estado del proyecto?"))).toBe(first);
  });
  it("same event, same decision", () => {
    for (const e of EVENT_PER_ACT) expect(j(routeEvent(e))).toBe(j(routeEvent(structuredClone(e))));
  });
  it("shuffled rule order gives the same decision", () => {
    const texts = ["status progress estado", "handoff transfer", "status handoff", ...ANCHORS.map((a) => a.text)];
    const rules = [...ROUTE_TABLE.rules];
    const shuffled = [...rules.slice(3), ...rules.slice(0, 3)].reverse();
    const t2: RouteTable = { ...ROUTE_TABLE, rules: shuffled };
    for (const t of texts) expect(j(routeText(t, t2)), t).toBe(j(routeText(t, ROUTE_TABLE)));
    const t3: RouteTable = { ...CLEAR_TABLE, rules: [...CLEAR_TABLE.rules].reverse() };
    expect(j(routeText("status progress", t3))).toBe(j(routeText("status progress", CLEAR_TABLE)));
  });
  it("does not mutate its inputs", () => {
    const e = ev("question", "hola", { to: "codex" });
    const snap = j(e);
    const tsnap = j(ROUTE_TABLE);
    routeEvent(e);
    routeText("focus the capsule");
    expect(j(e)).toBe(snap);
    expect(j(ROUTE_TABLE)).toBe(tsnap);
  });
});

describe("A5 table identity", () => {
  it("tableHash is sha256 hex, stable, and carried on every decision", () => {
    const h = tableHash(ROUTE_TABLE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(tableHash(ROUTE_TABLE)).toBe(h);
    expect(routeText("zzz").tableHash).toBe(h);
    expect(routeText("focus the capsule").tableHash).toBe(h);
    expect(routeEvent(ev("question", "x", { to: "a" })).tableHash).toBe(h);
    expect(routeText("zzz", CLEAR_TABLE).tableHash).toBe(tableHash(CLEAR_TABLE));
  });
  it("canonical: key order does not matter", () => {
    const a: RouteTable = { version: 1, rules: [{ id: "x", target: "handoff", terms: ["a"] }], bilingual: { b: "c", d: "e" } };
    const b = { bilingual: { d: "e", b: "c" }, rules: [{ terms: ["a"], target: "handoff", id: "x" }], version: 1 } as RouteTable;
    expect(tableHash(a)).toBe(tableHash(b));
  });
  it("mutating one term changes the hash", () => {
    const base = tableHash(CLEAR_TABLE);
    const first = CLEAR_TABLE.rules[0]!;
    const mutated: RouteTable = { ...CLEAR_TABLE, rules: [{ ...first, terms: ["status", "progress", "estadO"] }, ...CLEAR_TABLE.rules.slice(1)] };
    expect(tableHash(mutated)).not.toBe(base);
    expect(tableHash({ ...CLEAR_TABLE, version: 2 })).not.toBe(base);
    expect(tableHash({ ...CLEAR_TABLE, bilingual: { a: "b" } })).not.toBe(base);
  });
  it("validateTable accepts a good table", () => {
    expect(validateTable(CLEAR_TABLE)).toEqual([]);
    expect(validateTable(TIE_TABLE)).toEqual([]);
  });
  it("rejects duplicate ids", () => {
    const t = table([rule("d", "handoff", ["a"]), rule("d", "escalate", ["b"])]);
    expect(validateTable(t).length).toBeGreaterThan(0);
  });
  it("rejects unknown targets", () => {
    const t = table([{ id: "u", target: "launch_missiles" as never, terms: ["a"] }]);
    expect(validateTable(t).length).toBeGreaterThan(0);
  });
  it("rejects empty terms (empty list and empty/blank string)", () => {
    expect(validateTable(table([rule("e1", "handoff", [])])).length).toBeGreaterThan(0);
    expect(validateTable(table([rule("e2", "handoff", ["a", ""])])).length).toBeGreaterThan(0);
    expect(validateTable(table([rule("e3", "handoff", ["  "])])).length).toBeGreaterThan(0);
  });
  it("rejects an empty id", () => {
    expect(validateTable(table([rule("", "handoff", ["a"])])).length).toBeGreaterThan(0);
  });
  it("never throws on odd tables", () => {
    expect(() => validateTable({ version: 1, rules: [], bilingual: {} })).not.toThrow();
    expect(() => validateTable({} as RouteTable)).not.toThrow();
  });
});

describe("A9 golden set", () => {
  const rows = loadGolden();
  const main = rows.filter((r) => r.slice === "main");
  const control = rows.filter((r) => r.slice === "control");
  const decide = (r: (typeof rows)[number]): RouteDecision => routeEvent(ev(r.act, r.text, r.to !== undefined ? { to: r.to } : {}));

  it("fixture shape: >= 60 rows, ES+EN, >= 10 control rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(control.length).toBeGreaterThanOrEqual(10);
    expect(new Set(rows.map((r) => r.lang))).toEqual(new Set(["es", "en"]));
    expect(rows.some((r) => /[áéíóúñ]/i.test(r.text))).toBe(true);
    for (const t of new Set(main.map((r) => r.expect))) expect([...ROUTE_TARGETS, "abstain"]).toContain(t);
  });
  it("accuracy >= 0.90 on non-abstained main rows; abstain rate <= 0.30 (reported)", () => {
    const decided = main.map((r) => ({ r, d: decide(r) }));
    const answered = decided.filter(({ d }) => d.status === "OK");
    const hits = answered.filter(({ r, d }) => d.target === r.expect).length;
    const abstainRate = 1 - answered.length / main.length;
    console.info(`[u39 A9] main=${main.length} answered=${answered.length} acc=${(hits / Math.max(1, answered.length)).toFixed(3)} abstain=${abstainRate.toFixed(3)}`);
    expect(answered.length).toBeGreaterThan(0);
    expect(hits / answered.length).toBeGreaterThanOrEqual(0.9);
    expect(abstainRate).toBeLessThanOrEqual(0.3);
  });
  it("the off-topic control slice abstains at 100%", () => {
    const bad = control.filter((r) => decide(r).status === "OK").map((r) => r.text);
    expect(bad).toEqual([]);
  });
  it("every golden decision satisfies the shape invariants", () => {
    for (const r of rows) expect(decisionProblems(decide(r)), r.text).toEqual([]);
  });
});

describe("A10 latency", () => {
  it("routeText p95 <= 1 ms over 10,000 calls", () => {
    const texts = [...ANCHORS.map((a) => a.text), "bake a cake for grandma", "x ".repeat(450), "¿puedes revisar el fallo del test?"];
    for (let i = 0; i < 300; i++) routeText(texts[i % texts.length]!);
    const ms: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t0 = performance.now();
      routeText(texts[i % texts.length]!);
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length * 0.95)]!).toBeLessThanOrEqual(1);
  });
});

describe("A11 non-vacuity of the fixtures", () => {
  it("accent pairs differ at byte level (an unfolded tokenizer would split them)", () => {
    for (const [a, b] of ACCENT_PAIRS.slice(0, 4)) expect(a).not.toBe(b);
    expect(ACCENT_PAIRS[0]![0].normalize("NFD")).not.toBe(ACCENT_PAIRS[0]![1].normalize("NFD"));
  });
  it("the tie fixture is a true tie, so MIN_MARGIN_PPM = 0 would turn it into OK", () => {
    const d = routeText(TIE_TEXT, TIE_TABLE);
    expect(d.marginPpm).toBe(0);
    expect(d.status).toBe("ABSTAIN");
    expect(MIN_MARGIN_PPM).toBeGreaterThan(0);
  });
  it("anchors prove stage 1 can answer (a mutant that abstains always fails here)", () => {
    for (const a of ANCHORS) {
      const d = routeText(a.text);
      expect([d.status, d.target], a.text).toEqual(["OK", a.target]);
    }
  });
  it("the off-topic control abstains while anchors answer, so the two slices discriminate", () => {
    const control = loadGolden().filter((r) => r.slice === "control");
    expect(control.every((r) => routeText(r.text).status !== "OK")).toBe(true);
    expect(ANCHORS.every((a) => routeText(a.text).status === "OK")).toBe(true);
  });
});

describe("events of every act", () => {
  it.each(EVENT_PER_ACT.map((e) => [e.act, e] as const))("act=%s yields a well-formed decision", (_a, e) => {
    expect(decisionProblems(routeEvent(e))).toEqual([]);
  });
  it("covers all ten acts", () => {
    expect(new Set(EVENT_PER_ACT.map((e) => e.act))).toEqual(new Set(ACTS));
  });
  it("heartbeat with empty text is never OK from the lexical stage", () => {
    const d = routeEvent(ev("heartbeat", ""));
    expect(d.stage === "lexical" && d.status === "OK").toBe(false);
  });
});

describe("hostile strings never throw", () => {
  it.each(HOSTILE.map((s, i) => [i, s.length > 40 ? s.slice(0, 20) + `...(${s.length})` : s] as const))("#%i %j", (i) => {
    const s = HOSTILE[i]!;
    expect(() => tokenize(s)).not.toThrow();
    const d = routeText(s);
    expect(decisionProblems(d)).toEqual([]);
    for (const act of ACTS) {
      expect(() => routeEvent(ev(act, s, { to: s.slice(0, 64) }))).not.toThrow();
      expect(() => routeEvent(ev(act, s))).not.toThrow();
    }
    expect(j(routeText(s))).toBe(j(d));
  });
  it("malformed events do not throw", () => {
    const weird = [
      { ...ev("question", "x"), text: undefined as unknown as string },
      { ...ev("question", "x"), text: 42 as unknown as string },
      { ...ev("answer", "x"), act: "bogus" as never },
      { ...ev("question", "x"), to: "" },
      { ...ev("question", "x"), to: "__proto__" },
      { ...ev("question", "x"), to: "a".repeat(100_000) },
      {} as never,
    ];
    for (const e of weird) expect(() => routeEvent(e)).not.toThrow();
  });
  it("hostile text does not pollute Object.prototype", () => {
    routeText("__proto__ constructor prototype");
    routeEvent(ev("answer", "@__proto__ @constructor"));
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
  it("hostile `to` is not interpreted as markup or code (agent echoed verbatim or not at all)", () => {
    const d = routeEvent(ev("question", "x", { to: "<script>alert(1)</script>" }));
    expect(["OK", "ABSTAIN", "NO_MATCH", "ERROR"]).toContain(d.status);
    if (d.agent !== undefined) expect(d.agent).toBe("<script>alert(1)</script>");
  });
});

describe("text length cap", () => {
  it("MAX_TEXT bounds the work: a megabyte of text decides quickly", () => {
    const t0 = performance.now();
    routeText("palabra ".repeat(200_000));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
