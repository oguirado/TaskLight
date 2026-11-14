import type { CtxResp } from "./types";
export type CtxAdmission = "RULES" | "REFUSE_STALE";
export function ctxAdmission(r: CtxResp<unknown>): CtxAdmission {
  if (r === null || typeof r !== "object") return "REFUSE_STALE";
  return r.rc === 0 ? "RULES" : "REFUSE_STALE";
}
