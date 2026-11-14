import type { CtxResp, DensifyOut } from "./types";
import { seal } from "./envelope";
import { validateDensifyIn, sortedErrors } from "./check";

function removeAnsi(s: string): { out: string; count: number } {
  let out = "";
  let count = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\x1b" && i + 1 < s.length) {
      const nxt = s[i + 1]!;
      if (nxt === "[") {
        let j = i + 2;
        while (j < s.length) {
          const c = s.charCodeAt(j);
          if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) j++;
          else break;
        }
        if (j < s.length) {
          const c = s.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) {
            count++;
            i = j + 1;
            continue;
          }
        }
        out += ch;
        i++;
        continue;
      }
      if (nxt === "]") {
        let j = i + 2;
        let found = -1;
        let termLen = 0;
        while (j < s.length) {
          if (s[j] === "\x07") {
            found = j;
            termLen = 1;
            break;
          }
          if (s[j] === "\x1b" && j + 1 < s.length && s[j + 1] === "\\") {
            found = j;
            termLen = 2;
            break;
          }
          j++;
        }
        if (found >= 0) {
          count++;
          i = found + termLen;
          continue;
        }
        out += ch;
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { out, count };
}

export function densify(i: unknown): CtxResp<DensifyOut> {
  try {
    const errs = validateDensifyIn(i);
    if (errs.length > 0) return seal("densify", 2, { errors: sortedErrors(errs) } as never);
    const text = (i as { text: string }).text;
    const charsIn = text.length;
    const step1 = text.replace(/\r\n/g, "\n");
    const { out: step2, count: ansiRemoved } = removeAnsi(step1);
    const hasTrailing = step2.endsWith("\n");
    const working = hasTrailing ? step2.slice(0, -1) : step2;
    const lines = working.split("\n");
    const blankRe = /^\s*$/;
    let blankRemoved = 0;
    const afterBlank: string[] = [];
    let k = 0;
    while (k < lines.length) {
      if (blankRe.test(lines[k]!)) {
        let j = k;
        while (j < lines.length && blankRe.test(lines[j]!)) j++;
        const runLen = j - k;
        if (runLen > 1) blankRemoved += runLen - 1;
        afterBlank.push("");
        k = j;
      } else {
        afterBlank.push(lines[k]!);
        k++;
      }
    }
    let repeatsRemoved = 0;
    const afterRepeat: string[] = [];
    for (const ln of afterBlank) {
      if (afterRepeat.length > 0 && afterRepeat[afterRepeat.length - 1] === ln) {
        repeatsRemoved++;
      } else afterRepeat.push(ln);
    }
    let joined = afterRepeat.join("\n");
    if (hasTrailing) joined = joined + "\n";
    if (step2 === "" && !hasTrailing) joined = "";
    const out: DensifyOut = {
      text: joined,
      chars_in: charsIn,
      chars_out: joined.length,
      ansi_removed: ansiRemoved,
      blank_removed: blankRemoved,
      repeats_removed: repeatsRemoved,
    };
    return seal("densify", 0, out);
  } catch {
    return seal("densify", 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never);
  }
}
