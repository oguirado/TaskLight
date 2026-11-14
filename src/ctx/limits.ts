// ORACLE STUB (U28): constants are the spec values; behaviour elsewhere is wrong on purpose.
export const CTX_LIMITS = {
  PACK_MAX_CHARS: 7300,
  DENSIFY_IN_MAX: 65536,
  EXCERPTS_MAX: 64, EXCERPT_TEXT_MAX: 2000,
  TERMS_MAX: 32, TERM_MAX: 40, SRC_MAX: 256,
  BM25_K1_MILLI: 1200, BM25_B_MILLI: 750, SCORE_SCALE: 1_000_000,
  CHECK_DEPTH_MAX: 8, CTX_TIMEOUT_MS: 2000,
} as const;
export const CTX_RC = { OK: 0, USAGE: 2, STALE: 4, BUDGET: 6, ABSENT: 7, TIMEOUT: 124 } as const;
export type CtxRc = typeof CTX_RC[keyof typeof CTX_RC];
export type CtxVerb = "densify" | "rank" | "pack" | "measure" | "check";
export const CTX_SCHEMA = "ctx.resp/v1" as const;
