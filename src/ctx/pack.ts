import type { ContextPack, CtxResp, Excerpt, PackBlock } from "./types";
import { seal } from "./envelope";
import { sha256Hex } from "./sha256";
import { validatePackIn, sortedErrors } from "./check";

export function renderPack(p: ContextPack): string {
  return p.blocks.map((b) => `@@ ${b.coord.src}:${b.coord.from}-${b.coord.to}\n${b.text}\n`).join("");
}

export function pack(i: unknown): CtxResp<ContextPack> {
  try {
    const errs = validatePackIn(i);
    if (errs.length > 0) return seal("pack", 2, { errors: sortedErrors(errs) } as never);
    const input = i as { excerpts: Excerpt[]; maxChars: number; expect?: Record<string, string> };
    const excerpts = input.excerpts;
    const maxChars = input.maxChars;
    const expectMap = input.expect;
    if (expectMap !== undefined && expectMap !== null) {
      const stale: { code: "SHA_MISMATCH"; path: string }[] = [];
      excerpts.forEach((e, idx) => {
        if (Object.prototype.hasOwnProperty.call(expectMap, e.coord.src)) {
          const expected = expectMap[e.coord.src];
          if (expected !== e.coord.sha256) {
            stale.push({ code: "SHA_MISMATCH", path: "excerpts[" + idx + "].coord.sha256" });
          }
        }
      });
      if (stale.length > 0) {
        return seal("pack", 4, { errors: stale } as never);
      }
    }
    const blocks: PackBlock[] = [];
    let dropped = 0;
    let total = 0;
    for (const e of excerpts) {
      const blockLen = ("@@ " + e.coord.src + ":" + e.coord.from + "-" + e.coord.to + "\n" + e.text + "\n").length;
      if (total + blockLen <= maxChars) {
        const coord = e.coord.sha256 === undefined
          ? { src: e.coord.src, from: e.coord.from, to: e.coord.to }
          : { src: e.coord.src, from: e.coord.from, to: e.coord.to, sha256: e.coord.sha256 };
        blocks.push({ coord, text: e.text });
        total += blockLen;
      } else {
        dropped++;
      }
    }
    if (excerpts.length > 0 && blocks.length === 0) {
      const empty: ContextPack = { blocks: [], dropped: excerpts.length, total_chars: 0, pack_hash: sha256Hex("") };
      return seal("pack", 6, empty);
    }
    const p: ContextPack = { blocks, dropped, total_chars: total, pack_hash: sha256Hex(renderPack({ blocks, dropped, total_chars: total, pack_hash: "" })) };
    return seal("pack", 0, p);
  } catch {
    return seal("pack", 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never);
  }
}
