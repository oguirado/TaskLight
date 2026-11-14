import type { CtxRc, CtxVerb, CTX_SCHEMA } from "./limits";
export interface Coord { src: string; from: number; to: number; sha256?: string }
export interface Excerpt { coord: Coord; text: string }
export interface DensifyIn { text: string }
export interface DensifyOut { text: string; chars_in: number; chars_out: number;
  ansi_removed: number; blank_removed: number; repeats_removed: number }
export interface RankIn { excerpts: Excerpt[]; terms: string[] }
export interface RankOut { order: number[]; scores: number[] }
export interface PackIn { excerpts: Excerpt[]; maxChars: number; expect?: Record<string, string> }
export interface PackBlock { coord: Coord; text: string }
export interface ContextPack { blocks: PackBlock[]; dropped: number; total_chars: number; pack_hash: string }
export interface MeasureIn { text: string }
export interface MeasureOut { utf16: number; tokens: number | null; tokens_source: "absent" }
export type CtxKind = "envelope" | "densify.in" | "rank.in" | "pack.in" | "measure.in";
export interface CheckIn { kind: CtxKind; value: unknown }
export interface CtxError { code: "UNKNOWN_FIELD" | "MISSING_FIELD" | "WRONG_TYPE" | "BAD_NUMBER"
  | "BOOL_AS_INT" | "TOO_LONG" | "TOO_MANY" | "TOO_DEEP" | "BAD_COORD" | "SHA_MISMATCH"; path: string }
export interface CtxResp<T> { schema: typeof CTX_SCHEMA; ok: boolean; rc: CtxRc; verb: CtxVerb;
  data: T | { errors: CtxError[] }; sha256: string }
