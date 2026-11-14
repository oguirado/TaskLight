import { CTX_SCHEMA, type CtxRc, type CtxVerb } from "./limits";
import type { CtxResp } from "./types";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./sha256";

export function seal<T>(verb: CtxVerb, rc: CtxRc, data: CtxResp<T>["data"]): CtxResp<T> {
  return { schema: CTX_SCHEMA, ok: rc === 0, rc, verb, data, sha256: sha256Hex(canonicalJson(data)) };
}
