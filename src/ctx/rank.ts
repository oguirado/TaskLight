import { CTX_LIMITS } from "./limits";
import type { CtxResp, Excerpt, RankOut } from "./types";
import { seal } from "./envelope";
import { validateRankIn, sortedErrors } from "./check";

function tokensOf(text: string): string[] {
  const lower = text.toLowerCase();
  const m = lower.match(/[a-z0-9_]+/g);
  return m ?? [];
}

export function rank(i: unknown): CtxResp<RankOut> {
  try {
    const errs = validateRankIn(i);
    if (errs.length > 0) return seal("rank", 2, { errors: sortedErrors(errs) } as never);
    const input = i as { excerpts: Excerpt[]; terms: string[] };
    const excerpts = input.excerpts;
    const n = excerpts.length;
    if (n === 0) return seal("rank", 0, { order: [], scores: [] });
    const termSet = new Set<string>();
    for (const t of input.terms) termSet.add(t.toLowerCase());
    const terms = [...termSet];
    const docTokens = excerpts.map((e) => tokensOf(e.text));
    const dls = docTokens.map((t) => t.length);
    const total = dls.reduce((a, b) => a + b, 0);
    const avgdl = total / n;
    const k1 = CTX_LIMITS.BM25_K1_MILLI / 1000;
    const bP = CTX_LIMITS.BM25_B_MILLI / 1000;
    const scaled = new Array<number>(n).fill(0);
    if (terms.length > 0 && avgdl > 0) {
      const idfs: number[] = [];
      const tfs: number[][] = terms.map(() => new Array<number>(n).fill(0));
      terms.forEach((term, ti) => {
        let df = 0;
        for (let d = 0; d < n; d++) {
          let tf = 0;
          for (const tok of docTokens[d]!) if (tok === term) tf++;
          tfs[ti]![d] = tf;
          if (tf > 0) df++;
        }
        idfs.push(Math.log(1 + (n - df + 0.5) / (df + 0.5)));
      });
      for (let d = 0; d < n; d++) {
        let score = 0;
        terms.forEach((_term, ti) => {
          const tf = tfs[ti]![d]!;
          if (tf === 0) return;
          const dl = dls[d]!;
          score += idfs[ti]! * (tf * (k1 + 1)) / (tf + k1 * (1 - bP + (bP * dl) / avgdl));
        });
        scaled[d] = Math.round(score * CTX_LIMITS.SCORE_SCALE);
      }
    }
    const idx = Array.from({ length: n }, (_, k) => k);
    idx.sort((a, b2) => {
      const sa = scaled[a]!, sb = scaled[b2]!;
      if (sb !== sa) return sb - sa;
      return a - b2;
    });
    const order = idx;
    const scores = order.map((d) => scaled[d]!);
    return seal("rank", 0, { order, scores });
  } catch {
    return seal("rank", 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never);
  }
}
