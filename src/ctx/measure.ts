import type { CtxResp, MeasureOut } from "./types";
import { seal } from "./envelope";
import { validateMeasureIn, sortedErrors } from "./check";

export function measure(i: unknown): CtxResp<MeasureOut> {
  try {
    const errs = validateMeasureIn(i);
    if (errs.length > 0) return seal("measure", 2, { errors: sortedErrors(errs) } as never);
    const text = (i as { text: string }).text;
    return seal("measure", 0, { utf16: text.length, tokens: null, tokens_source: "absent" });
  } catch {
    return seal("measure", 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never);
  }
}
